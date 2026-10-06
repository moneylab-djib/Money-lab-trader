/**
 * Sonni historical tests (docs/MEMORY.md section 4, step 2)
 *
 * Code evaluates each hypothesis that has a test rule on the stored daily
 * candles and appends the result to trader_historical_tests. This is
 * plain statistics on data, not the model predicting a past it remembers.
 * Forward confidence (resolved predictions) stays separate: history tells
 * Sonni which beliefs held before, predictions measure its own skill.
 */

import type Database from "better-sqlite3";
import { ulid } from "ulid";
import type { TraderConfig } from "./config.js";
import { loadDaily, type Candle } from "./candles.js";
import { eventDays } from "./events.js";
import { listHypotheses, type Hypothesis } from "./hypotheses.js";
import { evaluateRule, rulesAssets, type HistoricalVerdict, type RuleStats } from "./rules.js";

type DB = Database.Database;

export interface HistoricalTest extends RuleStats {
  hypothesisId: string;
  testedAt: string;
}

function loadCandles(db: DB, assets: string[]): Record<string, Candle[]> {
  return Object.fromEntries(assets.map((a) => [a, loadDaily(db, a)]));
}

/** Evaluate one hypothesis's rule and append the result. Returns null when it has no rule. */
export function runHistoricalTest(db: DB, hypothesis: Hypothesis, now: Date = new Date()): HistoricalTest | null {
  if (!hypothesis.testRule) return null;
  const stats = evaluateRule(hypothesis.testRule, loadCandles(db, rulesAssets(hypothesis.testRule)), eventDays(db));
  const testedAt = now.toISOString();
  db.prepare(
    `INSERT INTO trader_historical_tests (id, hypothesis_id, tested_at, data_from, data_to, cases, hits, rate,
       base_cases, base_rate, z, verdict) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(`t_${ulid()}`, hypothesis.id, testedAt, stats.dataFrom, stats.dataTo, stats.cases, stats.hits, stats.rate,
    stats.baseCases, stats.baseRate, stats.z, stats.verdict);
  return { ...stats, hypothesisId: hypothesis.id, testedAt };
}

/**
 * Re-test every active hypothesis with a rule, but only when the data has
 * moved since its last test (one new row per new day of history).
 */
export function runAllHistoricalTests(db: DB, _cfg: TraderConfig, now: Date = new Date()): number {
  let ran = 0;
  for (const h of listHypotheses(db)) {
    if (!h.testRule) continue;
    const last = latestHistoricalTest(db, h.id);
    const dataTo = latestDay(db, rulesAssets(h.testRule));
    if (last && last.dataTo === dataTo) continue;
    if (runHistoricalTest(db, h, now)) ran++;
  }
  return ran;
}

/** Re-test hypotheses whose rule uses the event calendar (after the calendar changed). */
export function runEventRuleTests(db: DB, now: Date = new Date()): number {
  let ran = 0;
  for (const h of listHypotheses(db)) {
    if (h.testRule?.when.some((c) => c.kind === "event") && runHistoricalTest(db, h, now)) ran++;
  }
  return ran;
}

function latestDay(db: DB, assets: string[]): string | null {
  const days = assets.map((a) => (db.prepare("SELECT MAX(day) AS d FROM trader_candles WHERE asset = ?").get(a) as { d: string | null }).d);
  if (days.some((d) => d === null)) return null;
  return days.sort()[0];
}

function rowToTest(row: any): HistoricalTest {
  return {
    hypothesisId: row.hypothesis_id,
    testedAt: row.tested_at,
    dataFrom: row.data_from,
    dataTo: row.data_to,
    cases: row.cases,
    hits: row.hits,
    rate: row.rate,
    baseCases: row.base_cases,
    baseRate: row.base_rate,
    z: row.z,
    verdict: row.verdict,
  };
}

export function latestHistoricalTest(db: DB, hypothesisId: string): HistoricalTest | undefined {
  const row = db.prepare(
    "SELECT * FROM trader_historical_tests WHERE hypothesis_id = ? ORDER BY tested_at DESC, id DESC LIMIT 1",
  ).get(hypothesisId);
  return row ? rowToTest(row) : undefined;
}

/** Counts of the latest verdicts across active hypotheses with a rule. */
export function verdictCounts(db: DB): Record<HistoricalVerdict, number> & { tested: number } {
  const counts = { supported: 0, refuted: 0, inconclusive: 0, insufficient: 0, tested: 0 };
  for (const h of listHypotheses(db)) {
    const t = latestHistoricalTest(db, h.id);
    if (!t) continue;
    counts[t.verdict]++;
    counts.tested++;
  }
  return counts;
}

/** One-line English summary for the model. */
export function describeTest(t: HistoricalTest): string {
  const pct = (x: number | null) => (x === null ? "n/a" : `${Math.round(x * 100)} %`);
  if (t.cases === 0) return `history: no case in ${t.dataFrom ?? "?"}..${t.dataTo ?? "?"} (insufficient)`;
  const base = t.baseCases === null ? "50 %" : `${pct(t.baseRate)} on all days`;
  return `history ${t.dataFrom}..${t.dataTo}: ${t.hits}/${t.cases} = ${pct(t.rate)} vs ${base}` +
    `${t.z === null ? "" : `, z=${t.z.toFixed(2)}`} -> ${t.verdict.toUpperCase()}`;
}
