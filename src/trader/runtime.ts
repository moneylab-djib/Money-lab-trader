/**
 * Sonni background work run by the runtime, without inference: price
 * collection and prediction resolution. index.ts schedules both.
 */

import type Database from "better-sqlite3";
import type { TraderConfig } from "./config.js";
import { collectPrices } from "./prices.js";
import { resolveDuePredictions } from "./predictions.js";

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
