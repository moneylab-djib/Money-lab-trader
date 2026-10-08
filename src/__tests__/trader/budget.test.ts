/**
 * Budget guards of 2026-10-08: the evening turn's reserve (day-time calls stop
 * 40c short of the daily cap until the evening consolidation has run), the
 * evening instructions on any wake after its time, and the leaner prompt
 * (denied leftover tools, shorter history). No network, no inference.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createDatabase } from "../../state/database.js";
import { runAgentLoop } from "../../agent/loop.js";
import { PolicyEngine } from "../../agent/policy-engine.js";
import { SpendTracker } from "../../agent/spend-tracker.js";
import { createDefaultRules } from "../../agent/policy-rules/index.js";
import { ensureMoneyLabSchema, OWNER_TELEGRAM_SENDER } from "../../money-lab/journal.js";
import { applyMoneyLabProfile } from "../../money-lab/profile.js";
import type { AutomatonConfig, AutomatonDatabase } from "../../types.js";
import { applyTraderProfile, parseTraderConfig, SONNI_DENIED_TOOLS, type TraderConfig } from "../../trader/config.js";
import { ensureTraderSchema } from "../../trader/schema.js";
import {
  CONSOLIDATION_RESERVE_CENTS, consolidationDoneToday, consolidationTimeToday, markConsolidationDone, reserveBlocks,
} from "../../trader/consolidation.js";
import { listIncidents } from "../../trader/incidents.js";
import { createTestConfig, createTestIdentity, MockConwayClient, MockInferenceClient, toolCallResponse } from "../mocks.js";

const EXAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "..", "sonni", "automaton.sonni.example.json"), "utf-8"));
/** These tests exercise BTC and ETH; the owner's other core assets (gold, USD, tokenized stocks) are covered in universe.test. */
EXAMPLE.trader.assets = EXAMPLE.trader.assets.filter((a: { symbol: string }) => a.symbol === "BTC" || a.symbol === "ETH");
const TRADER: TraderConfig = parseTraderConfig(EXAMPLE.trader)!;
const CAP: number = EXAMPLE.moneyLab.inference.dailyCents;

function sonniConfig(): AutomatonConfig {
  const moneyLab = { ...EXAMPLE.moneyLab, runtime: "conway", telegram: null, inference: { ...EXAMPLE.moneyLab.inference, model: "gpt-5-mini" } };
  return applyTraderProfile(applyMoneyLabProfile(createTestConfig({ moneyLab, trader: EXAMPLE.trader, logLevel: "error" } as any)));
}

let tmpDirs: string[] = [];
function openDb(): AutomatonDatabase {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sonni-budget-"));
  tmpDirs.push(dir);
  const db = createDatabase(path.join(dir, "state.db"));
  ensureMoneyLabSchema(db.raw);
  ensureTraderSchema(db.raw);
  return db;
}
/**
 * Spend recorded two hours before the test's (fake) clock, on the same UTC day: SQLite's own
 * datetime('now') follows the real clock, which would put the row in the test's current hour (and
 * under the hourly cap) or not depending on when the suite runs.
 */
function spend(db: AutomatonDatabase, cents: number): void {
  const at = new Date(Date.now() - 2 * 3_600_000).toISOString().slice(0, 19).replace("T", " ");
  db.raw.prepare(
    `INSERT INTO inference_costs (id, session_id, turn_id, model, provider, input_tokens, output_tokens, cost_cents, latency_ms, tier, task_type, cache_hit, created_at)
     VALUES (?, 's', NULL, 'claude', 'anthropic', 1, 1, ?, 1, 'normal', 'agent_turn', 0, ?)`,
  ).run(`c_${Math.random().toString(36).slice(2)}`, cents, at);
}
async function runLoop(db: AutomatonDatabase, inference: MockInferenceClient): Promise<void> {
  await runAgentLoop({
    identity: createTestIdentity(), config: sonniConfig(), db, conway: new MockConwayClient(), inference,
    policyEngine: new PolicyEngine(db.raw, createDefaultRules()), spendTracker: new SpendTracker(db.raw),
  });
}
const sleepReply = () => toolCallResponse([{ name: "sleep", arguments: { duration_seconds: 3600, reason: "done" } }]);

// 10:00 UTC is noon in Paris in October: before the 19:30 evening turn.
const NOON = new Date("2026-10-08T10:00:00Z");
beforeEach(() => { tmpDirs = []; vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOON); });
afterEach(() => { vi.useRealTimers(); for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true }); });

