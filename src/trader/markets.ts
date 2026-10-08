/**
 * Kraken markets beyond EUR spot pairs (step 2 of the 2026-10-08 plan).
 *
 * Kraken lists tokenized US stocks (xStocks, for example SPYxUSD, NVDAxUSD)
 * in a separate asset class, quoted in USD only: Ticker, OHLC and Depth need
 * `asset_class=tokenized_asset`, or Kraken answers "Unknown asset pair"
 * (checked against the public API on 2026-10-08, docs/RESEARCH.md 5.3).
 * Sonni keeps everything in EUR: code converts USD prices with Kraken's own
 * EUR/USD pair (EURUSD: dollars per euro), stored in trader_fx (every
 * collection) and trader_fx_daily (daily closes), so the rest of the code
 * (predictions, broker, odds, cycles) never sees a dollar.
 */

import type Database from "better-sqlite3";

type DB = Database.Database;
type FetchFn = typeof fetch;

export const KRAKEN_TICKER = "https://api.kraken.com/0/public/Ticker";
export const KRAKEN_OHLC = "https://api.kraken.com/0/public/OHLC";
/** Kraken's EUR/USD pair: the price is in dollars per euro (about 1.16 in October 2026). */
export const FX_PAIR = "EURUSD";
const FETCH_TIMEOUT_MS = 15_000;

/** Tokenized stocks are named `<TICKER>x<QUOTE>` on Kraken, with a lower-case x: SPYxUSD. */
const TOKENIZED = /^[A-Z0-9]{1,12}x(USD|EUR)$/;

export function isTokenizedPair(pair: string): boolean {
  return TOKENIZED.test(pair);
}

export function quoteOf(pair: string): "EUR" | "USD" {
  return /USD$/.test(pair) ? "USD" : "EUR";
}

/** Query string for Ticker, OHLC and Depth. */
export function pairQuery(pair: string): string {
  return `pair=${encodeURIComponent(pair)}${isTokenizedPair(pair) ? "&asset_class=tokenized_asset" : ""}`;
}

/** Last trade price of one pair, in its quote currency. */
export async function fetchKrakenLast(pair: string, fetchFn: FetchFn = fetch): Promise<number> {
  const resp = await fetchFn(`${KRAKEN_TICKER}?${pairQuery(pair)}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`Kraken ${pair}: HTTP ${resp.status}`);
  const data = (await resp.json()) as { error?: string[]; result?: Record<string, { c?: unknown[] }> };
  if (data.error && data.error.length > 0) throw new Error(`Kraken ${pair}: ${data.error.join(", ")}`);
  // Kraken answers with its own key for the pair (XBTEUR -> XXBTZEUR); one pair per request.
  const entries = Object.values(data.result ?? {});
  if (entries.length !== 1) throw new Error(`Kraken ${pair}: unexpected result`);
  const price = Number(entries[0]?.c?.[0]);
  if (!Number.isFinite(price) || price <= 0) throw new Error(`Kraken ${pair}: invalid price`);
  return price;
}

export function storeFx(db: DB, ts: string, eurUsd: number): void {
  db.prepare("INSERT OR IGNORE INTO trader_fx (ts, eurusd) VALUES (?, ?)").run(ts, eurUsd);
}

export function latestFx(db: DB): { ts: string; eurUsd: number } | undefined {
  const row = db.prepare("SELECT ts, eurusd FROM trader_fx ORDER BY ts DESC LIMIT 1").get() as { ts: string; eurusd: number } | undefined;
  return row ? { ts: row.ts, eurUsd: row.eurusd } : undefined;
}

export function storeFxDaily(db: DB, day: string, eurUsd: number): void {
  db.prepare("INSERT INTO trader_fx_daily (day, eurusd) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET eurusd = excluded.eurusd").run(day, eurUsd);
}

/** The EUR/USD daily close of a day, or of the closest earlier day (weekends, gaps). */
export function fxOnOrBefore(db: DB, day: string): number | undefined {
  const row = db.prepare("SELECT eurusd FROM trader_fx_daily WHERE day <= ? ORDER BY day DESC LIMIT 1").get(day) as { eurusd: number } | undefined;
  return row?.eurusd;
}

/** A USD amount in EUR at a dollars-per-euro rate. */
export function usdToEur(usd: number, eurUsd: number): number {
  return usd / eurUsd;
}
