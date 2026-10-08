/**
 * Sonni step 1, "Sonni already knows things" (docs/PLAN.fr.md): daily
 * history, test rules evaluated by code, the propose_hypothesis tool and
 * the intake session. Fully mocked: no network, no paid inference.
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
import { PolicyEngine } from "../../agent/policy-engine.js";
import { SpendTracker } from "../../agent/spend-tracker.js";
import { createDefaultRules } from "../../agent/policy-rules/index.js";
import { applyMoneyLabProfile } from "../../money-lab/profile.js";
import { addLedgerEntry, ensureMoneyLabSchema } from "../../money-lab/journal.js";
import { TelegramChannel } from "../../money-lab/telegram.js";
import type { AutomatonConfig, AutomatonDatabase, ToolContext } from "../../types.js";
import { applyTraderProfile, parseTraderConfig, type TraderConfig } from "../../trader/config.js";
import { ensureTraderSchema } from "../../trader/schema.js";
import { collectCandles, loadDaily, type Candle } from "../../trader/candles.js";
import { evaluateRule, parseTestRule, type TestRule } from "../../trader/rules.js";
import { addHypothesis, getHypothesis } from "../../trader/hypotheses.js";
import { latestHistoricalTest, runAllHistoricalTests, runHistoricalTest } from "../../trader/historical.js";
import { INTAKE_MIN_PRIOR, intakeAttempts, intakeDue, MAX_MODEL_HYPOTHESES_PER_DAY, startIntake, closeIntakeWake } from "../../trader/intake.js";
import { createTraderTools } from "../../trader/tools.js";
import { buildMemoryPack } from "../../trader/pack.js";
import { historyTick } from "../../trader/runtime.js";
import { MockConwayClient, MockInferenceClient, createTestConfig, createTestIdentity, noToolResponse, toolCallResponse } from "../mocks.js";

const EXAMPLE = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "..", "..", "sonni", "automaton.sonni.example.json"), "utf-8"),
);
/** These tests exercise BTC and ETH; the owner's other core assets (gold, USD, tokenized stocks) are covered in universe.test. */
EXAMPLE.trader.assets = EXAMPLE.trader.assets.filter((a: { symbol: string }) => a.symbol === "BTC" || a.symbol === "ETH");
const TRADER: TraderConfig = parseTraderConfig(EXAMPLE.trader)!;
const ASSETS = ["BTC", "ETH"];

/** Self-hosted profile so the stronger model is registered, as on the VPS. */
function sonniVpsConfig(): AutomatonConfig {
  return applyTraderProfile(applyMoneyLabProfile(
    createTestConfig({ moneyLab: EXAMPLE.moneyLab, trader: EXAMPLE.trader, sandboxId: "", logLevel: "error" } as any),
  ));
}

let tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
function openDb(file = path.join(tmp("sonni-knowledge-"), "state.db")): AutomatonDatabase {
  const db = createDatabase(file);
  ensureMoneyLabSchema(db.raw);
  ensureTraderSchema(db.raw);
  return db;
}

/**
 * Synthetic daily history: daily returns repeat the cycle
 * [+1 %, -1 %, +1 %, -4 %, +5 %]; volume spikes on the -4 % days.
 * After a -4 % day the next day is always +5 %; on all days, 3 in 5 are up.
 */
function cycleCandles(days: number, start = "2024-01-01", scale = 1): Candle[] {
  const cycle = [1, -1, 1, -4, 5];
  const out: Candle[] = [];
  let close = 100 * scale;
  const t0 = Date.parse(`${start}T00:00:00Z`);
  for (let i = 0; i < days; i++) {
    const r = i === 0 ? 0 : cycle[(i - 1) % 5];
    const open = close;
    close = open * (1 + r / 100);
    out.push({
      day: new Date(t0 + i * 86_400_000).toISOString().slice(0, 10),
      open, high: Math.max(open, close) * 1.001, low: Math.min(open, close) * 0.999, close,
      volume: r === -4 ? 300 : 100,
    });
  }
  return out;
}

