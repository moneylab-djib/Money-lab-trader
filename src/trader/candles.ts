/**
 * Sonni daily history
 *
 * Daily candles from Kraken's public OHLC endpoint (no key). Kraken returns
 * up to 720 daily candles, about two years; the last one is the current,
 * unfinished day and is skipped (Kraken marks the last committed candle
 * with `last`). Used only by code: historical tests and indicators.
 */

import type Database from "better-sqlite3";
import type { TraderConfig } from "./config.js";
import { fxOnOrBefore, FX_PAIR, pairQuery, quoteOf, storeFxDaily } from "./markets.js";

type DB = Database.Database;
type FetchFn = typeof fetch;

export const KRAKEN_OHLC_URL = "https://api.kraken.com/0/public/OHLC";
const FETCH_TIMEOUT_MS = 20_000;

export interface Candle {
  day: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function dayOf(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

export async function fetchKrakenDaily(pair: string, fetchFn: FetchFn): Promise<Candle[]> {
  const resp = await fetchFn(`${KRAKEN_OHLC_URL}?${pairQuery(pair)}&interval=1440`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`Kraken OHLC ${pair}: HTTP ${resp.status}`);
  const data = (await resp.json()) as { error?: string[]; result?: Record<string, unknown> };
  if (data.error && data.error.length > 0) throw new Error(`Kraken OHLC ${pair}: ${data.error.join(", ")}`);
  const result = data.result ?? {};
  const keys = Object.keys(result).filter((k) => k !== "last");
  if (keys.length !== 1 || !Array.isArray(result[keys[0]])) throw new Error(`Kraken OHLC ${pair}: unexpected result`);
  const last = Number(result.last);
  const rows = result[keys[0]] as unknown[][];
  const candles: Candle[] = [];
  for (const row of rows) {
    const time = Number(row[0]);
    // Candles after `last` are not committed yet (the current day).
    if (!Number.isFinite(time) || (Number.isFinite(last) && time > last)) continue;
    const [open, high, low, close] = [row[1], row[2], row[3], row[4]].map(Number);
    const volume = Number(row[6]);
    // A price of 0 or less is no price: rules divide by the open and the close (step 0.3).
    if (![open, high, low, close, volume].every(Number.isFinite) || Math.min(open, high, low, close) <= 0) continue;
    candles.push({ day: dayOf(time), open, high, low, close, volume });
  }
  return candles;
}

/** Fetch and store daily candles for every followed asset; returns rows written. */
export async function collectCandles(
  db: DB,
  cfg: TraderConfig,
  fetchFn: FetchFn = fetch,
): Promise<{ stored: number; errors: string[] }> {
  const upsert = db.prepare(
    `INSERT INTO trader_candles (asset, day, open, high, low, close, volume, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'kraken')
     ON CONFLICT(asset, day) DO UPDATE SET open = excluded.open, high = excluded.high, low = excluded.low,
       close = excluded.close, volume = excluded.volume`,
  );
  let stored = 0;
  const errors: string[] = [];
  // USD-quoted pairs: daily EUR/USD closes first, then each day converted at its own rate.
  let fxReady = false;
  if (cfg.assets.some((a) => quoteOf(a.krakenPair) === "USD")) {
    try {
      const fx = await fetchKrakenDaily(FX_PAIR, fetchFn);
      db.transaction(() => { for (const c of fx) storeFxDaily(db, c.day, c.close); })();
      fxReady = fx.length > 0;
    } catch (err: any) {
      errors.push(`EUR/USD daily: ${String(err?.message ?? err)}`);
    }
  }
  for (const asset of cfg.assets) {
    try {
      const usd = quoteOf(asset.krakenPair) === "USD";
      if (usd && !fxReady) throw new Error(`Kraken OHLC ${asset.krakenPair}: no EUR/USD history, candles not stored`);
      const candles = await fetchKrakenDaily(asset.krakenPair, fetchFn);
      db.transaction(() => {
        for (const c of candles) {
          const rate = usd ? fxOnOrBefore(db, c.day) : 1;
          if (!rate) continue;
          stored += upsert.run(asset.symbol, c.day, c.open / rate, c.high / rate, c.low / rate, c.close / rate, c.volume).changes;
        }
      })();
    } catch (err: any) {
      errors.push(String(err?.message ?? err));
    }
  }
  return { stored, errors };
}

/** Stored daily candles of an asset, oldest first. */
export function loadDaily(db: DB, asset: string): Candle[] {
  return db.prepare(
    "SELECT day, open, high, low, close, volume FROM trader_candles WHERE asset = ? ORDER BY day ASC",
  ).all(asset) as Candle[];
}

/** Number of stored days per asset. */
export function candleCounts(db: DB): Record<string, number> {
  const rows = db.prepare("SELECT asset, COUNT(*) AS n FROM trader_candles GROUP BY asset").all() as { asset: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.asset, r.n]));
}
