/**
 * Sonni background work run by the runtime, without inference: price
 * collection, prediction resolution, daily history with historical tests,
 * the event calendar and headlines. index.ts schedules them.
 */

import type Database from "better-sqlite3";
import type { TraderConfig } from "./config.js";
import { collectPrices } from "./prices.js";
import { resolveDuePredictions } from "./predictions.js";
import { collectCandles } from "./candles.js";
import { runAllHistoricalTests, runEventRuleTests } from "./historical.js";
import { collectEvents } from "./events.js";
import { collectHeadlines } from "./news.js";
import { DIGEST_BATCH, digestHeadlines, type DigestOutcome } from "./readers.js";

type FetchFn = typeof fetch;

/**
 * Collect prices. The prices that arrived are stored first; any failed
 * asset then throws so the runtime logs it and records a health event.
 */
export async function collectTick(db: Database.Database, cfg: TraderConfig, fetchFn: FetchFn = fetch): Promise<number> {
  const { stored, errors } = await collectPrices(db, cfg, fetchFn);
  if (errors.length > 0) throw new Error(errors.join("; "));
  return stored;
}

/** Resolve due predictions; returns how many were resolved or voided. */
export function resolveTick(db: Database.Database, cfg: TraderConfig, now: Date = new Date()): number {
  return resolveDuePredictions(db, cfg, now).length;
}

/**
 * Refresh daily history, then re-test the hypotheses whose data moved.
 * Candles that arrived are kept even when one asset failed.
 */
export async function historyTick(db: Database.Database, cfg: TraderConfig, fetchFn: FetchFn = fetch): Promise<number> {
  const { errors } = await collectCandles(db, cfg, fetchFn);
  const tested = runAllHistoricalTests(db, cfg);
  if (errors.length > 0) throw new Error(errors.join("; "));
  return tested;
}

/** Refresh the event calendar (FOMC always, CPI and jobs with a FRED key). */
export async function calendarTick(db: Database.Database, fredApiKey: string | undefined, fetchFn: FetchFn = fetch): Promise<number> {
  const { stored, errors } = await collectEvents(db, fredApiKey, fetchFn);
  // Rules on event days must be re-tested once the calendar holds new days.
  if (stored > 0) runEventRuleTests(db);
  if (errors.length > 0) throw new Error(errors.join("; "));
  return stored;
}

/** Fetch new headlines; returns how many were new. */
export async function newsTick(db: Database.Database, fetchFn: FetchFn = fetch): Promise<number> {
  return collectHeadlines(db, fetchFn);
}

/** Batches digested per tick at most: a busy hour (up to 75 headlines) is covered without unbounded reader use. */
export const DIGEST_BATCHES_PER_TICK = 3;

/** Turn the undigested headlines into observations, through a free reader model, batch by batch. */
export async function digestTick(
  db: Database.Database,
  cfg: TraderConfig,
  env: NodeJS.ProcessEnv,
  fetchFn: FetchFn = fetch,
  now: Date = new Date(),
): Promise<DigestOutcome> {
  const total: DigestOutcome = { sent: 0, stored: 0, dropped: 0, readerId: null, skipped: null };
  for (let i = 0; i < DIGEST_BATCHES_PER_TICK; i++) {
    const r = await digestHeadlines(db, cfg, env, fetchFn, now);
    if (r.skipped) {
      if (total.sent === 0) total.skipped = r.skipped;
      break;
    }
    total.sent += r.sent;
    total.stored += r.stored;
    total.dropped += r.dropped;
    total.readerId = r.readerId;
    if (r.sent < DIGEST_BATCH) break;
  }
  return total;
}
