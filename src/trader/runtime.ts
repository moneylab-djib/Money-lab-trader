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
import { getKV, setKV } from "../money-lab/journal.js";
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
export const NEWS_INTERVAL_MS = 60 * 60_000;
/** After a failed fetch (GDELT rate-limits with HTTP 429 or plain text), the next tries come sooner. */
export const NEWS_RETRY_MINUTES = [5, 10, 20, 30];
const KV_NEWS_NEXT = "sonni.news_next_at";
const KV_NEWS_FAILURES = "sonni.news_failures";

export interface NewsOutcome {
  fetched: boolean;
  added: number;
  nextAt: string;
  /** Sources that failed while at least one answered (logged, no backoff). */
  errors: string[];
}

/**
 * Fetch headlines (GDELT and the RSS feeds) when due: an hour after a
 * success, 5, 10, 20 then 30 minutes after a failure of every source. The
 * schedule lives in the database, so a restart (which runs every tick at
 * once) does not call the sources again within minutes. A failure is
 * rethrown, with the next try, after it is scheduled.
 */
export async function newsTick(db: Database.Database, fetchFn: FetchFn = fetch, now: Date = new Date()): Promise<NewsOutcome> {
  const nextAt = getKV(db, KV_NEWS_NEXT) ?? "";
  if (nextAt && now.toISOString() < nextAt) return { fetched: false, added: 0, nextAt, errors: [] };
  try {
    const r = await collectHeadlines(db, fetchFn, now);
    if (r.ok.length === 0) throw new Error(r.errors.join(" ; "));
    const next = new Date(now.getTime() + NEWS_INTERVAL_MS).toISOString();
    setKV(db, KV_NEWS_NEXT, next);
    setKV(db, KV_NEWS_FAILURES, "0");
    return { fetched: true, added: r.added, nextAt: next, errors: r.errors };
  } catch (err: any) {
    const failures = Number(getKV(db, KV_NEWS_FAILURES) ?? "0") + 1;
    const minutes = NEWS_RETRY_MINUTES[Math.min(failures, NEWS_RETRY_MINUTES.length) - 1];
    setKV(db, KV_NEWS_NEXT, new Date(now.getTime() + minutes * 60_000).toISOString());
    setKV(db, KV_NEWS_FAILURES, String(failures));
    throw new Error(`${err?.message ?? err} ; prochain essai dans ${minutes} min`);
  }
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
