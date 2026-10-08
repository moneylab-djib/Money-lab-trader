/**
 * Market odds and the prediction snapshot (step 1 of the 2026-10-08 plan).
 *
 * Before Sonni states a probability, code tells it how far a threshold is
 * and how often a move that large happens: the distance in % and in units
 * of the asset's recent volatility over the horizon, a reference
 * probability from a driftless random walk at that volatility, and the
 * share of past windows of the same length that moved that far. The same
 * numbers are stored with every prediction (append-only), so post-mortems
 * cite code's figures (2026-10-07: the model wrote "margin ~27 %" for
 * 2.7 %) and the self-report can compare Sonni's Brier score with the
 * reference's: skill above zero means it beats the random walk.
 */

import type Database from "better-sqlite3";
import { loadDaily } from "./candles.js";
import { latestPrice } from "./prices.js";

type DB = Database.Database;

/** Daily returns used for the volatility (about six weeks of trading). */
export const VOL_DAYS = 30;
/** History searched for the empirical share of windows. */
export const HISTORY_DAYS = 730;
const MIN_RETURNS = 20;
const MIN_WINDOWS = 100;

export interface Odds {
  asset: string;
  price: number;
  priceTs: string;
  threshold: number;
  direction: "above" | "below";
  horizonHours: number;
  /** (threshold / price - 1) in %. */
  distancePct: number;
  /** Standard deviation of daily log returns over VOL_DAYS, in %. */
  dailyVolPct: number;
  /** Distance as a multiple of the volatility over the horizon (log scale). */
  sigmas: number;
  /** Probability of the event under a driftless random walk at that volatility. */
  refProbability: number;
  /** Share of past windows of the horizon's length (whole days) that ended past the threshold's distance. */
  historicalShare: number | null;
  historicalWindows: number;
}

/** Standard normal cumulative distribution (Abramowitz-Stegun 7.1.26, error below 1.5e-7). */
export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

function std(values: number[]): number {
  const m = values.reduce((s, v) => s + v, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1));
}

/**
 * Code's odds for "asset above/below threshold in horizonHours", from the
 * latest stored price and the stored daily closes. Null when there is no
 * price or fewer than 20 daily returns.
 */
export function marketOdds(db: DB, asset: string, direction: "above" | "below", threshold: number, horizonHours: number): Odds | null {
  const last = latestPrice(db, asset);
  if (!last || !(threshold > 0) || !(horizonHours > 0)) return null;
  // Traded days only: tokenized stocks show volume 0 on weekends, which would read as days without moves.
  const closes = loadDaily(db, asset).filter((c) => c.close > 0 && c.volume > 0).slice(-(HISTORY_DAYS + 1)).map((c) => c.close);
  if (closes.length < MIN_RETURNS + 1) return null;
  const logReturns = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
  const dailyVol = std(logReturns.slice(-VOL_DAYS));
  const x = Math.log(threshold / last.price);
  const horizonVol = dailyVol * Math.sqrt(horizonHours / 24);
  const sigmas = horizonVol > 0 ? x / horizonVol : Infinity * Math.sign(x);
  const refProbability = horizonVol > 0 ? (direction === "above" ? 1 - normalCdf(sigmas) : normalCdf(sigmas)) : (direction === "above" ? (x < 0 ? 1 : 0) : (x > 0 ? 1 : 0));
  // Empirical share over whole-day windows (a window shorter than a day uses one day).
  const k = Math.max(1, Math.round(horizonHours / 24));
  let hits = 0;
  let windows = 0;
  for (let i = 0; i + k < closes.length; i++) {
    const r = Math.log(closes[i + k] / closes[i]);
    windows++;
    if (direction === "above" ? r > x : r < x) hits++;
  }
  return {
    asset,
    price: last.price,
    priceTs: last.ts,
    threshold,
    direction,
    horizonHours,
    distancePct: (threshold / last.price - 1) * 100,
    dailyVolPct: dailyVol * 100,
    sigmas,
    refProbability,
    historicalShare: windows >= MIN_WINDOWS ? hits / windows : null,
    historicalWindows: windows,
  };
}

const signed = (v: number, digits = 2) => `${v >= 0 ? "+" : ""}${v.toFixed(digits)}`;

/** For the model (tool results and the pack), in English. */
export function describeOdds(o: Odds): string {
  return `${o.asset} at ${o.price} EUR (${o.priceTs}): ${o.direction} ${o.threshold} EUR is ${signed(o.distancePct)} % away, ` +
    `${signed(o.sigmas)} σ over ${o.horizonHours} h (volatility ${o.dailyVolPct.toFixed(2)} %/day over ${VOL_DAYS} days); ` +
    `reference probability ${Math.round(o.refProbability * 100)} % (random walk at that volatility)` +
    (o.historicalShare !== null ? `; ${Math.round(o.historicalShare * 100)} % of ${o.historicalWindows} past ${Math.max(1, Math.round(o.horizonHours / 24))}-day windows moved that far.` : ".");
}

/** Stores the odds at the time a prediction is recorded (append-only). */
export function recordPredictionSnapshot(db: DB, predictionId: string, o: Odds, now: Date = new Date()): void {
  db.prepare(
    `INSERT OR IGNORE INTO trader_prediction_snapshots (prediction_id, price, distance_pct, daily_vol_pct, sigmas, ref_probability,
       historical_share, historical_windows, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(predictionId, o.price, o.distancePct, o.dailyVolPct, Number.isFinite(o.sigmas) ? o.sigmas : null, o.refProbability,
    o.historicalShare, o.historicalWindows, now.toISOString());
}

export interface SnapshotRow {
  predictionId: string;
  distancePct: number;
  dailyVolPct: number;
  sigmas: number | null;
  refProbability: number;
  historicalShare: number | null;
}

export function getPredictionSnapshot(db: DB, predictionId: string): SnapshotRow | undefined {
  const r = db.prepare("SELECT * FROM trader_prediction_snapshots WHERE prediction_id = ?").get(predictionId) as any;
  return r ? {
    predictionId: r.prediction_id, distancePct: r.distance_pct, dailyVolPct: r.daily_vol_pct, sigmas: r.sigmas,
    refProbability: r.ref_probability, historicalShare: r.historical_share,
  } : undefined;
}

export interface SkillWindow {
  n: number;
  brier: number | null;
  refBrier: number | null;
  /** 1 - brier / refBrier: above 0 beats the random walk, below 0 does worse. */
  skill: number | null;
}

/** Sonni's Brier against the reference's on the scored predictions that have a snapshot, resolved in [from, to). */
export function skillBetween(db: DB, from: string | null, to: string | null): SkillWindow {
  const rows = db.prepare(
    `SELECT p.brier AS brier, p.outcome AS outcome, s.ref_probability AS ref FROM trader_predictions p
     JOIN trader_prediction_snapshots s ON s.prediction_id = p.id
     WHERE p.brier IS NOT NULL ${from ? "AND p.resolved_at >= @from" : ""} ${to ? "AND p.resolved_at < @to" : ""}`,
  ).all({ ...(from ? { from } : {}), ...(to ? { to } : {}) }) as { brier: number; outcome: number; ref: number }[];
  if (rows.length === 0) return { n: 0, brier: null, refBrier: null, skill: null };
  const brier = rows.reduce((s, r) => s + r.brier, 0) / rows.length;
  const refBrier = rows.reduce((s, r) => s + (r.ref - r.outcome) ** 2, 0) / rows.length;
  return { n: rows.length, brier, refBrier, skill: refBrier > 0 ? 1 - brier / refBrier : null };
}
