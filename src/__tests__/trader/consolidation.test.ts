/**
 * Step C3: the evening consolidation, one paid turn a day in the owner's
 * evening: due from the configured local time once per local day, woken
 * through its own wake event, its instructions added by the loop, marked
 * done only after a paid turn, reported in the evening summary. No
 * network, no inference.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createDatabase, insertWakeEvent } from "../../state/database.js";
import { runAgentLoop } from "../../agent/loop.js";
import { PolicyEngine } from "../../agent/policy-engine.js";
import { SpendTracker } from "../../agent/spend-tracker.js";
import { createDefaultRules } from "../../agent/policy-rules/index.js";
import { ensureMoneyLabSchema, setKV } from "../../money-lab/journal.js";
import { applyMoneyLabProfile } from "../../money-lab/profile.js";
import type { AutomatonConfig, AutomatonDatabase } from "../../types.js";
import { applyTraderProfile, DEFAULT_CONSOLIDATION, parseTraderConfig, TraderConfigError, type TraderConfig } from "../../trader/config.js";
import { ensureTraderSchema } from "../../trader/schema.js";
import { isoSeconds } from "../../trader/prices.js";
import {
  consolidationDoneToday, consolidationDue, consolidationPending, consolidationStatusFr, markConsolidationDone, markConsolidationPending,
} from "../../trader/consolidation.js";
import { brokerTick } from "../../trader/portfolio.js";
import { buildSonniEveningSummary } from "../../trader/report.js";
import { createTestConfig, createTestIdentity, MockConwayClient, MockInferenceClient, toolCallResponse } from "../mocks.js";

const EXAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "..", "sonni", "automaton.sonni.example.json"), "utf-8"));
const TRADER: TraderConfig = parseTraderConfig(EXAMPLE.trader)!;

function sonniConfig(): AutomatonConfig {
  const moneyLab = { ...EXAMPLE.moneyLab, runtime: "conway", telegram: null, inference: { ...EXAMPLE.moneyLab.inference, model: "gpt-5-mini" } };
  return applyTraderProfile(applyMoneyLabProfile(createTestConfig({ moneyLab, trader: EXAMPLE.trader, logLevel: "error" } as any)));
}

let tmpDirs: string[] = [];
function openDb(): AutomatonDatabase {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sonni-evening-"));
  tmpDirs.push(dir);
  const db = createDatabase(path.join(dir, "state.db"));
  ensureMoneyLabSchema(db.raw);
  ensureTraderSchema(db.raw);
  return db;
}
beforeEach(() => { tmpDirs = []; });
afterEach(() => { vi.useRealTimers(); for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true }); });

describe("When the evening consolidation is due", () => {
  it("defaults to 19:30 in the owner's time zone, validates the setting, fires once per local day", () => {
    expect(TRADER.consolidation).toEqual(DEFAULT_CONSOLIDATION);
    expect(parseTraderConfig({ ...EXAMPLE.trader, consolidation: { hour: 21 } })!.consolidation).toEqual({ hour: 21, minute: 30 });
    expect(() => parseTraderConfig({ ...EXAMPLE.trader, consolidation: { hour: 24 } })).toThrow(TraderConfigError);
    expect(() => parseTraderConfig({ ...EXAMPLE.trader, consolidation: { at: "19:30" } })).toThrow(TraderConfigError);
    const db = openDb();
    // 17:29 UTC is 19:29 in Paris in October: not yet; 17:30 UTC is 19:30: due.
    expect(consolidationDue(db.raw, TRADER, new Date("2026-10-07T17:29:00Z"))).toBe(false);
    expect(consolidationDue(db.raw, TRADER, new Date("2026-10-07T17:30:00Z"))).toBe(true);
    expect(consolidationDue(db.raw, TRADER, new Date("2026-10-07T21:59:00Z"))).toBe(true);
    expect(consolidationStatusFr(db.raw, TRADER, new Date("2026-10-07T12:00:00Z"))).toBe("prévue à 19 h 30");
    expect(consolidationStatusFr(db.raw, TRADER, new Date("2026-10-07T18:00:00Z"))).toMatch(/^pas encore faite \(prévue à 19 h 30/);
    markConsolidationPending(db.raw, TRADER, new Date("2026-10-07T17:31:00Z"));
    expect(consolidationPending(db.raw, TRADER, new Date("2026-10-07T17:40:00Z"))).toBe(true);
    // A wake that only lands the next local day is dropped (22:30 UTC is 00:30 in Paris).
    expect(consolidationPending(db.raw, TRADER, new Date("2026-10-07T22:30:00Z"))).toBe(false);
    markConsolidationDone(db.raw, TRADER, new Date("2026-10-07T17:45:00Z"));
    expect(consolidationDoneToday(db.raw, TRADER, new Date("2026-10-07T17:46:00Z"))).toBe(true);
    expect(consolidationDue(db.raw, TRADER, new Date("2026-10-07T20:00:00Z"))).toBe(false);
    expect(consolidationStatusFr(db.raw, TRADER, new Date("2026-10-07T20:00:00Z"))).toBe("faite");
    expect(consolidationDue(db.raw, TRADER, new Date("2026-10-08T17:30:00Z"))).toBe(true);
    db.close();
  });
});

describe("The evening turn", () => {
  it("adds the evening instructions to the wake, is marked done after a paid turn, and shows in the summary", async () => {
    const db = openDb();
    const now = new Date();
    db.raw.prepare("INSERT INTO trader_prices (asset, ts, price, source) VALUES ('BTC', ?, 60000, 'test')").run(isoSeconds(now));
    brokerTick(db.raw, TRADER, now);
    markConsolidationPending(db.raw, TRADER, now);
    insertWakeEvent(db.raw, "sonni_evening", "evening consolidation due: the day's post-mortems");
    const inference = new MockInferenceClient([
      toolCallResponse([{ name: "write_reflection", arguments: { kind: "daily", content: "Journée calme : une prédiction prudente, rien à corriger ; demain je surveille la Fed." } }]),
      toolCallResponse([{ name: "sleep", arguments: { duration_seconds: 3600, reason: "done" } }]),
    ]);
    await runAgentLoop({
      identity: createTestIdentity(), config: sonniConfig(), db, conway: new MockConwayClient(), inference,
      policyEngine: new PolicyEngine(db.raw, createDefaultRules()), spendTracker: new SpendTracker(db.raw),
    });
    const first = JSON.stringify(inference.calls[0].messages);
    expect(first).toContain("SONNI EVENING (required in this wake cycle");
    expect(first).toContain("write_reflection kind postmortem");
    expect(first).toContain("Write the first dossier of every asset that has none yet");
    expect(consolidationDoneToday(db.raw, TRADER, now)).toBe(true);
    expect(db.raw.prepare("SELECT kind FROM trader_reflections").all()).toEqual([{ kind: "daily" }]);
    const summary = buildSonniEveningSummary(db.raw, TRADER, null, now);
    expect(summary).toContain("autopsie du soir : faite");
    expect(summary).toContain("Sa note du soir : Journée calme : une prédiction prudente");
    // Before 19:30 and without a wake delivered today the loop adds nothing (10:00 UTC is noon in Paris).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-08T10:00:00Z"));
    const quiet = openDb();
    const second = new MockInferenceClient([toolCallResponse([{ name: "sleep", arguments: { duration_seconds: 3600, reason: "done" } }])]);
    await runAgentLoop({
      identity: createTestIdentity(), config: sonniConfig(), db: quiet, conway: new MockConwayClient(), inference: second,
      policyEngine: new PolicyEngine(quiet.raw, createDefaultRules()), spendTracker: new SpendTracker(quiet.raw),
    });
    expect(JSON.stringify(second.calls[0].messages)).not.toContain("SONNI EVENING");
    expect(consolidationDoneToday(quiet.raw, TRADER)).toBe(false);
    vi.useRealTimers();
    db.close();
    quiet.close();
  });
});
