/**
 * The weekly screen (step 2 of the 2026-10-08 plan).
 *
 * Once a week, code reads Kraken's EUR spot pairs and tokenized stocks,
 * keeps the liquid ones Sonni does not follow (stablecoins excluded), and
 * measures each from its daily history: 30- and 90-day returns, position
 * against its 50-day average, volatility, correlation with BTC and the
 * highest correlation with the assets Sonni follows. Candidates are ranked
 * by how different they are from what Sonni already follows: an asset that
 * moves like BTC teaches it little (ETH/BTC: 0.90 over a year). The screen
 * is data for Sonni's choice of satellites (follow_asset), never an order;
 * it costs no inference. Rows are append-only (trader_screen).
 */

import type Database from "better-sqlite3";
import { ulid } from "ulid";
import { getKV, setKV } from "../money-lab/journal.js";
import type { TraderConfig } from "./config.js";
import { fetchKrakenDaily, loadDaily, type Candle } from "./candles.js";
import { fetchKrakenLast, fxOnOrBefore, FX_PAIR, latestFx, storeFxDaily, usdToEur } from "./markets.js";
import { krakenPairs, MIN_VOLUME_EUR, type KrakenPair } from "./universe.js";

type DB = Database.Database;
type FetchFn = typeof fetch;

export const SCREEN_EVERY_DAYS = 7;
/** The first screen waits this long after a start, so a restart loop never hammers Kraken. */
export const SCREEN_FIRST_DELAY_MINUTES = 60;
/** Candidates measured per screen (the most traded first): one daily-history request each. */
export const SCREEN_CANDIDATES = 15;
export const SCREEN_SHOWN = 6;
const KV_LAST = "sonni.screen_last_at";
const TICKER_CHUNK = 40;
const PAUSE_MS = 1_100;

const STABLES = new Set([
  "USDT", "USDC", "EURC", "DAI", "PYUSD", "USDG", "RLUSD", "TUSD", "FDUSD", "USDE", "EURT", "EURQ", "EURR", "USDQ", "USDR",
  "USD1", "GHO", "USDS", "EUROP", "EURCV", "USTC", "ZUSD", "ZEUR", "UST", "BUSD", "USDP", "EURE", "AEUR",
]);

export interface ScreenRow {
  screenId: string;
  at: string;
  asset: string;
  pair: string;
  volumeEur: number;
  ret30Pct: number | null;
  ret90Pct: number | null;
  aboveMa50: boolean | null;
  volPct: number | null;
  corrBtc: number | null;
  maxCorr: number | null;
  maxCorrWith: string | null;
  score: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function screenDue(db: DB, startedAt: Date, now: Date = new Date()): boolean {
  if (now.getTime() - startedAt.getTime() < SCREEN_FIRST_DELAY_MINUTES * 60_000) return false;
  const last = getKV(db, KV_LAST);
  return !last || now.getTime() - Date.parse(last) >= SCREEN_EVERY_DAYS * 86_400_000;
}

function stdev(v: number[]): number {
  const m = v.reduce((s, x) => s + x, 0) / v.length;
  return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1));
}

function pearson(a: number[], b: number[]): number | null {
  if (a.length < 20) return null;
  const ma = a.reduce((s, x) => s + x, 0) / a.length;
  const mb = b.reduce((s, x) => s + x, 0) / b.length;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : null;
}

/** Daily log returns by day, from traded days only (tokenized stocks show volume 0 on weekends). */
function returnsByDay(candles: Candle[]): Map<string, number> {
  const traded = candles.filter((c) => c.volume > 0 && c.close > 0);
  const out = new Map<string, number>();
  for (let i = 1; i < traded.length; i++) out.set(traded[i].day, Math.log(traded[i].close / traded[i - 1].close));
  return out;
}

/** Correlation of daily returns over the last `days` common days. */
export function correlation(a: Candle[], b: Candle[], days = 90): number | null {
  const ra = returnsByDay(a);
  const rb = returnsByDay(b);
  const common = [...ra.keys()].filter((d) => rb.has(d)).sort().slice(-days);
  return pearson(common.map((d) => ra.get(d)!), common.map((d) => rb.get(d)!));
}

export interface Measures {
  ret30Pct: number | null;
  ret90Pct: number | null;
  aboveMa50: boolean | null;
  volPct: number | null;
}

