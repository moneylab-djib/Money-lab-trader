/**
 * Sonni first slice (docs/FIRST-SLICE.md): one test group per acceptance
 * criterion. Fully mocked: global fetch fails the test on any request,
 * Kraken is a fake fetch passed in explicitly, and inference is the
 * MockInferenceClient. No network, no paid inference.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

vi.mock("../../conway/x402.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../conway/x402.js")>();
  return { ...actual, getUsdcBalance: vi.fn(async () => 0) };
});

import { createDatabase } from "../../state/database.js";
import { runAgentLoop } from "../../agent/loop.js";
import { createBuiltinTools, executeTool } from "../../agent/tools.js";
import { PolicyEngine } from "../../agent/policy-engine.js";
import { SpendTracker } from "../../agent/spend-tracker.js";
import { createDefaultRules } from "../../agent/policy-rules/index.js";
import { applyMoneyLabProfile } from "../../money-lab/profile.js";
import { ensureMoneyLabSchema, journalFingerprint, setKV } from "../../money-lab/journal.js";
import { REVIEW_KEY } from "../../money-lab/review.js";
import { createMoneyLabTools } from "../../money-lab/tools.js";
import { TelegramChannel } from "../../money-lab/telegram.js";
import { splitVolatileSystem } from "../../conway/inference.js";
import type { AutomatonConfig, AutomatonDatabase, ToolContext } from "../../types.js";
import {
  applyTraderProfile,
  parseTraderConfig,
  SONNI_DENIED_TOOLS,
  TraderConfigError,
  type TraderConfig,
} from "../../trader/config.js";
import { ensureTraderSchema } from "../../trader/schema.js";
import { collectPrices, isoSeconds, latestPrice } from "../../trader/prices.js";
import { addHypothesis, computeConfidence, getHypothesis, MIN_INSTANCES } from "../../trader/hypotheses.js";
import { getPrediction, recordPrediction, resolveDuePredictions, type PredictionInput } from "../../trader/predictions.js";
import { collectTick } from "../../trader/runtime.js";
import { createTraderTools } from "../../trader/tools.js";
import { buildMemoryPack } from "../../trader/pack.js";
import { runSonniCommand } from "../../trader/cli.js";
import {
  MockConwayClient,
  MockInferenceClient,
  createTestConfig,
  createTestIdentity,
  toolCallResponse,
} from "../mocks.js";

const EXAMPLE = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "..", "..", "sonni", "automaton.sonni.example.json"), "utf-8"),
);
const TRADER: TraderConfig = parseTraderConfig(EXAMPLE.trader)!;
const T0 = new Date("2026-10-07T08:00:00Z");
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

/** Example profile, on the conway runtime so the agent loop needs no VPS environment. */
function sonniConfig(): AutomatonConfig {
  const moneyLab = { ...EXAMPLE.moneyLab, runtime: "conway", telegram: null, inference: { ...EXAMPLE.moneyLab.inference, model: "gpt-5-mini" } };
  return applyTraderProfile(applyMoneyLabProfile(
    createTestConfig({ moneyLab, trader: EXAMPLE.trader, logLevel: "error" } as any),
  ));
}

let tmpDirs: string[] = [];
function dbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sonni-test-"));
  tmpDirs.push(dir);
  return path.join(dir, "state.db");
}
function openDb(file = dbPath()): AutomatonDatabase {
  const db = createDatabase(file);
  ensureMoneyLabSchema(db.raw);
  ensureTraderSchema(db.raw);
  return db;
}

/** Fake Kraken Ticker endpoint: one answer per pair, Kraken-style result keys. */
function fakeKraken(prices: Record<string, number | Error>) {
  return vi.fn(async (url: string) => {
    const pair = new URL(url).searchParams.get("pair")!;
    const price = prices[pair];
    if (price instanceof Error) throw price;
    if (price === undefined) return new Response(JSON.stringify({ error: ["EQuery:Unknown asset pair"] }), { status: 200 });
    return new Response(JSON.stringify({ error: [], result: { [`X${pair}Z`]: { c: [String(price), "0.1"] } } }), { status: 200 });
  }) as unknown as typeof fetch;
}

