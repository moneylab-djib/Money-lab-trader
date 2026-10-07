/**
 * Step C2: reactions measured by code around past events (four windows,
 * once per event, asset and window), the cycles the model names with
 * code-computed statistics and verdicts, their place in the memory pack,
 * /cycles for the owner and the cycles notebook. No network, no inference.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createDatabase } from "../../state/database.js";
import { createBuiltinTools, executeTool } from "../../agent/tools.js";
import { PolicyEngine } from "../../agent/policy-engine.js";
import { SpendTracker } from "../../agent/spend-tracker.js";
import { createDefaultRules } from "../../agent/policy-rules/index.js";
import { ensureMoneyLabSchema } from "../../money-lab/journal.js";
import { applyMoneyLabProfile } from "../../money-lab/profile.js";
import { createMoneyLabTools } from "../../money-lab/tools.js";
import type { AutomatonConfig, AutomatonDatabase, ToolContext } from "../../types.js";
import { applyTraderProfile, parseTraderConfig, type TraderConfig } from "../../trader/config.js";
import { ensureTraderSchema } from "../../trader/schema.js";
import { isoSeconds } from "../../trader/prices.js";
import { cycleTable, listPatterns, namePattern, patternStats, reactionsTick, windowStats } from "../../trader/cycles.js";
import { buildMemoryPack, buildMemorySection } from "../../trader/pack.js";
import { exportNotebooks } from "../../trader/notebooks.js";
import { runSonniCommand } from "../../trader/cli.js";
import { createTraderTools } from "../../trader/tools.js";
import { createTestConfig, createTestIdentity, MockConwayClient, MockInferenceClient } from "../mocks.js";

const EXAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "..", "sonni", "automaton.sonni.example.json"), "utf-8"));
const TRADER: TraderConfig = parseTraderConfig(EXAMPLE.trader)!;
const NOW = new Date("2026-10-07T08:00:00Z");

function sonniConfig(): AutomatonConfig {
  const moneyLab = { ...EXAMPLE.moneyLab, runtime: "conway", telegram: null, inference: { ...EXAMPLE.moneyLab.inference, model: "gpt-5-mini" } };
  return applyTraderProfile(applyMoneyLabProfile(createTestConfig({ moneyLab, trader: EXAMPLE.trader, logLevel: "error" } as any)));
}

let tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sonni-cycles-"));
  tmpDirs.push(dir);
  return dir;
}
function openDb(): AutomatonDatabase {
  const db = createDatabase(path.join(tmp(), "state.db"));
  ensureMoneyLabSchema(db.raw);
  ensureTraderSchema(db.raw);
  return db;
}
beforeEach(() => { tmpDirs = []; });
afterEach(() => { for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true }); });

/** 40 daily candles from 2026-08-20: BTC closes rise 1 a day (100 + i), ETH alternates (100 + i % 2). */
function seed(db: AutomatonDatabase) {
  const insert = db.raw.prepare("INSERT INTO trader_candles (asset, day, open, high, low, close, volume, source) VALUES (?, ?, ?, ?, ?, ?, 1, 'test')");
  for (let i = 0; i < 40; i++) {
    const day = new Date(Date.UTC(2026, 7, 20 + i)).toISOString().slice(0, 10);
    const btc = 100 + i;
    const eth = 100 + (i % 2);
    insert.run("BTC", day, btc, btc, btc, btc);
    insert.run("ETH", day, eth, eth, eth, eth);
  }
  const ev = db.raw.prepare("INSERT INTO trader_events (type, day, source, recorded_at) VALUES (?, ?, 'test', ?)");
  ev.run("fomc", "2026-09-10", NOW.toISOString()); // i = 21
  ev.run("cpi", "2026-09-15", NOW.toISOString());  // i = 26
  ev.run("fomc", "2026-10-10", NOW.toISOString()); // in 3 days: not measured, but in the pack
  // 5-minute prices around the Fed release at 18:00 UTC on 2026-09-10 (BTC only).
  const px = db.raw.prepare("INSERT INTO trader_prices (asset, ts, price, source) VALUES (?, ?, ?, 'test')");
  px.run("BTC", isoSeconds(new Date("2026-09-10T17:55:00Z")), 60_000);
  px.run("BTC", isoSeconds(new Date("2026-09-10T19:00:00Z")), 60_600);
}

