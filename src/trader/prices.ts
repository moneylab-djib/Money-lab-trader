/**
 * Sonni price collection
 *
 * Fetches the last trade price of each configured asset from Kraken's
 * public market-data API (no key, no account) and stores it in
 * trader_prices. Runs from a runtime timer, without any inference.
 */

import type Database from "better-sqlite3";
import type { TraderConfig } from "./config.js";
import { fetchKrakenLast, FX_PAIR, quoteOf, storeFx, usdToEur } from "./markets.js";

type DB = Database.Database;
type FetchFn = typeof fetch;

export const KRAKEN_TICKER_URL = "https://api.kraken.com/0/public/Ticker";

export interface PricePoint {
  asset: string;
  ts: string;
  price: number;
}

/**
 * ISO timestamp to the second ("2026-10-06T21:00:00Z"). Every time Sonni
 * stores or compares is in this form, so text comparison orders correctly.
 */
export function isoSeconds(date: Date): string {
  return date.toISOString().slice(0, 19) + "Z";
}

export async function collectPrices(
  db: DB,
  cfg: TraderConfig,
  fetchFn: FetchFn = fetch,
  now: Date = new Date(),
): Promise<{ stored: number; errors: string[] }> {
  const ts = isoSeconds(now);
  const insert = db.prepare(
    "INSERT OR IGNORE INTO trader_prices (asset, ts, price, source) VALUES (?, ?, ?, 'kraken')",
  );
  let stored = 0;
  const errors: string[] = [];
  // USD-quoted pairs (tokenized stocks) are converted with Kraken's EUR/USD rate of the same collection.
  let eurUsd: number | null = null;
  if (cfg.assets.some((a) => quoteOf(a.krakenPair) === "USD")) {
    try {
      eurUsd = await fetchKrakenLast(FX_PAIR, fetchFn);
      storeFx(db, ts, eurUsd);
    } catch (err: any) {
      errors.push(`EUR/USD: ${String(err?.message ?? err)}`);
    }
  }
  for (const asset of cfg.assets) {
    try {
      const usd = quoteOf(asset.krakenPair) === "USD";
      if (usd && eurUsd === null) throw new Error(`Kraken ${asset.krakenPair}: no EUR/USD rate, price not stored`);
      const last = await fetchKrakenLast(asset.krakenPair, fetchFn);
      const price = usd ? usdToEur(last, eurUsd!) : last;
      stored += insert.run(asset.symbol, ts, price).changes;
    } catch (err: any) {
      errors.push(String(err?.message ?? err));
    }
  }
  return { stored, errors };
}

export function latestPrice(db: DB, asset: string): PricePoint | undefined {
  return db.prepare(
    "SELECT asset, ts, price FROM trader_prices WHERE asset = ? ORDER BY ts DESC LIMIT 1",
  ).get(asset) as PricePoint | undefined;
}

/** The latest price at or before a time (for indicators such as a 24 h change). */
export function priceAtOrBefore(db: DB, asset: string, ts: string): PricePoint | undefined {
  return db.prepare(
    "SELECT asset, ts, price FROM trader_prices WHERE asset = ? AND ts <= ? ORDER BY ts DESC LIMIT 1",
  ).get(asset, ts) as PricePoint | undefined;
}

/** The first price at or after a time, if it falls before a deadline. */
export function priceAtOrAfter(db: DB, asset: string, ts: string, notAfter: string): PricePoint | undefined {
  return db.prepare(
    "SELECT asset, ts, price FROM trader_prices WHERE asset = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC LIMIT 1",
  ).get(asset, ts, notAfter) as PricePoint | undefined;
}

/** Age of a price point in minutes. */
export function ageMinutes(point: PricePoint, now: Date): number {
  return (now.getTime() - Date.parse(point.ts)) / 60_000;
}