function storePrice(db: AutomatonDatabase, asset: string, at: Date, price: number) {
  db.raw.prepare("INSERT INTO trader_prices (asset, ts, price, source) VALUES (?, ?, ?, 'test')").run(asset, isoSeconds(at), price);
}

function input(hypothesisId: string, overrides: Partial<PredictionInput> = {}): PredictionInput {
  return {
    asset: "BTC", direction: "above", threshold: 60_000, horizonHours: 24, probability: 0.6, hypothesisId,
    statement: "BTC above 60,000 EUR in 24 h", rationale: "Momentum after the weekly close", ...overrides,
  };
}

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn(async () => {
    throw new Error("Network access attempted in a mocked Sonni test");
  });
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

// ─── Configuration ──────────────────────────────────────────────

describe("Sonni configuration", () => {
  it("accepts the example block: BTC and ETH every 5 minutes, stale after 15", () => {
    expect(TRADER.assets.map((a) => a.symbol)).toEqual(["BTC", "ETH"]);
    expect(TRADER.collectMinutes).toBe(5);
    expect(TRADER.staleMinutes).toBe(15);
  });

  it("is absent when the block is missing, and strict otherwise", () => {
    expect(parseTraderConfig(undefined)).toBeNull();
    expect(() => parseTraderConfig({ ...EXAMPLE.trader, extra: 1 })).toThrow(TraderConfigError);
    expect(() => parseTraderConfig({ ...EXAMPLE.trader, staleMinutes: 5 })).toThrow(/staleMinutes/);
    expect(() => parseTraderConfig({ ...EXAMPLE.trader, assets: [] })).toThrow(/assets/);
    expect(() => parseTraderConfig({
      ...EXAMPLE.trader, assets: [{ symbol: "BTC", krakenPair: "XBTEUR" }, { symbol: "BTC", krakenPair: "XBTUSD" }],
    })).toThrow(/double/);
  });

  it("needs the Money Lab runtime", () => {
    expect(() => applyTraderProfile({ trader: EXAMPLE.trader })).toThrow(/moneyLab/);
    expect(sonniConfig().trader?.enabled).toBe(true);
  });
});

// ─── Criterion 1: prices every 5 minutes, surviving a restart ───

describe("Criterion 1: price collection", () => {
  it("stores one Kraken price per asset per collection, and they survive a reopened database", async () => {
    const file = dbPath();
    const db = openDb(file);
    const kraken = fakeKraken({ XBTEUR: 61_234.5, ETHEUR: 2_345.6 });
    await collectPrices(db.raw, TRADER, kraken, T0);
    await collectPrices(db.raw, TRADER, kraken, minutes(TRADER.collectMinutes));
    expect(kraken).toHaveBeenCalledTimes(4);
    expect((kraken as any).mock.calls[0][0]).toContain("pair=XBTEUR");
    db.close();

    const reopened = openDb(file);
    const btc = latestPrice(reopened.raw, "BTC")!;
    expect(btc.price).toBe(61_234.5);
    expect(btc.ts).toBe(isoSeconds(minutes(5)));
    const rows = reopened.raw.prepare("SELECT COUNT(*) AS n FROM trader_prices").get() as any;
    expect(rows.n).toBe(4);
    reopened.close();
  });

  it("keeps the prices that arrived when one asset fails, and reports the failure", async () => {
    const db = openDb();
    const kraken = fakeKraken({ XBTEUR: 61_000, ETHEUR: new Error("timeout") });
    await expect(collectTick(db.raw, TRADER, kraken)).rejects.toThrow(/timeout/);
    expect(latestPrice(db.raw, "BTC")?.price).toBe(61_000);
    expect(latestPrice(db.raw, "ETH")).toBeUndefined();
    db.close();
  });

  it("rejects an invalid Kraken answer", async () => {
    const db = openDb();
    const result = await collectPrices(db.raw, TRADER, fakeKraken({ XBTEUR: -1, ETHEUR: 2_000 }), T0);
    expect(result.stored).toBe(1);
    expect(result.errors.join()).toMatch(/invalid price/);
    db.close();
  });
});