describe("Reactions measured by code", () => {
  it("measures each past event once per asset and window from candles and 5-minute prices", () => {
    const db = openDb();
    seed(db);
    expect(reactionsTick(db.raw, TRADER, NOW)).toBe(13);
    expect(reactionsTick(db.raw, TRADER, NOW)).toBe(0);
    const btc = windowStats(db.raw, "fomc", "BTC", "day");
    expect(btc).toMatchObject({ n: 1, mean: 0.83, upShare: 1, baseUpShare: 1, last: [{ day: "2026-09-10", returnPct: 0.83 }] });
    expect(windowStats(db.raw, "fomc", "BTC", "run_up").mean).toBe(0.84);
    expect(windowStats(db.raw, "fomc", "BTC", "week").mean).toBe(6.67);
    expect(windowStats(db.raw, "fomc", "BTC", "hour").mean).toBe(1);
    expect(windowStats(db.raw, "fomc", "ETH", "hour").n).toBe(0);
    expect(windowStats(db.raw, "cpi", "ETH", "day")).toMatchObject({ n: 1, baseUpShare: expect.closeTo(0.49, 1) });
    expect(cycleTable(db.raw, TRADER).map((t) => `${t.type}:${t.cases}`)).toEqual(["fomc:1", "cpi:1"]);
    expect(() => db.raw.prepare("UPDATE trader_reactions SET return_pct = 9").run()).toThrow(/append-only/);
    db.close();
  });
});

describe("Named cycles", () => {
  it("are checked, counted against all days with a z score and a verdict computed by code", () => {
    const db = openDb();
    seed(db);
    reactionsTick(db.raw, TRADER, NOW);
    const base = { name: "Fed : BTC monte le jour", eventType: "fomc", asset: "BTC", window: "day", direction: "up", note: "La Fed rassure et le BTC suit le jour même." };
    expect(namePattern(db.raw, TRADER, { ...base, eventType: "ecb" }, NOW)).toMatchObject({ ok: false, error: expect.stringContaining("event_type must be") });
    expect(namePattern(db.raw, TRADER, { ...base, asset: "DOGE" }, NOW)).toMatchObject({ ok: false, error: expect.stringContaining("Unknown asset DOGE") });
    expect(namePattern(db.raw, TRADER, { ...base, window: "month" }, NOW)).toMatchObject({ ok: false, error: expect.stringContaining("window must be") });
    expect(namePattern(db.raw, TRADER, { ...base, direction: "big_move", thresholdPct: 90 }, NOW)).toMatchObject({ ok: false, error: expect.stringContaining("threshold_pct") });
    expect(namePattern(db.raw, TRADER, { ...base, note: "court" }, NOW)).toMatchObject({ ok: false, error: expect.stringContaining("note must be") });
    const first = namePattern(db.raw, TRADER, base, NOW);
    expect(first).toMatchObject({ ok: true, value: { stats: { cases: 1, hits: 1, rate: 1, baseRate: 1, verdict: "insufficient" } } });
    expect(namePattern(db.raw, TRADER, { ...base, name: "fed : btc monte le jour" }, NOW)).toMatchObject({ ok: false, error: expect.stringContaining("exists") });
    // Twelve more measured Fed days on ETH (eleven up) beside the one already measured, against alternating days (about half up): supported.
    const ins = db.raw.prepare("INSERT INTO trader_reactions (type, day, asset, window, return_pct, computed_at) VALUES ('fomc', ?, 'ETH', 'day', ?, ?)");
    for (let i = 0; i < 12; i++) ins.run(`2025-${String(i + 1).padStart(2, "0")}-15`, i === 0 ? -1 : 1, NOW.toISOString());
    const eth = namePattern(db.raw, TRADER, { ...base, name: "Fed : ETH monte le jour", asset: "ETH" }, NOW);
    expect(eth.ok).toBe(true);
    const stats = patternStats(db.raw, (eth as any).value.pattern);
    expect(stats).toMatchObject({ cases: 13, hits: 12, verdict: "supported" });
    expect(stats.z!).toBeGreaterThan(2.33);
    expect(listPatterns(db.raw).map((p) => p.name)).toEqual(["Fed : BTC monte le jour", "Fed : ETH monte le jour"]);
    expect(() => db.raw.prepare("DELETE FROM trader_patterns").run()).toThrow(/append-only/);
    db.close();
  });
});