function storeCandles(db: AutomatonDatabase, asset: string, candles: Candle[]) {
  const stmt = db.raw.prepare(
    "INSERT OR REPLACE INTO trader_candles (asset, day, open, high, low, close, volume, source) VALUES (?, ?, ?, ?, ?, ?, ?, 'test')",
  );
  for (const c of candles) stmt.run(asset, c.day, c.open, c.high, c.low, c.close, c.volume);
}

/** Fake Kraken OHLC answer: the last row is the unfinished day, after `last`. */
function fakeOhlc(prices: Record<string, Candle[]>) {
  return vi.fn(async (url: string) => {
    const u = new URL(url);
    if (u.pathname !== "/0/public/OHLC" || u.searchParams.get("interval") !== "1440") throw new Error(`unexpected ${url}`);
    const pair = u.searchParams.get("pair")!;
    const candles = prices[pair];
    if (!candles) return new Response(JSON.stringify({ error: ["EQuery:Unknown asset pair"] }), { status: 200 });
    const rows = candles.map((c) => [Date.parse(`${c.day}T00:00:00Z`) / 1000, String(c.open), String(c.high), String(c.low), String(c.close), "0", String(c.volume), 10]);
    const unfinished = [Number(rows.at(-1)![0]) + 86_400, "1", "1", "1", "1", "0", "1", 1];
    return new Response(JSON.stringify({ error: [], result: { [`X${pair}Z`]: [...rows, unfinished], last: rows.at(-1)![0] } }), { status: 200 });
  }) as unknown as typeof fetch;
}

const dropRule = (claim: TestRule["claim"] = "more_often_than_usual"): TestRule => ({
  claim,
  when: [{ kind: "return", asset: "BTC", days: 1, op: "<=", value: -3 }],
  then: { kind: "forward_return", asset: "BTC", days: 1, op: ">", value: 0 },
});

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

// ─── Daily history ──────────────────────────────────────────────

describe("Daily history from Kraken", () => {
  it("stores committed daily candles, skips the unfinished day, survives a reopen, and updates in place", async () => {
    const file = path.join(tmp("sonni-candles-"), "state.db");
    const db = openDb(file);
    const btc = cycleCandles(300), eth = cycleCandles(300, "2024-01-01", 0.05);
    const kraken = fakeOhlc({ XBTEUR: btc, ETHEUR: eth });
    const result = await collectCandles(db.raw, TRADER, kraken);
    expect(result.errors).toEqual([]);
    expect((kraken as any).mock.calls[0][0]).toContain("interval=1440");
    db.close();
    const reopened = openDb(file);
    const stored = loadDaily(reopened.raw, "BTC");
    expect(stored).toHaveLength(300);
    expect(stored.at(-1)!.day).toBe(btc.at(-1)!.day); // the unfinished day is not stored
    btc[299] = { ...btc[299], close: 123 };
    await collectCandles(reopened.raw, TRADER, fakeOhlc({ XBTEUR: btc, ETHEUR: eth }));
    expect(loadDaily(reopened.raw, "BTC").at(-1)!.close).toBe(123);
    reopened.close();
  });

  it("keeps the asset that arrived and reports the one that failed", async () => {
    const db = openDb();
    await expect(historyTick(db.raw, TRADER, fakeOhlc({ XBTEUR: cycleCandles(50) }))).rejects.toThrow(/ETHEUR/);
    expect(loadDaily(db.raw, "BTC")).toHaveLength(50);
    db.close();
  });
});

// ─── Rule language ──────────────────────────────────────────────