// ─── Criterion 2: no decision on stale prices ───────────────────

describe("Criterion 2: stale prices", () => {
  it("refuses a prediction when the latest price is older than 15 minutes, accepts it when fresh", () => {
    const db = openDb();
    const h = addHypothesis(db.raw, { statement: "BTC tends to hold its level after a calm weekend", origin: "owner" });
    storePrice(db, "BTC", T0, 60_500);
    const stale = recordPrediction(db.raw, TRADER, input(h.id), minutes(16));
    expect(stale.ok).toBe(false);
    expect(!stale.ok && stale.error).toMatch(/16 minutes old.*stale/);
    const fresh = recordPrediction(db.raw, TRADER, input(h.id), minutes(10));
    expect(fresh.ok).toBe(true);
    db.close();
  });

  it("flags stale prices in the memory pack", () => {
    const db = openDb();
    storePrice(db, "BTC", T0, 60_500);
    expect(buildMemoryPack(db.raw, TRADER, minutes(30))).toMatch(/BTC: 60500\.00 EUR .*STALE/);
    db.close();
  });
});

// ─── Criterion 3: complete predictions only ─────────────────────

describe("Criterion 3: prediction validation", () => {
  it("requires probability, condition, horizon and an existing hypothesis", () => {
    const db = openDb();
    const h = addHypothesis(db.raw, { statement: "ETH follows BTC within a day", origin: "owner" });
    storePrice(db, "BTC", T0, 60_500);
    const at = minutes(1);
    const refused = (o: Partial<PredictionInput>) => recordPrediction(db.raw, TRADER, input(h.id, o), at);
    expect(refused({ probability: 1.2 }).ok).toBe(false);
    expect(refused({ probability: Number.NaN }).ok).toBe(false);
    expect(refused({ direction: "sideways" }).ok).toBe(false);
    expect(refused({ threshold: 0 }).ok).toBe(false);
    expect(refused({ horizonHours: 0.5 }).ok).toBe(false);
    expect(refused({ hypothesisId: "h_missing" }).ok).toBe(false);
    expect(refused({ asset: "DOGE" }).ok).toBe(false);
    expect(refused({ statement: " " }).ok).toBe(false);
    expect(refused({ rationale: "" }).ok).toBe(false);
    const ok = refused({});
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.prediction.referencePrice).toBe(60_500);
      expect(ok.prediction.horizonUntil).toBe(isoSeconds(new Date(at.getTime() + 24 * 3_600_000)));
    }
    db.close();
  });
});

// ─── Criterion 4: append-only ───────────────────────────────────

describe("Criterion 4: predictions are append-only", () => {
  it("offers the agent no tool to change a prediction", () => {
    expect(createTraderTools().map((t) => t.name)).toEqual(["sonni_memory", "record_prediction"]);
  });

  it("refuses updates and deletes at the database level, except the single resolution by code", () => {
    const db = openDb();
    const h = addHypothesis(db.raw, { statement: "BTC rarely moves 5 % in a quiet hour", origin: "owner" });
    storePrice(db, "BTC", T0, 60_000);
    const rec = recordPrediction(db.raw, TRADER, input(h.id, { horizonHours: 1 }), T0);
    if (!rec.ok) throw new Error(rec.error);
    const id = rec.prediction.id;
    expect(() => db.raw.prepare("UPDATE trader_predictions SET probability = 0.99 WHERE id = ?").run(id)).toThrow(/append-only/);
    expect(() => db.raw.prepare("DELETE FROM trader_predictions WHERE id = ?").run(id)).toThrow(/append-only/);

    storePrice(db, "BTC", minutes(61), 60_100);
    resolveDuePredictions(db.raw, TRADER, minutes(62));
    expect(getPrediction(db.raw, id)?.resolvedAt).not.toBeNull();
    expect(() => db.raw.prepare("UPDATE trader_predictions SET outcome = 0, brier = 0 WHERE id = ?").run(id)).toThrow(/append-only/);
    expect(() => db.raw.prepare("DELETE FROM trader_hypothesis_evidence").run()).toThrow(/append-only/);
    db.close();
  });
});