describe("The evening turn's reserve", () => {
  it("blocks day-time spending within 40c of the cap until the evening turn is done, and never a small or absent cap", () => {
    const db = openDb();
    expect(CONSOLIDATION_RESERVE_CENTS).toBe(40);
    expect(consolidationTimeToday(TRADER, NOON)?.toISOString()).toBe("2026-10-08T17:30:00.000Z");
    expect(consolidationTimeToday(TRADER, new Date("2026-10-08T17:30:00Z"))).toBeNull();
    expect(reserveBlocks(db.raw, TRADER, 193, 152, NOON)).toBe(false);
    expect(reserveBlocks(db.raw, TRADER, 193, 153, NOON)).toBe(true);
    expect(reserveBlocks(db.raw, TRADER, null, 1000, NOON)).toBe(false);
    expect(reserveBlocks(db.raw, TRADER, 80, 79, NOON)).toBe(false);
    markConsolidationDone(db.raw, TRADER, NOON);
    expect(reserveBlocks(db.raw, TRADER, 193, 180, NOON)).toBe(false);
    db.close();
  });

  it("puts a day-time wake to sleep until the evening turn without a paid call, logs one incident a day", async () => {
    const db = openDb();
    spend(db, CAP - CONSOLIDATION_RESERVE_CENTS + 2);
    const inference = new MockInferenceClient([sleepReply()]);
    await runLoop(db, inference);
    expect(inference.calls.length).toBe(0);
    expect(db.getAgentState()).toBe("sleeping");
    expect(db.getKV("sleep_until")).toBe("2026-10-08T17:30:00.000Z");
    expect(db.getKV("sleep_reason")).toMatch(/réserve gardée pour l'autopsie du soir/);
    const second = new MockInferenceClient([sleepReply()]);
    await runLoop(db, second);
    expect(second.calls.length).toBe(0);
    const incidents = listIncidents(db.raw);
    expect(incidents.length).toBe(1);
    expect(incidents[0].kind).toBe("cap");
    expect(incidents[0].message).toBe("budget de la journée épuisé : 0,40 $ gardés pour l'autopsie du soir ; sommeil jusqu'à 19:30");
    // After the owner's midnight (22:30 UTC is 00:30 in Paris) the UTC day's spend still counts: sleep only until it resets.
    const late = openDb();
    vi.setSystemTime(new Date("2026-10-08T22:30:00Z"));
    spend(late, CAP - CONSOLIDATION_RESERVE_CENTS + 2);
    await runLoop(late, new MockInferenceClient([sleepReply()]));
    expect(late.getKV("sleep_until")).toBe("2026-10-09T00:00:00.000Z");
    late.close();
    db.close();
  });

  it("still answers the owner, and lets the evening turn spend the reserve", async () => {
    const db = openDb();
    spend(db, CAP - CONSOLIDATION_RESERVE_CENTS + 2);
    db.raw.prepare("INSERT INTO inbox_messages (id, from_address, content, received_at) VALUES ('m1', ?, 'tu es là ?', ?)")
      .run(OWNER_TELEGRAM_SENDER, NOON.toISOString());
    const owner = new MockInferenceClient([sleepReply()]);
    await runLoop(db, owner);
    expect(owner.calls.length).toBe(1);
    expect(JSON.stringify(owner.calls[0].messages)).toContain("tu es là ?");
    // 18:00 UTC is 20:00 in Paris: any wake after 19:30 is the evening turn, even without its wake event.
    vi.setSystemTime(new Date("2026-10-08T18:00:00Z"));
    const evening = new MockInferenceClient([sleepReply()]);
    await runLoop(db, evening);
    expect(evening.calls.length).toBe(1);
    expect(JSON.stringify(evening.calls[0].messages)).toContain("SONNI EVENING (required in this wake cycle");
    expect(consolidationDoneToday(db.raw, TRADER)).toBe(true);
    db.close();
  });
});

describe("A leaner prompt", () => {
  it("denies the automaton's leftover child, model, domain, goal and planner tools", () => {
    for (const name of ["list_children", "start_child", "fund_child", "switch_model", "check_inference_spending", "register_domain", "x402_fetch", "create_goal", "get_plan", "orchestrator_status", "system_synopsis"]) {
      expect(SONNI_DENIED_TOOLS.has(name)).toBe(true);
    }
  });

  it("sends only the last 8 to 11 turns of history", async () => {
    const db = openDb();
    for (let i = 0; i < 30; i++) {
      db.insertTurn({
        id: `t${String(i).padStart(3, "0")}`, timestamp: new Date(NOON.getTime() - (30 - i) * 60_000).toISOString(), state: "running",
        input: `marqueur-${i}`, inputSource: "agent", thinking: `pensée ${i}`, toolCalls: [], tokenUsage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, costCents: 0,
      } as any);
    }
    const inference = new MockInferenceClient([sleepReply()]);
    await runLoop(db, inference);
    const sent = JSON.stringify(inference.calls[0].messages);
    expect(sent).toContain("pensée 29");
    expect(sent).toContain("pensée 22");
    expect(sent).not.toContain("pensée 18");
    db.close();
  });
});
