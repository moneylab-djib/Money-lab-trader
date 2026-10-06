/**
 * Sonni intake (docs/MEMORY.md section 4, step 1)
 *
 * Once daily history is stored, Sonni turns what it already knows about
 * markets into hypotheses with propose_hypothesis; code tests each rule on
 * history at once. The intake runs on the stronger model for its first
 * turns (like Money Lab's weekly review) and is repeated on later wakes
 * until enough prior hypotheses exist, at most MAX_INTAKE_ATTEMPTS times.
 */

import type Database from "better-sqlite3";
import type { TraderConfig } from "./config.js";
import { candleCounts } from "./candles.js";
import { hypothesisCounts } from "./hypotheses.js";
import { getKV, setKV } from "../money-lab/journal.js";

type DB = Database.Database;

/** Intake is complete once this many prior hypotheses exist. */
export const INTAKE_MIN_PRIOR = 30;
export const MAX_PRIOR_HYPOTHESES = 120;
export const MAX_INTAKE_ATTEMPTS = 3;
/** Turns of each intake wake that use the stronger model. */
export const INTAKE_MODEL_TURNS = 8;
/** Minimum daily candles per asset before history is worth testing against. */
export const MIN_HISTORY_DAYS = 200;
/** Hypotheses the model may add per UTC day outside the intake. */
export const MAX_MODEL_HYPOTHESES_PER_DAY = 10;

const KV_ATTEMPTS = "sonni.intake_attempts";

export function intakeAttempts(db: DB): number {
  return Number(getKV(db, KV_ATTEMPTS) ?? "0");
}

export function historyReady(db: DB, cfg: TraderConfig): boolean {
  const counts = candleCounts(db);
  return cfg.assets.every((a) => (counts[a.symbol] ?? 0) >= MIN_HISTORY_DAYS);
}

/** True while the intake should run on the next wake. */
export function intakeDue(db: DB, cfg: TraderConfig): boolean {
  const prior = hypothesisCounts(db).byOrigin.prior ?? 0;
  return prior < INTAKE_MIN_PRIOR && intakeAttempts(db) < MAX_INTAKE_ATTEMPTS && historyReady(db, cfg);
}

const KV_OPEN = "sonni.intake_open";

/** True during an intake wake: hypotheses proposed now are prior knowledge. */
export function intakeOpen(db: DB): boolean {
  return getKV(db, KV_OPEN) === "1";
}

/** Opens an intake wake; the attempt counts only once a paid turn runs (recordIntakeAttempt). */
export function startIntake(db: DB): void {
  setKV(db, KV_OPEN, "1");
}

export function recordIntakeAttempt(db: DB): void {
  setKV(db, KV_ATTEMPTS, String(intakeAttempts(db) + 1));
}

export function closeIntakeWake(db: DB): void {
  setKV(db, KV_OPEN, "0");
}

export const SONNI_INTAKE_INSTRUCTIONS = `SONNI INTAKE (required in this wake cycle, before anything else):
You already know a lot about crypto markets. Turn that knowledge into testable hypotheses with
propose_hypothesis, so that code can check which of your beliefs held on about two years of daily
Kraken history. Aim for 40 to 80, up to 10 propose_hypothesis calls per turn (the runtime runs at most
10 tool calls per turn), over as many turns as needed.
1. Cover different families: reaction after large daily moves (continuation or reversal), streaks,
   volatility clustering (big days followed by big days), weekday effects, volume spikes, the
   BTC-ETH relationship (who leads, who moves more), and moves around Fed, US inflation and US jobs
   days (event conditions; combine types, one type alone gives few cases).
2. Give each one a clear statement and, when the rule language can express it, a test_rule. Code tests
   it at once and tells you the result. Knowledge the rules cannot express (central banks, regulation,
   halvings, news) is welcome without a test_rule: your future predictions will test it.
3. Every hypothesis you submit is kept, refuted ones included. Do not resubmit variants of a refuted
   idea to fish for a good result: with many tries, about 1 in 100 passes by chance.
4. When done, send the owner a short summary in French with message_owner: how many hypotheses, how
   many history supports, refutes or cannot decide, and the two or three that surprised you. Then
   continue with a normal session.`;