// ─── Criteria 5 and 6: resolution by code, evidence ─────────────

describe("Criteria 5 and 6: resolution", () => {
  it("resolves at the horizon from the first stored price, scores Brier and adds evidence", () => {
    const db = openDb();
    const h = addHypothesis(db.raw, { statement: "BTC holds above 60,000 EUR this week", origin: "owner" });
    storePrice(db, "BTC", T0, 60_500);
    const yes = recordPrediction(db.raw, TRADER, input(h.id, { horizonHours: 1, probability: 0.7 }), T0);
    const no = recordPrediction(db.raw, TRADER, input(h.id, { horizonHours: 1, probability: 0.8, threshold: 62_000 }), T0);
    if (!yes.ok || !no.ok) throw new Error("setup");

    // Not before the horizon.
    expect(resolveDuePredictions(db.raw, TRADER, minutes(59))).toHaveLength(0);

    storePrice(db, "BTC", minutes(58), 70_000); // before the horizon: must be ignored
    storePrice(db, "BTC", minutes(61), 61_000);
    storePrice(db, "BTC", minutes(66), 59_000);
    expect(resolveDuePredictions(db.raw, TRADER, minutes(70))).toHaveLength(2);

    const a = getPrediction(db.raw, yes.prediction.id)!;
    expect(a.outcome).toBe(1);
    expect(a.resolutionPrice).toBe(61_000);
    expect(a.brier).toBeCloseTo(0.09, 10);
    const b = getPrediction(db.raw, no.prediction.id)!;
    expect(b.outcome).toBe(0);
    expect(b.brier).toBeCloseTo(0.64, 10);

    const after = getHypothesis(db.raw, h.id)!;
    expect(after.supports).toBe(1);
    expect(after.contradicts).toBe(1);
    expect(after.confidence).toBeCloseTo(0.5, 10);
    expect(after.status).toBe("testing");
    // Idempotent: nothing is resolved twice.
    expect(resolveDuePredictions(db.raw, TRADER, minutes(80))).toHaveLength(0);
    db.close();
  });

  it("voids a prediction when no price exists in the window after the horizon", () => {
    const db = openDb();
    const h = addHypothesis(db.raw, { statement: "ETH reacts to BTC moves within the hour", origin: "owner" });
    storePrice(db, "ETH", T0, 2_400);
    const rec = recordPrediction(db.raw, TRADER, input(h.id, { asset: "ETH", threshold: 2_300, horizonHours: 1 }), T0);
    if (!rec.ok) throw new Error(rec.error);
    expect(resolveDuePredictions(db.raw, TRADER, minutes(70))).toHaveLength(0); // window still open
    storePrice(db, "ETH", minutes(90), 2_500); // too late to judge the 1 h horizon
    expect(resolveDuePredictions(db.raw, TRADER, minutes(91))).toHaveLength(1);
    const p = getPrediction(db.raw, rec.prediction.id)!;
    expect(p.voidReason).toMatch(/no ETH price/);
    expect(p.brier).toBeNull();
    expect(getHypothesis(db.raw, h.id)!.status).toBe("untested");
    db.close();
  });

  it("computes confidence and status from counts only", () => {
    expect(computeConfidence(0, 0)).toEqual({ confidence: 0.5, status: "untested" });
    expect(computeConfidence(3, 0).status).toBe("testing");
    expect(computeConfidence(MIN_INSTANCES, 0).status).toBe("supported");
    expect(computeConfidence(0, MIN_INSTANCES).status).toBe("refuted");
    expect(computeConfidence(4, 4).status).toBe("testing");
  });
});

// ─── Criterion 7: /statut in French ─────────────────────────────

