/**
 * Market regimes and similar past situations (plan of 2026-10-08 step 4).
 *
 * Research of 2026-10-08 (docs/RESEARCH.md 5.1): retrieving past cases by
 * market indicators beat text similarity for financial episodes (META,
 * 2026-09), and old lessons mislead after a regime change (Agentic Trading
 * survey, 2026-05). So code describes each asset's regime from its daily
 * closes (trend against the 50-day average, volatility against its own
 * year) and finds the past days whose indicators look most like today's,
 * with what happened in the 7 days after them. Embargo: only days whose
 * next 7 days are already stored count, so nothing is read from the
 * future. All numbers are code's.
 */

import type Database from "better-sqlite3";
import { loadDaily, type Candle } from "./candles.js";

type DB = Database.Database;

export const ANALOG_K = 5;
export const FORWARD_DAYS = 7;
const MIN_HISTORY = 120;

export interface Regime {
  trend: "up" | "down" | "range";
  vol: "high" | "normal" | "low";
}

function traded(candles: Candle[]): Candle[] {
  return candles.filter((c) => c.close > 0 && c.volume > 0);
}

function stdev(v: number[]): number {
  const m = v.reduce((s, x) => s + x, 0) / v.length;
  return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, v.length - 1));
}

/** Regime at the candle of index i (needs 70 earlier candles), from closes only. */
function regimeAtIndex(closes: number[], i: number): Regime | null {
  if (i < 70) return null;
  const ma = (end: number) => closes.slice(end - 49, end + 1).reduce((s, c) => s + c, 0) / 50;
  const now = ma(i);
  const before = ma(i - 20);
  const trend = closes[i] > now && now > before ? "up" : closes[i] < now && now < before ? "down" : "range";
  const vols: number[] = [];
  for (let j = Math.max(30, i - 365); j <= i; j++) {
    const rets = closes.slice(j - 29, j + 1).map((c, k, a) => (k === 0 ? 0 : Math.log(c / a[k - 1]))).slice(1);
    vols.push(stdev(rets));
  }
  const current = vols.at(-1)!;
  const rank = vols.filter((v) => v <= current).length / vols.length;
  return { trend, vol: rank >= 0.7 ? "high" : rank <= 0.3 ? "low" : "normal" };
}

/** The regime of an asset on a day (the last traded day at or before it), or null without enough history. */
export function regimeAt(db: DB, asset: string, day: string): Regime | null {
  const c = traded(loadDaily(db, asset)).filter((x) => x.day <= day);
  return regimeAtIndex(c.map((x) => x.close), c.length - 1);
}

export function describeRegime(r: Regime | null): string {
  if (!r) return "regime n/a";
  return `${r.trend === "range" ? "range-bound" : `${r.trend}-trend`}, ${r.vol} volatility`;
}

export function describeRegimeFr(r: Regime | null): string {
  if (!r) return "régime inconnu";
  const trend = r.trend === "up" ? "tendance haussière" : r.trend === "down" ? "tendance baissière" : "sans tendance";
  const vol = r.vol === "high" ? "volatilité forte" : r.vol === "low" ? "volatilité faible" : "volatilité normale";
  return `${trend}, ${vol}`;
}

interface Features { day: string; i: number; f: number[] }

function features(closes: number[], days: string[]): Features[] {
  const out: Features[] = [];
  for (let i = 50; i < closes.length; i++) {
    const r = (n: number) => Math.log(closes[i] / closes[i - n]);
    const rets = closes.slice(i - 29, i + 1).map((c, k, a) => (k === 0 ? 0 : Math.log(c / a[k - 1]))).slice(1);
    const ma50 = closes.slice(i - 49, i + 1).reduce((s, c) => s + c, 0) / 50;
    out.push({ day: days[i], i, f: [r(1), r(7), r(30), stdev(rets), closes[i] / ma50 - 1] });
  }
  return out;
}

export interface Analog { day: string; distance: number; forwardPct: number }
export interface AnalogSummary { asset: string; asOf: string; regime: Regime | null; analogs: Analog[]; up: number; medianPct: number | null }

/**
 * The ANALOG_K past days most like the latest one (standardized distance over 1-, 7- and 30-day returns,
 * 30-day volatility and distance to the 50-day average), at least a week apart, each with its next
 * FORWARD_DAYS return. Null without enough history.
 */
export function similarSituations(db: DB, asset: string): AnalogSummary | null {
  const c = traded(loadDaily(db, asset));
  if (c.length < MIN_HISTORY) return null;
  const closes = c.map((x) => x.close);
  const feats = features(closes, c.map((x) => x.day));
  const today = feats.at(-1)!;
  // Embargo: a candidate's next FORWARD_DAYS must already be stored.
  const pool = feats.filter((x) => x.i + FORWARD_DAYS <= c.length - 1);
  if (pool.length < ANALOG_K * 3) return null;
  const dims = today.f.length;
  const mean = Array.from({ length: dims }, (_, d) => pool.reduce((s, x) => s + x.f[d], 0) / pool.length);
  const sd = Array.from({ length: dims }, (_, d) => stdev(pool.map((x) => x.f[d])) || 1);
  const z = (f: number[]) => f.map((v, d) => (v - mean[d]) / sd[d]);
  const t = z(today.f);
  const ranked = pool
    .map((x) => ({ x, distance: Math.sqrt(z(x.f).reduce((s, v, d) => s + (v - t[d]) ** 2, 0)) }))
    .sort((a, b) => a.distance - b.distance);
  const picked: { x: Features; distance: number }[] = [];
  for (const r of ranked) {
    if (picked.every((p) => Math.abs(p.x.i - r.x.i) >= 7)) picked.push(r);
    if (picked.length === ANALOG_K) break;
  }
  const analogs = picked.map((p) => ({ day: p.x.day, distance: p.distance, forwardPct: (closes[p.x.i + FORWARD_DAYS] / closes[p.x.i] - 1) * 100 }));
  const sorted = analogs.map((a) => a.forwardPct).sort((a, b) => a - b);
  return {
    asset,
    asOf: today.day,
    regime: regimeAtIndex(closes, closes.length - 1),
    analogs,
    up: analogs.filter((a) => a.forwardPct > 0).length,
    medianPct: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
  };
}

const signed = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)} %`;

/** For the memory pack (English). */
export function analogLine(s: AnalogSummary): string {
  return `- ${s.asset} (${s.asOf}, ${describeRegime(s.regime)}): of the ${s.analogs.length} most similar past days, ${s.up} rose over the next ` +
    `${FORWARD_DAYS} days, median ${s.medianPct === null ? "n/a" : signed(s.medianPct)} (${s.analogs.map((a) => `${a.day} ${signed(a.forwardPct)}`).join(", ")})`;
}