describe("Test rule language", () => {
  it("accepts every documented condition and outcome", () => {
    const rule = parseTestRule({
      claim: "more_often_than_usual",
      when: [
        { kind: "streak", asset: "BTC", direction: "down", days: 3 },
        { kind: "weekday", days: ["mon", "fri"] },
        { kind: "volume_ratio", asset: "ETH", op: ">=", value: 2 },
      ],
      then: { kind: "relative_forward_return", asset: "ETH", versus: "BTC", days: 7, op: ">", value: 0 },
    }, ASSETS);
    expect(rule.when).toHaveLength(3);
    expect(parseTestRule({ claim: "most_of_the_time", when: [{ kind: "range", asset: "BTC", op: ">=", value: 6 }],
      then: { kind: "abs_forward_return", asset: "ETH", days: 1, op: ">=", value: 3 } }, ASSETS).claim).toBe("most_of_the_time");
  });

  it("refuses invalid rules with a message the model can act on", () => {
    const bad = (raw: unknown) => () => parseTestRule(raw, ASSETS);
    expect(bad({ ...dropRule(), extra: 1 })).toThrow(/unknown key "extra"/);
    expect(bad({ ...dropRule(), claim: "always" })).toThrow(/claim/);
    expect(bad({ ...dropRule(), when: [{ kind: "return", asset: "DOGE", days: 1, op: "<=", value: -3 }] })).toThrow(/asset must be one of BTC, ETH/);
    expect(bad({ ...dropRule(), when: [{ kind: "return", asset: "BTC", days: 1, op: "=", value: -3 }] })).toThrow(/op/);
    expect(bad({ ...dropRule(), when: [1, 2, 3, 4] })).toThrow(/0 to 3 conditions/);
    expect(bad({ ...dropRule(), then: { kind: "relative_forward_return", asset: "BTC", versus: "BTC", days: 1, op: ">", value: 0 } })).toThrow(/differ/);
    expect(bad({ ...dropRule(), then: { kind: "forward_return", asset: "BTC", days: 90, op: ">", value: 0 } })).toThrow(/days/);
  });
});

// ─── Evaluation by code ─────────────────────────────────────────

describe("Historical evaluation by code", () => {
  const history = { BTC: cycleCandles(400), ETH: cycleCandles(400, "2024-01-01", 0.05) };

  it("supports a rule that held: after a -4 % day the next day was always up (3 in 5 days usually)", () => {
    const s = evaluateRule(dropRule(), history);
    expect(s.cases).toBe(79); // 80 drop days; the last one has no next day in the data yet
    expect(s.rate).toBe(1);
    expect(s.baseRate).toBeCloseTo(0.6, 2);
    expect(s.z!).toBeGreaterThan(2.33);
    expect(s.verdict).toBe("supported");
  });

  it("refutes a rule that did worse than usual, and stays silent on small samples", () => {
    const after5 = parseTestRule({ claim: "more_often_than_usual", when: [{ kind: "return", asset: "BTC", days: 1, op: ">=", value: 4 }],
      then: { kind: "forward_return", asset: "BTC", days: 1, op: "<", value: 0 } }, ASSETS);
    expect(evaluateRule(after5, history).verdict).toBe("refuted");
    const short = evaluateRule(dropRule(), { BTC: cycleCandles(100), ETH: cycleCandles(100) });
    expect(short.cases).toBeLessThan(30);
    expect(short.verdict).toBe("insufficient");
  });

  it("evaluates streaks, weekdays, volume spikes and the most-of-the-time claim", () => {
    const volume = parseTestRule({ claim: "most_of_the_time", when: [{ kind: "volume_ratio", asset: "BTC", op: ">=", value: 2 }],
      then: { kind: "forward_return", asset: "BTC", days: 1, op: ">", value: 4 } }, ASSETS);
    const v = evaluateRule(volume, history);
    expect(v.baseRate).toBe(0.5);
    expect(v.rate).toBe(1);
    expect(v.verdict).toBe("supported");
    const streak2 = parseTestRule({ claim: "more_often_than_usual", when: [{ kind: "streak", asset: "BTC", direction: "up", days: 2 }],
      then: { kind: "forward_return", asset: "BTC", days: 1, op: ">", value: 0 } }, ASSETS);
    const s2 = evaluateRule(streak2, history);
    expect(s2.cases).toBe(79); // +5 % then +1 %: two up days once per cycle, always followed by a -1 % day
    expect(s2.rate).toBe(0);
    expect(s2.verdict).toBe("refuted");
    const streak3 = parseTestRule({ claim: "more_often_than_usual", when: [{ kind: "streak", asset: "BTC", direction: "up", days: 3 }],
      then: { kind: "forward_return", asset: "BTC", days: 1, op: ">", value: 0 } }, ASSETS);
    expect(evaluateRule(streak3, history).cases).toBe(0); // never three up days in a row
    const weekday = parseTestRule({ claim: "more_often_than_usual", when: [{ kind: "weekday", days: ["mon"] }],
      then: { kind: "forward_return", asset: "BTC", days: 1, op: ">", value: 0 } }, ASSETS);
    const w = evaluateRule(weekday, history);
    expect(w.cases).toBeGreaterThan(50);
    expect(w.verdict).not.toBe("supported"); // weekdays and the 5-day cycle are unrelated
  });

  it("appends one test per new day of data, never rewrites one", () => {
    const db = openDb();
    storeCandles(db, "BTC", history.BTC.slice(0, 399));
    storeCandles(db, "ETH", history.ETH.slice(0, 399));
    const h = addHypothesis(db.raw, { statement: "BTC rebounds the day after a drop of 3 % or more", origin: "prior", testRule: dropRule() });
    expect(runAllHistoricalTests(db.raw, TRADER)).toBe(1);
    expect(runAllHistoricalTests(db.raw, TRADER)).toBe(0); // nothing new
    storeCandles(db, "BTC", history.BTC.slice(399));
    storeCandles(db, "ETH", history.ETH.slice(399));
    expect(runAllHistoricalTests(db.raw, TRADER)).toBe(1);
    expect(latestHistoricalTest(db.raw, h.id)!.dataTo).toBe(history.BTC[399].day);
    expect(() => db.raw.prepare("UPDATE trader_historical_tests SET verdict = 'refuted'").run()).toThrow(/append-only/);
    expect(() => db.raw.prepare("DELETE FROM trader_historical_tests").run()).toThrow(/append-only/);
    // Forward confidence is untouched by history.
    expect(getHypothesis(db.raw, h.id)!.status).toBe("untested");
    db.close();
  });
});