export function measure(candles: Candle[]): Measures {
  const closes = candles.filter((c) => c.volume > 0 && c.close > 0).map((c) => c.close);
  const last = closes.at(-1);
  const ret = (n: number) => (last !== undefined && closes.length > n ? (last / closes[closes.length - 1 - n] - 1) * 100 : null);
  const ma50 = closes.length >= 50 ? closes.slice(-50).reduce((s, c) => s + c, 0) / 50 : null;
  const logs = closes.slice(1).map((c, i) => Math.log(c / closes[i])).slice(-30);
  return {
    ret30Pct: ret(30),
    ret90Pct: ret(90),
    aboveMa50: ma50 === null || last === undefined ? null : last > ma50,
    volPct: logs.length >= 20 ? stdev(logs) * Math.sqrt(365) * 100 : null,
  };
}

async function tickerVolumes(pairs: KrakenPair[], eurUsd: number | null, fetchFn: FetchFn): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const byKey = new Map<string, KrakenPair>();
  for (const p of pairs) { byKey.set(p.key, p); byKey.set(p.altname, p); }
  for (const group of [pairs.filter((p) => !p.tokenized), pairs.filter((p) => p.tokenized)]) {
    for (let i = 0; i < group.length; i += TICKER_CHUNK) {
      const chunk = group.slice(i, i + TICKER_CHUNK);
      const query = `pair=${chunk.map((p) => encodeURIComponent(p.altname)).join(",")}${chunk[0].tokenized ? "&asset_class=tokenized_asset" : ""}`;
      const resp = await fetchFn(`https://api.kraken.com/0/public/Ticker?${query}`, { signal: AbortSignal.timeout(20_000) });
      if (!resp.ok) throw new Error(`Kraken Ticker: HTTP ${resp.status}`);
      const data = (await resp.json()) as { error?: string[]; result?: Record<string, { v?: unknown[]; p?: unknown[] }> };
      if (data.error && data.error.length > 0) throw new Error(`Kraken Ticker: ${data.error.join(", ")}`);
      for (const [key, t] of Object.entries(data.result ?? {})) {
        const p = byKey.get(key);
        const volume = Number(t?.v?.[1]) * Number(t?.p?.[1]);
        if (!p || !Number.isFinite(volume)) continue;
        if (p.quote === "USD" && eurUsd === null) continue;
        out.set(p.altname, p.quote === "USD" ? usdToEur(volume, eurUsd!) : volume);
      }
    }
  }
  return out;
}

