/**
 * Sonni step 3, integration: the tools through the policy engine, the
 * system prompt (stable identity and lessons, volatile rules), the memory
 * pack, the daily reflection in the agent loop, Telegram commands and
 * the denied Automaton tools. Mocked inference, no network.
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
import { ensureMoneyLabSchema, journalFingerprint } from "../../money-lab/journal.js";
import { createMoneyLabTools } from "../../money-lab/tools.js";
import { TelegramChannel } from "../../money-lab/telegram.js";
import { splitVolatileSystem } from "../../conway/inference.js";
import type { AutomatonConfig, AutomatonDatabase, ToolContext } from "../../types.js";
import { applyTraderProfile, parseTraderConfig, SONNI_DENIED_TOOLS, type TraderConfig } from "../../trader/config.js";
import { ensureTraderSchema } from "../../trader/schema.js";
import { isoSeconds } from "../../trader/prices.js";
import { addHypothesis } from "../../trader/hypotheses.js";
import { recordPrediction, resolveDuePredictions } from "../../trader/predictions.js";
import { createTraderTools } from "../../trader/tools.js";
import { buildMemoryPack, PACK_BUDGET } from "../../trader/pack.js";
import { listHypotheses } from "../../trader/hypotheses.js";

const listHypothesesIds = (db: AutomatonDatabase) => listHypotheses(db.raw).map((h) => h.id);
import { buildSonniIdentityBlock, buildSonniPromptBlock, SONNI_REFLECTION_INSTRUCTIONS } from "../../trader/prompt.js";
import { activeLessons, listReflections, reflectionDue, reflectionOpen, reviseIdentity, IDENTITY_ANCHOR } from "../../trader/soul.js";
import { openWatches, recordWake, SONNI_WAKE_SOURCE } from "../../trader/curiosity.js";
import { ensureCatalog } from "../../trader/sources.js";
import { insertObservation } from "../../trader/readers.js";
import { MockConwayClient, MockInferenceClient, createTestConfig, createTestIdentity, toolCallResponse } from "../mocks.js";

const EXAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "..", "sonni", "automaton.sonni.example.json"), "utf-8"));
const TRADER: TraderConfig = parseTraderConfig(EXAMPLE.trader)!;
const T0 = new Date("2026-10-07T08:00:00Z");
const hours = (n: number) => new Date(T0.getTime() + n * 3_600_000);

function sonniConfig(): AutomatonConfig {
  const moneyLab = { ...EXAMPLE.moneyLab, runtime: "conway", telegram: null, inference: { ...EXAMPLE.moneyLab.inference, model: "gpt-5-mini" } };
  return applyTraderProfile(applyMoneyLabProfile(createTestConfig({ moneyLab, trader: EXAMPLE.trader, logLevel: "error" } as any)));
}

let tmpDirs: string[] = [];
function openDb(): AutomatonDatabase {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sonni-alive-"));
  tmpDirs.push(dir);
  const db = createDatabase(path.join(dir, "state.db"));
  ensureMoneyLabSchema(db.raw);
  ensureTraderSchema(db.raw);
  return db;
}

function price(db: AutomatonDatabase, asset: string, at: Date, value: number): void {
  db.raw.prepare("INSERT OR REPLACE INTO trader_prices (asset, ts, price, source) VALUES (?, ?, ?, 'test')").run(asset, isoSeconds(at), value);
}

function toolRunner(db: AutomatonDatabase) {
  const ctx: ToolContext = { identity: createTestIdentity(), config: sonniConfig(), db, conway: new MockConwayClient(), inference: new MockInferenceClient() };
  const tools = [...createBuiltinTools(ctx.identity.sandboxId), ...createMoneyLabTools(), ...createTraderTools()];
  const engine = new PolicyEngine(db.raw, createDefaultRules());
  const turn = { inputSource: "agent" as const, turnToolCallCount: 0, sessionSpend: new SpendTracker(db.raw) };
  return (name: string, args: Record<string, unknown>) => executeTool(name, args, tools, ctx, engine, turn);
}

beforeEach(() => {
  tmpDirs = [];
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("tests must not reach the network"); }));
  // The example config names two readers; the shell running the tests must not lend them keys.
  vi.stubEnv("GEMINI_API_KEY", "");
  vi.stubEnv("GROQ_API_KEY", "");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Tools through the policy engine", () => {
  it("writes identity, journal, lessons and watches; refuses what the limits refuse", async () => {
    const db = openDb();
    const run = toolRunner(db);
    const h = addHypothesis(db.raw, { statement: "BTC holds above 50k in calm weeks", origin: "owner" }, T0);
    price(db, "BTC", new Date(), 60000);
    const identity = await run("revise_identity", { content: `${IDENTITY_ANCHOR}, apprenti courtier prudent. Je préfère les horizons de quelques jours et je note chaque erreur de calibration.`, reason: "première séance" });
    expect(identity.result).toContain("Identity version 2 recorded");
    const reflection = await run("write_reflection", { kind: "session", content: "Séance d'ouverture : je lis mon bilan vide et je pose deux veilles." });
    expect(reflection.result).toMatch(/Reflection r_\w+ \(session\) recorded/);
    const lesson = await run("add_lesson", { text: "Avant une décision de la Fed, réduire les probabilités extrêmes.", evidence_ids: [h.id] });
    expect(lesson.result).toMatch(/Lesson l_\w+ added/);
    const lessonId = String(lesson.result).match(/l_\w+/)![0];
    expect((await run("add_lesson", { text: "Sans preuve, pas de leçon valable ici.", evidence_ids: ["p_nope"] })).result).toContain("Refused: Unknown evidence id");
    expect((await run("retire_lesson", { id: lessonId, reason: "doublon avec ma réflexion" })).result).toContain("retired");
    expect(activeLessons(db.raw)).toEqual([]);
    const watch = await run("set_watch", { action: "add", kind: "price", asset: "BTC", direction: "below", value: 55000, note: "support cassé : relire les observations" });
    expect(watch.result).toMatch(/Watch set: w_\w+ \[price\] BTC below 55000 EUR/);
    expect((await run("set_watch", { action: "list" })).result).toContain("Open watches:");
    expect((await run("set_watch", { action: "add", kind: "price", asset: "BTC", direction: "above", value: 1, note: "déjà au-dessus" })).result).toContain("would fire at once");
    expect((await run("read_page", { url: "https://example.com", why: "" })).result).toContain("Refused: say in `why`");
    expect((await run("manage_source", { action: "list" })).result).toContain("Sources:");
    expect((await run("manage_source", { action: "enable", id: "nope", reason: "inconnue" })).result).toContain("Unknown source");
    expect((await run("follow_asset", { action: "unfollow", symbol: "ETH", reason: "je me concentre sur le bitcoin pour commencer" })).result).toContain("ETH no longer followed");
    expect((await run("follow_asset", { action: "unfollow", symbol: "BTC", reason: "le dernier actif, cela doit échouer" })).result).toContain("At least one asset");
    // Sonni's stores count as progress for the no-progress sleep.
    expect(journalFingerprint(db.raw)).toContain("1/1/1");
    db.close();
  });

  it("denies Automaton's soul and memory tools and the relay tools for Sonni", async () => {
    const db = openDb();
    const run = toolRunner(db);
    for (const name of ["update_soul", "remember_fact", "set_goal", "distress_signal", "send_message"]) {
      expect(SONNI_DENIED_TOOLS.has(name)).toBe(true);
      const r = await run(name, {});
      expect(String(r.error ?? r.result)).toMatch(/SONNI_TOOL_DISABLED|not found|Unknown tool/i);
    }
    db.close();
  });
});

describe("Prompt and memory pack", () => {
  it("puts identity and lessons in the stable mission and the day's counters in the volatile rules", () => {
    const db = openDb();
    const config = sonniConfig();
    reviseIdentity(db.raw, { content: `${IDENTITY_ANCHOR}, et je me méfie des rebonds trop rapides après une forte baisse du bitcoin.`, reason: "après une semaine", source: "model" }, T0);
    const stable = buildSonniIdentityBlock(db.raw);
    expect(stable).toContain("## Your identity (version 2, written by you)");
    expect(stable).toContain("rebonds trop rapides");
    expect(stable).toContain("## Your lessons (0 active");
    const rules = buildSonniPromptBlock(db.raw, config.moneyLab!, config.trader!, {});
    expect(rules.startsWith("--- SONNI RULES")).toBe(true);
    expect(rules).toContain("Curiosity: 0 of 6 self-wakes used today (move alert 3 % in 1 h");
    // The example config names two readers; the environment given here holds no key.
    expect(rules).toContain("Pages read today: 0 of 20. Readers: gemini no key, groq no key.");
    expect(buildSonniPromptBlock(db.raw, config.moneyLab!, config.trader!, { GEMINI_API_KEY: "x" })).toContain("Readers: gemini 0/200 calls today, groq no key.");
    expect(buildSonniPromptBlock(db.raw, config.moneyLab!, { ...config.trader!, readers: [] }, {})).toContain("Readers: none configured");
    expect(rules).toContain("Followed assets: BTC, ETH");
    db.close();
  });

  it("tells the model what happened since its last pack, its self-report, observations, watches and reflections", () => {
    const db = openDb();
    ensureCatalog(db.raw, T0);
    const h = addHypothesis(db.raw, { statement: "BTC holds above 50k in calm weeks", origin: "owner" }, T0);
    price(db, "BTC", T0, 60000);
    price(db, "ETH", T0, 2400);
    const first = buildMemoryPack(db.raw, { ...TRADER, readers: [] }, T0, 193);
    expect(first).not.toContain("Since your last pack");
    expect(first).toContain("SELF-REPORT (computed by code");
    expect(first).toContain("Open watches (0; code wakes you when one fires)");
    expect(first).toContain("Your last reflections (0 of your journal");
    expect(first).toContain("Observations: no reader model configured");
    // A prediction resolves, a trigger fires, an observation arrives.
    const p = recordPrediction(db.raw, TRADER, { asset: "BTC", direction: "above", threshold: 59000, horizonHours: 1, probability: 0.7, hypothesisId: h.id, statement: "s", rationale: "r" }, T0);
    if (!p.ok) throw new Error(p.error);
    price(db, "BTC", hours(1), 60100);
    resolveDuePredictions(db.raw, TRADER, hours(1));
    recordWake(db.raw, SONNI_WAKE_SOURCE, { key: "resolved", reason: "1 prediction(s) resolved" }, true, hours(1));
    insertObservation(db.raw, { publishedAt: hours(1).toISOString(), source: "reader:gemini", url: "https://news.example/a", assets: ["BTC"], kind: "etf", sentiment: 0.5, summary: "Record ETF inflows.", eventDate: null }, hours(1));
    db.raw.prepare("INSERT INTO trader_metrics (source_id, metric, ts, value) VALUES ('fear_greed', 'index', ?, 27)").run(isoSeconds(hours(1)));
    const second = buildMemoryPack(db.raw, { ...TRADER, readers: [{ id: "gemini", baseUrl: "https://x.y/v1", model: "m", keyEnv: "K", dailyRequests: 1, jsonMode: true }] }, hours(2), 193);
    expect(second).toContain(`Since your last pack (${T0.toISOString().slice(0, 16).replace("T", " ")} UTC; computed by code):`);
    expect(second).toContain("trigger (woke you): 1 prediction(s) resolved");
    expect(second).toContain(`1 prediction(s) resolved: ${p.prediction.id} BTC happened Brier 0.090`);
    expect(second).toContain(`Waiting for your post-mortem (write_reflection kind postmortem): ${p.prediction.id}`);
    expect(second).toContain("Observations, last 24 h (1, extracted by reader models");
    expect(second).toContain("- BTC: 1 item(s), mean sentiment +0.50");
    expect(second).toContain("Indicators from your sources");
    expect(second).toContain("- Crypto Fear & Greed (alternative.me) index: 27.00 (1 h old)");
    db.close();
  });
});

describe("Memory pack size", () => {
  it("fits the tool-result budget with every store full, keeps Sonni's own state first, and offers each group in full", async () => {
    const db = openDb();
    ensureCatalog(db.raw, T0);
    const now = new Date();
    for (let i = 0; i < 40; i++) {
      addHypothesis(db.raw, { statement: `Hypothesis number ${i}: ${"a long statement about how BTC and ETH react to macro surprises ".repeat(4)}`, origin: "prior" }, now);
    }
    const h = listHypothesesIds(db)[0];
    price(db, "BTC", now, 60000);
    price(db, "ETH", now, 2400);
    for (let i = 0; i < 25; i++) {
      const r = recordPrediction(db.raw, TRADER, { asset: "BTC", direction: "above", threshold: 50000 + i, horizonHours: 48, probability: 0.6, hypothesisId: h, statement: `p${i}`, rationale: "r" }, now);
      if (!r.ok) throw new Error(r.error);
    }
    for (let i = 0; i < 80; i++) {
      insertObservation(db.raw, { publishedAt: now.toISOString(), source: "reader:gemini", url: `https://n.example/${i}`, assets: [i % 2 ? "BTC" : "ETH"], kind: "market", sentiment: 0.1, summary: `Observation ${i} ${"x".repeat(200)}`, eventDate: null }, now);
      db.raw.prepare("INSERT INTO trader_headlines (url, title, domain, published_at, fetched_at) VALUES (?, ?, 'n.example', ?, ?)")
        .run(`https://n.example/h${i}`, `Headline ${i} ${"y".repeat(150)}`, isoSeconds(now), now.toISOString());
    }
    insertObservation(db.raw, { publishedAt: now.toISOString(), source: "page", url: "https://fed.example/minutes", assets: [], kind: "other", sentiment: null, summary: "Fed minutes: rates unchanged.", eventDate: null }, now);
    const pack = buildMemoryPack(db.raw, TRADER, now, 193);
    expect(pack.length).toBeLessThanOrEqual(PACK_BUDGET);
    // What Sonni itself must see is never cut away by long lists of hypotheses or headlines.
    expect(pack).toContain("Open predictions (25):");
    expect(pack).toContain("(10 more open: sonni_memory with {\"section\": \"predictions\"})");
    expect(pack).toContain("Open watches (0;");
    expect(pack).toContain("SELF-REPORT (computed by code");
    expect(pack).toMatch(/Hypotheses \(40;/);
    expect(pack).toMatch(/sonni_memory with \{"section": "(hypotheses|headlines|observations|reflections)"\}/);
    // The detail views return one group, within the same budget, without moving the "since" reference.
    const run = toolRunner(db);
    const hyp = await run("sonni_memory", { section: "hypotheses" });
    expect(String(hyp.result)).toContain('MEMORY SECTION "hypotheses"');
    expect(String(hyp.result).length).toBeLessThanOrEqual(PACK_BUDGET);
    const obs = await run("sonni_memory", { section: "observations" });
    expect(String(obs.result)).toContain("page other: Fed minutes: rates unchanged.");
    expect(String((await run("sonni_memory", { section: "nope" })).result)).toContain("Unknown section nope");
    db.close();
  });

  it("shows the pages Sonni read even though they carry no asset", () => {
    const db = openDb();
    const now = new Date();
    insertObservation(db.raw, { publishedAt: now.toISOString(), source: "page", url: "https://fed.example/minutes", assets: [], kind: "other", sentiment: null, summary: "Fed minutes: rates unchanged.", eventDate: null }, now);
    const pack = buildMemoryPack(db.raw, TRADER, now, null);
    expect(pack).toContain("- Pages you read (1):");
    expect(pack).toContain("fed.example: Fed minutes: rates unchanged.");
    db.close();
  });
});

describe("Daily reflection in the agent loop", () => {
  it("adds the reflection instructions when a prediction resolved, and marks it done after a paid turn", async () => {
    const db = openDb();
    const config = sonniConfig();
    const h = addHypothesis(db.raw, { statement: "BTC holds above 50k in calm weeks", origin: "owner" });
    const now = new Date();
    price(db, "BTC", new Date(now.getTime() - 2 * 3_600_000), 60000);
    const p = recordPrediction(db.raw, TRADER, { asset: "BTC", direction: "above", threshold: 59000, horizonHours: 1, probability: 0.7, hypothesisId: h.id, statement: "s", rationale: "r" }, new Date(now.getTime() - 2 * 3_600_000));
    if (!p.ok) throw new Error(p.error);
    price(db, "BTC", new Date(now.getTime() - 3_600_000), 60100);
    resolveDuePredictions(db.raw, TRADER, now);
    expect(reflectionDue(db.raw)).toBe(true);
    const inference = new MockInferenceClient([
      toolCallResponse([{ name: "write_reflection", arguments: { kind: "postmortem", subject_id: p.prediction.id, content: "Marché calme comme prévu ; 70 % était raisonnable, le résultat le confirme sans me donner raison sur le fond." } }]),
      toolCallResponse([{ name: "sleep", arguments: { duration_seconds: 3600, reason: "done" } }]),
    ]);
    const turns: any[] = [];
    await runAgentLoop({
      identity: createTestIdentity(), config, db, conway: new MockConwayClient(), inference,
      policyEngine: new PolicyEngine(db.raw, createDefaultRules()), spendTracker: new SpendTracker(db.raw),
      onTurnComplete: (t) => turns.push(t),
    });
    const sent = JSON.stringify(inference.calls[0].messages);
    expect(sent).toContain("SONNI REFLECTION (required in this wake cycle");
    expect(SONNI_REFLECTION_INSTRUCTIONS).toContain("write_reflection kind postmortem");
    const calls = turns.flatMap((t) => t.toolCalls);
    expect(calls[0].result).toMatch(/Reflection r_\w+ \(postmortem\) recorded/);
    expect(listReflections(db.raw, 1)[0].subjectId).toBe(p.prediction.id);
    expect(reflectionOpen(db.raw)).toBe(false);
    expect(reflectionDue(db.raw)).toBe(false);
    // The system prompt carries the seed identity in the stable part and the rules in the volatile part.
    const system = String(inference.calls[0].messages[0].content);
    const split = splitVolatileSystem(system, "claude-sonnet-5-5", [{ role: "user", content: "wake" }])!;
    expect(split.system.map((b) => String(b.text)).join("")).toContain("## Your identity (version 1");
    expect(split.volatile).toContain("Curiosity:");
    db.close();
  });
});

describe("Telegram", () => {
  it("answers the new owner commands in French and only to the owner", async () => {
    const db = openDb();
    ensureCatalog(db.raw, T0);
    const config = applyTraderProfile(applyMoneyLabProfile(createTestConfig({ moneyLab: EXAMPLE.moneyLab, trader: EXAMPLE.trader, sandboxId: "", logLevel: "error" } as any)));
    const channel = new TelegramChannel("token", 42, db, config, vi.fn() as any);
    expect(channel.handleOwnerText("/aide", 1)).toContain("/identite");
    expect(channel.handleOwnerText("/identite", 2)).toContain("Identité de Sonni — version 1, écrite par le code");
    expect(channel.handleOwnerText("/journal", 3)).toContain("Journal vide");
    expect(channel.handleOwnerText("/lecons", 4)).toContain("Aucune leçon encore");
    expect(channel.handleOwnerText("/bilan", 5)).toContain("sur 1.93 $");
    expect(channel.handleOwnerText("/reveils", 6)).toContain("aucun déclencheur");
    expect(channel.handleOwnerText("/lecteurs", 7)).toContain("gemini (gemini-3.5-flash-lite) : clé absente");
    expect(channel.handleOwnerText("/sources", 8)).toContain("fear_greed [active]");
    expect(channel.handleOwnerText("/source ok nope", 9)).toContain("Source inconnue");
    expect(channel.handleOwnerText("/actifs", 10)).toContain("Actifs suivis (2, au plus 30)");
    expect(channel.handleOwnerText("/veto l_nope", 11)).toContain("Unknown lesson");
    expect(channel.handleOwnerText("/statut", 12)).toContain("Vie de Sonni : 0 réveil(s) sur 6 aujourd'hui");
    expect(openWatches(db.raw)).toEqual([]);
    db.close();
  });
});