// ─── propose_hypothesis ─────────────────────────────────────────

describe("propose_hypothesis tool", () => {
  const ctxFor = (db: AutomatonDatabase): ToolContext => ({
    identity: createTestIdentity(), config: sonniVpsConfig(), db, conway: new MockConwayClient(), inference: new MockInferenceClient(),
  });
  const propose = createTraderTools().find((t) => t.name === "propose_hypothesis")!;

  it("tests a rule at once, accepts a JSON string, keeps origins and refuses bad rules", async () => {
    const db = openDb();
    storeCandles(db, "BTC", cycleCandles(400));
    storeCandles(db, "ETH", cycleCandles(400, "2024-01-01", 0.05));
    const ctx = ctxFor(db);
    startIntake(db.raw);
    const r1 = await propose.execute({ statement: "BTC rebounds the day after a drop of 3 % or more", test_rule: dropRule() }, ctx);
    expect(r1).toMatch(/Hypothesis h_\w+ recorded \(prior\)\. history .*79\/79 = 100 % vs 60 % on all days, z=.* -> SUPPORTED/);
    const r2 = await propose.execute({ statement: "BTC rebounds after drops, given as a JSON string", test_rule: JSON.stringify(dropRule()) }, ctx);
    expect(r2).toMatch(/SUPPORTED/);
    const r3 = await propose.execute({ statement: "Central bank surprises move BTC more than CPI prints" }, ctx);
    expect(r3).toMatch(/No test_rule: your predictions will test it/);
    const r4 = await propose.execute({ statement: "Bad rule example for testing", test_rule: { claim: "x" } }, ctx);
    expect(r4).toMatch(/Refused, invalid test_rule/);
    closeIntakeWake(db.raw);
    const r5 = await propose.execute({ statement: "ETH follows BTC within a day, observed today" }, ctx);
    expect(r5).toMatch(/\(observation\)/);
    const origins = db.raw.prepare("SELECT origin, COUNT(*) AS n FROM trader_hypotheses GROUP BY origin").all();
    expect(origins).toEqual([{ origin: "observation", n: 1 }, { origin: "prior", n: 3 }]);
    db.close();
  });

  it("limits what the model adds outside the intake to a few per day", async () => {
    const db = openDb();
    const ctx = ctxFor(db);
    for (let i = 0; i < MAX_MODEL_HYPOTHESES_PER_DAY; i++) {
      expect(await propose.execute({ statement: `Observation number ${i} about the market` }, ctx)).toMatch(/recorded/);
    }
    expect(await propose.execute({ statement: "One more observation about the market" }, ctx)).toMatch(/Refused: 10 hypotheses already added today/);
    db.close();
  });
});