/** Runs the screen and stores its rows; returns them best first. Never throws for one bad candidate. */
export async function runScreen(
  db: DB,
  cfg: TraderConfig,
  fetchFn: FetchFn = fetch,
  now: Date = new Date(),
  pause: (ms: number) => Promise<void> = sleep,
): Promise<{ rows: ScreenRow[]; errors: string[] }> {
  const errors: string[] = [];
  const pairs = await krakenPairs(db, fetchFn, now);
  const followed = new Set(cfg.assets.map((a) => a.krakenPair));
  const pool = pairs.filter((p) => !followed.has(p.altname) && !STABLES.has(p.base.toUpperCase()));
  let eurUsd = latestFx(db)?.eurUsd ?? null;
  if (eurUsd === null && pool.some((p) => p.quote === "USD")) {
    try {
      eurUsd = await fetchKrakenLast(FX_PAIR, fetchFn);
    } catch (err: any) {
      errors.push(`EUR/USD: ${String(err?.message ?? err)}`);
    }
  }
  const volumes = await tickerVolumes(pool, eurUsd, fetchFn);
  const candidates = pool
    .filter((p) => (volumes.get(p.altname) ?? 0) >= MIN_VOLUME_EUR)
    .sort((a, b) => volumes.get(b.altname)! - volumes.get(a.altname)!)
    .slice(0, SCREEN_CANDIDATES);
  if (candidates.some((c) => c.quote === "USD")) {
    try {
      const fx = await fetchKrakenDaily(FX_PAIR, fetchFn);
      db.transaction(() => { for (const c of fx) storeFxDaily(db, c.day, c.close); })();
    } catch (err: any) {
      errors.push(`EUR/USD daily: ${String(err?.message ?? err)}`);
    }
  }
  const btc = loadDaily(db, "BTC");
  const mine = cfg.assets.map((a) => ({ symbol: a.symbol, candles: loadDaily(db, a.symbol) }));
  const screenId = `s_${ulid()}`;
  const at = now.toISOString();
  const rows: ScreenRow[] = [];
  for (const c of candidates) {
    try {
      await pause(PAUSE_MS);
      let candles = await fetchKrakenDaily(c.altname, fetchFn);
      if (c.quote === "USD") {
        candles = candles.flatMap((k) => {
          const rate = fxOnOrBefore(db, k.day);
          return rate ? [{ ...k, open: k.open / rate, high: k.high / rate, low: k.low / rate, close: k.close / rate }] : [];
        });
      }
      const m = measure(candles);
      const corrBtc = btc.length ? correlation(candles, btc) : null;
      let maxCorr: number | null = null;
      let maxCorrWith: string | null = null;
      for (const f of mine) {
        const r = correlation(candles, f.candles);
        if (r !== null && (maxCorr === null || Math.abs(r) > Math.abs(maxCorr))) { maxCorr = r; maxCorrWith = f.symbol; }
      }
      rows.push({
        screenId, at, asset: c.base.replace(/^X(?=[A-Z]{3,})/, "").toUpperCase(), pair: c.altname, volumeEur: volumes.get(c.altname)!,
        ...m, corrBtc, maxCorr, maxCorrWith,
        // Different from what Sonni follows first; an unmeasurable correlation ranks last.
        score: maxCorr === null ? 0 : 1 - Math.abs(maxCorr),
      });
    } catch (err: any) {
      errors.push(`${c.altname}: ${String(err?.message ?? err).slice(0, 120)}`);
    }
  }
  rows.sort((a, b) => b.score - a.score || b.volumeEur - a.volumeEur);
  const insert = db.prepare(
    `INSERT INTO trader_screen (screen_id, at, asset, pair, volume_eur, ret30_pct, ret90_pct, above_ma50, vol_pct, corr_btc, max_corr, max_corr_with, score)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    for (const r of rows) {
      insert.run(r.screenId, r.at, r.asset, r.pair, r.volumeEur, r.ret30Pct, r.ret90Pct, r.aboveMa50 === null ? null : r.aboveMa50 ? 1 : 0,
        r.volPct, r.corrBtc, r.maxCorr, r.maxCorrWith, r.score);
    }
  })();
  setKV(db, KV_LAST, at);
  return { rows, errors };
}

export function latestScreen(db: DB): ScreenRow[] {
  const last = db.prepare("SELECT screen_id FROM trader_screen ORDER BY at DESC, rowid DESC LIMIT 1").get() as { screen_id: string } | undefined;
  if (!last) return [];
  return (db.prepare("SELECT * FROM trader_screen WHERE screen_id = ? ORDER BY score DESC, volume_eur DESC").all(last.screen_id) as any[]).map((r) => ({
    screenId: r.screen_id, at: r.at, asset: r.asset, pair: r.pair, volumeEur: r.volume_eur, ret30Pct: r.ret30_pct, ret90Pct: r.ret90_pct,
    aboveMa50: r.above_ma50 === null ? null : r.above_ma50 === 1, volPct: r.vol_pct, corrBtc: r.corr_btc, maxCorr: r.max_corr,
    maxCorrWith: r.max_corr_with, score: r.score,
  }));
}

const pctEn = (v: number | null) => (v === null ? "n/a" : `${v >= 0 ? "+" : ""}${v.toFixed(1)} %`);
const r2 = (v: number | null) => (v === null ? "n/a" : v.toFixed(2));
const millions = (v: number) => `${(v / 1e6).toFixed(1)} M EUR`;

/** For the memory pack (English). */
export function screenPackLines(db: DB, limit = SCREEN_SHOWN): string[] {
  const rows = latestScreen(db).slice(0, limit);
  if (rows.length === 0) return ["- no screen yet (code runs one a week)"];
  return rows.map((r) =>
    `- ${r.asset} (${r.pair}): ${millions(r.volumeEur)}/day, 30 d ${pctEn(r.ret30Pct)}, 90 d ${pctEn(r.ret90Pct)}, ` +
    `${r.aboveMa50 === null ? "trend n/a" : r.aboveMa50 ? "above" : "below"} its 50-day average, volatility ${r.volPct === null ? "n/a" : `${r.volPct.toFixed(0)} %/yr`}, ` +
    `corr BTC ${r2(r.corrBtc)}, highest with yours ${r2(r.maxCorr)}${r.maxCorrWith ? ` (${r.maxCorrWith})` : ""}`);
}

const pctFr = (v: number | null) => (v === null ? "n.d." : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1).replace(".", ",")} %`);

/** For the owner (/actifs), in French. */
export function formatScreenFr(db: DB, limit = 5): string {
  const rows = latestScreen(db).slice(0, limit);
  if (rows.length === 0) return "Crible de la semaine : pas encore fait (le code le fait une fois par semaine).";
  const lines = [`Crible du ${rows[0].at.slice(0, 10)} (calculé par le code ; les plus différents de ce que Sonni suit déjà) :`];
  for (const r of rows) {
    lines.push(`- ${r.asset} (${r.pair}) : ${(r.volumeEur / 1e6).toFixed(1).replace(".", ",")} M€ échangés par jour, 90 jours ${pctFr(r.ret90Pct)}, ` +
      `corrélation avec ce qu'il suit au plus ${r.maxCorr === null ? "n.d." : r.maxCorr.toFixed(2).replace(".", ",")}`);
  }
  return lines.join("\n");
}