describe("Cycles in the pack, the tool, /cycles and the notebook", () => {
  it("shows the model the windows of the events due within a week and all of them on request; the owner reads them in French", async () => {
    const db = openDb();
    seed(db);
    reactionsTick(db.raw, TRADER, NOW);
    const ctx: ToolContext = { identity: createTestIdentity(), config: sonniConfig(), db, conway: new MockConwayClient(), inference: new MockInferenceClient() };
    const tools = [...createBuiltinTools(ctx.identity.sandboxId), ...createMoneyLabTools(), ...createTraderTools()];
    const engine = new PolicyEngine(db.raw, createDefaultRules());
    const turn = { inputSource: "agent" as const, turnToolCallCount: 0, sessionSpend: new SpendTracker(db.raw) };
    const r = await executeTool("name_pattern", { name: "Fed : BTC monte la semaine", event_type: "fomc", asset: "BTC", window: "week", direction: "up", note: "Le marché digère la Fed en une semaine." }, tools, ctx, engine, turn);
    expect(JSON.stringify(r)).toContain("Cycle « Fed : BTC monte la semaine » recorded: 1/1 = 100 % vs 100 % on all days -> INSUFFICIENT (fewer than 10 cases)");
    const pack = buildMemoryPack(db.raw, TRADER, NOW);
    expect(pack).toMatch(/Event cycles for the events due within 7 days \(fomc; measured by code; [^)]*\):\n- fomc x BTC \(1 events\): day before \+0\.84 % mean, 100 % up \(n=1; all days 100 % up, \|move\| [\d.]+ % vs 0\.84 %\); event day \+0\.83 % mean/);
    expect(pack).toContain("first hour +1.00 % mean, 100 % up (n=1)");
    expect(pack).toContain("- Your cycle « Fed : BTC monte la semaine » (fomc, BTC, week after, up): 1/1 = 100 %");
    expect(pack).not.toContain("- cpi x");
    const detail = buildMemorySection(db.raw, TRADER, "cycles", NOW);
    expect(detail).toContain("- cpi x ETH (1 events)");
    const out: string[] = [];
    expect(runSonniCommand(["cycles"], db.raw, TRADER, (t) => out.push(t))).toBe(0);
    expect(out[0]).toMatch(/^🔁 Cycles mesurés par le code \(réactions aux événements, en %\) :\ndécision de taux de la Fed — 1 cas :\n- BTC : la veille \+0,84 % en moyenne \(100 % de hausses sur 1 ; jours ordinaires 100 %\) · le jour \+0,83 % en moyenne/);
    expect(out[0]).toContain("· derniers : 10 sept. +0,83 %");
    expect(out[0]).toContain("inflation américaine (CPI) — 1 cas :");
    expect(out[0]).toContain("Cycles nommés par Sonni (chiffres calculés par le code) :\n- « Fed : BTC monte la semaine » (décision de taux de la Fed, BTC, la semaine, hausse) : 1 sur 1 (100 %), jours ordinaires 100 % → pas assez de cas. Le marché digère la Fed en une semaine.");
    expect(out[0]).not.toMatch(/cy_01[0-9A-Z]{20}/);
    const empty = openDb();
    const none: string[] = [];
    runSonniCommand(["cycles"], empty.raw, TRADER, (t) => none.push(t));
    expect(none[0]).toContain("aucune réaction mesurée encore");
    const dir = path.join(tmp(), "carnet");
    expect(exportNotebooks(db.raw, TRADER, dir, NOW)).toContain("cycles.md");
    expect(fs.readFileSync(path.join(dir, "cycles.md"), "utf-8")).toContain("# Cycles de Sonni");
    db.close();
    empty.close();
  });
});