// ─── Intake ─────────────────────────────────────────────────────

describe("Intake of prior knowledge", () => {
  let home: string;
  let previousHome: string | undefined;
  beforeEach(() => {
    home = tmp("sonni-home-");
    previousHome = process.env.HOME;
    process.env.HOME = home;
  });
  afterEach(() => {
    process.env.HOME = previousHome;
  });

  it("waits for history, then runs on the stronger model, counts a paid attempt, and stops once enough priors exist", async () => {
    const db = openDb();
    addLedgerEntry(db.raw, { kind: "owner_funding", amountCents: 5800, source: "operator", reference: "budget" });
    expect(intakeDue(db.raw, TRADER)).toBe(false); // no history yet
    storeCandles(db, "BTC", cycleCandles(400));
    storeCandles(db, "ETH", cycleCandles(400, "2024-01-01", 0.05));
    expect(intakeDue(db.raw, TRADER)).toBe(true);

    const inference = new MockInferenceClient([
      toolCallResponse([
        { name: "propose_hypothesis", arguments: { statement: "BTC rebounds the day after a drop of 3 % or more", test_rule: dropRule() } },
        { name: "propose_hypothesis", arguments: { statement: "Halvings are followed by months of strength" } },
      ]),
      toolCallResponse([{ name: "sleep", arguments: { duration_seconds: 3600, reason: "intake done for now" } }]),
    ]);
    await runAgentLoop({
      identity: { ...createTestIdentity(), sandboxId: "" }, config: sonniVpsConfig(), db, conway: new MockConwayClient(), inference,
      policyEngine: new PolicyEngine(db.raw, createDefaultRules()), spendTracker: new SpendTracker(db.raw),
    });
    expect(String(inference.calls[0].messages.at(-1)?.content)).toContain("SONNI INTAKE");
    expect(inference.calls[0].options?.model).toBe("claude-opus-5-5");
    expect(intakeAttempts(db.raw)).toBe(1);
    expect((db.raw.prepare("SELECT COUNT(*) AS n FROM trader_hypotheses WHERE origin = 'prior'").get() as any).n).toBe(2);
    expect(intakeDue(db.raw, TRADER)).toBe(true); // 2 of 30: another intake wake will come

    for (let i = 0; i < INTAKE_MIN_PRIOR; i++) addHypothesis(db.raw, { statement: `Prior belief number ${i}`, origin: "prior" });
    expect(intakeDue(db.raw, TRADER)).toBe(false);
    db.close();
  });

  it("shows historical verdicts in the memory pack and in French on Telegram", async () => {
    const db = openDb();
    storeCandles(db, "BTC", cycleCandles(400));
    storeCandles(db, "ETH", cycleCandles(400, "2024-01-01", 0.05));
    const h = addHypothesis(db.raw, { statement: "BTC rebounds the day after a drop of 3 % or more", origin: "prior", testRule: dropRule() });
    runHistoricalTest(db.raw, h);
    addHypothesis(db.raw, { statement: "Halvings are followed by months of strength", origin: "prior" });
    const pack = buildMemoryPack(db.raw, TRADER);
    expect(pack).toMatch(/1 supported, 0 refuted, 0 inconclusive, 0 insufficient/);
    expect(pack).toMatch(/79\/79 = 100 % vs 60 % on all days.*SUPPORTED/);
    expect(pack).toMatch(/Halvings .*no test rule/);
    const channel = new TelegramChannel("token", 42, db, { ...sonniVpsConfig(), name: "sonni" }, fetchSpy as any);
    const text = channel.handleOwnerText("/intuitions", 1)!;
    expect(text).toMatch(/savoir de Sonni\] BTC rebounds .*historique : 100 % des 79 cas contre 60 % d'habitude, confirmée par l'historique/);
    expect(fetchSpy).not.toHaveBeenCalled();
    db.close();
  });
});

describe("Configuration", () => {
  it("still needs the Money Lab runtime", () => {
    expect(() => applyTraderProfile({ trader: EXAMPLE.trader })).toThrow(/moneyLab/);
  });
});
