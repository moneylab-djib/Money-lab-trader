/**
 * Sonni background work run by the runtime, without inference: price
 * collection, prediction resolution, and daily history with historical
 * tests. index.ts schedules them.
 */

import type Database from "better-sqlite3";
import type { TraderConfig } from "./config.js";
import { collectPrices } from "./prices.js";
import { resolveDuePredictions } from "./predictions.js";
import { collectCandles } from "./candles.js";
import { runAllHistoricalTests } from "./historical.js";

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