describe("Criterion 7: owner status on Telegram", () => {
  it("shows prices, open and resolved predictions and hypotheses in French; /idee adds a hypothesis", async () => {
    const db = openDb();
    const config = { ...sonniConfig(), name: "sonni" };
    const channel = new TelegramChannel("token", 42, db, config, fetchSpy as any);

    expect(channel.handleOwnerText("/idee BTC monte souvent après une baisse de plus de 5 % en une journée", 1))
      .toMatch(/Intuition h_\w+ ajoutée/);
    const h = (db.raw.prepare("SELECT id FROM trader_hypotheses").get() as any).id;
    storePrice(db, "BTC", T0, 60_500);
    const now = new Date();
    storePrice(db, "BTC", now, 61_000);
    const open = recordPrediction(db.raw, TRADER, input(h, { horizonHours: 48 }), now);
    const done = recordPrediction(db.raw, TRADER, input(h, { horizonHours: 1, threshold: 60_000 }), now);
    if (!open.ok || !done.ok) throw new Error("setup");
    storePrice(db, "BTC", new Date(now.getTime() + 61 * 60_000), 60_800);
    resolveDuePredictions(db.raw, TRADER, new Date(now.getTime() + 62 * 60_000));

    const text = channel.handleOwnerText("/statut", 2)!;
    expect(text).toContain("SONNI");
    expect(text).toMatch(/Prédictions ouvertes \(1\)/);
    expect(text).toMatch(/BTC au-dessus de 60\s?000,00 € : VRAI/);
    expect(text).toMatch(/score de Brier moyen : 0\.160 sur 1/);
    expect(text).toMatch(/\[en test\] BTC monte souvent/);
    expect(text).toContain("BUDGET ET RUNTIME");
    expect(channel.handleOwnerText("/aide", 3)).toContain("/idee");
    expect(fetchSpy).not.toHaveBeenCalled();
    db.close();
  });

  it("offers the same commands on the CLI", () => {
    const db = openDb();
    const out: string[] = [];
    expect(runSonniCommand(["idee", "ETH", "suit", "BTC", "avec", "un", "jour", "de", "retard"], db.raw, TRADER, (t) => out.push(t))).toBe(0);
    expect(runSonniCommand(["intuitions"], db.raw, TRADER, (t) => out.push(t))).toBe(0);
    expect(out.join("\n")).toMatch(/ETH suit BTC avec un jour de retard/);
    expect(runSonniCommand(["idee"], db.raw, TRADER, (t) => out.push(t))).toBe(1);
    db.close();
  });
});

// ─── Decision session through the real agent loop ───────────────

describe("Decision session (agent loop with mocked inference)", () => {
  it("reads memory, records a prediction through policy, counts it as progress; Money Lab tools are gone", async () => {
    const db = openDb();
    const config = sonniConfig();
    const h = addHypothesis(db.raw, { statement: "BTC rarely loses 3 % within a day after a calm week", origin: "owner" });
    storePrice(db, "BTC", new Date(), 60_500);
    const before = journalFingerprint(db.raw);
    const inference = new MockInferenceClient([
      toolCallResponse([{ name: "sonni_memory", arguments: {} }]),
      toolCallResponse([{ name: "record_prediction", arguments: {
        asset: "BTC", direction: "above", threshold: 58_700, horizon_hours: 24, probability: 0.8,
        hypothesis_id: h.id, statement: "BTC stays above 58,700 EUR tomorrow", rationale: "Calm week, no event scheduled",
      } }]),
      toolCallResponse([{ name: "record_experiment", arguments: { status: "exploring" } }]),
      toolCallResponse([{ name: "sleep", arguments: { duration_seconds: 3600, reason: "next session" } }]),
    ]);
    const turns: any[] = [];
    await runAgentLoop({
      identity: createTestIdentity(), config, db, conway: new MockConwayClient(), inference,
      policyEngine: new PolicyEngine(db.raw, createDefaultRules()), spendTracker: new SpendTracker(db.raw),
      onTurnComplete: (t) => turns.push(t),
    });

    const system = String(inference.calls[0].messages[0].content);
    expect(system).toContain("## Sonni Mission");
    expect(system).not.toContain("## Money Lab Mission");
    // The stable mission is cached; the rules block (date, counts) goes after it as live state.
    const split = splitVolatileSystem(system, "claude-sonnet-5-5", [{ role: "user", content: "wake" }])!;
    expect(split).not.toBeNull();
    expect(split.volatile.startsWith("--- SONNI RULES")).toBe(true);
    expect(split.system.map((b) => String(b.text)).join("")).toContain("## Sonni Mission");
    const toolNames = (inference.calls[0].options?.tools ?? []).map((t: any) => t.function?.name);
    expect(toolNames).toContain("record_prediction");
    for (const name of SONNI_DENIED_TOOLS) expect(toolNames).not.toContain(name);

    const calls = turns.flatMap((t) => t.toolCalls);
    expect(calls[0].result).toContain("MEMORY PACK");
    expect(calls[1].error).toBeUndefined();
    expect(calls[1].result).toMatch(/Prediction p_\w+ recorded/);
    expect(String(calls[2].error ?? calls[2].result)).toMatch(/not found|Unknown tool|SONNI_TOOL_DISABLED/i);
    expect((db.raw.prepare("SELECT COUNT(*) AS n FROM trader_predictions").get() as any).n).toBe(1);
    expect(journalFingerprint(db.raw)).not.toBe(before);
    db.close();
  });

  it("does not cap Sonni's sleep with Money Lab's idea-discovery rule", async () => {
    const db = openDb();
    const inference = new MockInferenceClient([
      toolCallResponse([{ name: "sleep", arguments: { duration_seconds: 4 * 3600, reason: "next session" } }]),
    ]);
    const turns: any[] = [];
    await runAgentLoop({
      identity: createTestIdentity(), config: sonniConfig(), db, conway: new MockConwayClient(), inference,
      policyEngine: new PolicyEngine(db.raw, createDefaultRules()), spendTracker: new SpendTracker(db.raw),
      onTurnComplete: (t) => turns.push(t),
    });
    const result = String(turns.flatMap((t) => t.toolCalls)[0].result);
    expect(result).toContain("Entering sleep mode for 14400s");
    expect(result).not.toMatch(/idea pipeline|discovery/);
    db.close();
  });

  it("gives Sonni its own weekly review, not Money Lab's experiment review", async () => {
    const db = openDb();
    setKV(db.raw, REVIEW_KEY, new Date(Date.now() - 8 * 24 * 3_600_000).toISOString());
    const inference = new MockInferenceClient([
      toolCallResponse([{ name: "sleep", arguments: { duration_seconds: 3600, reason: "review done" } }]),
    ]);
    await runAgentLoop({
      identity: createTestIdentity(), config: sonniConfig(), db, conway: new MockConwayClient(), inference,
      policyEngine: new PolicyEngine(db.raw, createDefaultRules()), spendTracker: new SpendTracker(db.raw),
    });
    const sent = JSON.stringify(inference.calls[0].messages);
    expect(sent).toContain("SONNI WEEKLY REVIEW");
    expect(sent).not.toContain("record_experiment");
    db.close();
  });

  it("denies Money Lab's web-business tools by policy too", async () => {
    const db = openDb();
    const ctx: ToolContext = {
      identity: createTestIdentity(), config: sonniConfig(), db, conway: new MockConwayClient(), inference: new MockInferenceClient(),
    };
    const tools = [...createBuiltinTools(ctx.identity.sandboxId), ...createMoneyLabTools(), ...createTraderTools()];
    const engine = new PolicyEngine(db.raw, createDefaultRules());
    const turn = { inputSource: "agent" as const, turnToolCallCount: 0, sessionSpend: new SpendTracker(db.raw) };
    const denied = await executeTool("record_experiment", { status: "exploring" }, tools, ctx, engine, turn);
    expect(denied.error).toMatch(/SONNI_TOOL_DISABLED/);
    const allowed = await executeTool("sonni_memory", {}, tools, ctx, engine, turn);
    expect(allowed.error).toBeUndefined();
    db.close();
  });
});
