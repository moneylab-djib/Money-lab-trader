/**
 * Sonni predictions (docs/MEMORY.md sections 3.1 and 5)
 *
 * A prediction is written before its outcome is known and never edited
 * (append-only, see schema.ts). It states one event that its linked
 * hypothesis implies: "<asset> above/below <threshold> EUR at <horizon>",
 * with a probability. At the horizon, code reads the first stored price
 * and resolves it: outcome, Brier score, and one evidence row for the
 * hypothesis (support if the event happened, contradict otherwise).
 */

import type Database from "better-sqlite3";
import { ulid } from "ulid";
import type { TraderConfig } from "./config.js";
import { getHypothesis, refreshHypothesis } from "./hypotheses.js";
import { marketOdds, recordPredictionSnapshot, type Odds } from "./snapshot.js";
import { ageMinutes, isoSeconds, latestPrice, priceAtOrAfter } from "./prices.js";

type DB = Database.Database;

export const DIRECTIONS = ["above", "below"] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const MIN_HORIZON_HOURS = 1;
export const MAX_HORIZON_HOURS = 24 * 90;
const MAX_TEXT = 2000;

export interface PredictionInput {
  asset: string;
  direction: string;
  threshold: number;
  horizonHours: number;
  probability: number;
  hypothesisId: string;
  statement: string;
  rationale: string;
}

export interface Prediction {
  id: string;
  madeAt: string;
  asset: string;
  direction: Direction;
  threshold: number;
  referencePrice: number;
  referenceTs: string;
  horizonUntil: string;
  probability: number;
  hypothesisId: string;
  statement: string;
  rationale: string;
  resolvedAt: string | null;
  outcome: 0 | 1 | null;
  resolutionPrice: number | null;
  resolutionTs: string | null;
  brier: number | null;
  voidReason: string | null;
}

function rowToPrediction(row: any): Prediction {
  return {
    id: row.id,
    madeAt: row.made_at,
    asset: row.asset,
    direction: row.direction,
    threshold: row.threshold,
    referencePrice: row.reference_price,
    referenceTs: row.reference_ts,
    horizonUntil: row.horizon_until,
    probability: row.probability,
    hypothesisId: row.hypothesis_id,
    statement: row.statement,
    rationale: row.rationale,
    resolvedAt: row.resolved_at,
    outcome: row.outcome,
    resolutionPrice: row.resolution_price,
    resolutionTs: row.resolution_ts,
    brier: row.brier,
    voidReason: row.void_reason,
  };
}

export type RecordResult = { ok: true; prediction: Prediction; odds: Odds | null } | { ok: false; error: string };

/**
 * Validate and record a prediction. Refused when a field is missing or
 * out of range, when the hypothesis is unknown or retired, or when the
 * asset's latest price is older than the configured staleness limit.
 */
export function recordPrediction(db: DB, cfg: TraderConfig, input: PredictionInput, now: Date = new Date()): RecordResult {
  const asset = String(input.asset ?? "").trim().toUpperCase();
  if (!cfg.assets.some((a) => a.symbol === asset)) {
    return { ok: false, error: `Unknown asset "${input.asset}". Followed assets: ${cfg.assets.map((a) => a.symbol).join(", ")}.` };
  }
  if (!DIRECTIONS.includes(input.direction as Direction)) {
    return { ok: false, error: 'direction must be "above" or "below".' };
  }
  const threshold = Number(input.threshold);
  if (!Number.isFinite(threshold) || threshold <= 0) return { ok: false, error: "threshold must be a positive price in EUR." };
  const horizonHours = Number(input.horizonHours);
  if (!Number.isFinite(horizonHours) || horizonHours < MIN_HORIZON_HOURS || horizonHours > MAX_HORIZON_HOURS) {
    return { ok: false, error: `horizon_hours must be between ${MIN_HORIZON_HOURS} and ${MAX_HORIZON_HOURS}.` };
  }
  const probability = Number(input.probability);
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    return { ok: false, error: "probability must be a number between 0 and 1." };
  }
  const statement = String(input.statement ?? "").trim();
  const rationale = String(input.rationale ?? "").trim();
  if (!statement || statement.length > MAX_TEXT) return { ok: false, error: `statement is required (at most ${MAX_TEXT} characters).` };
  if (!rationale || rationale.length > MAX_TEXT) return { ok: false, error: `rationale is required (at most ${MAX_TEXT} characters).` };

  const hypothesis = getHypothesis(db, String(input.hypothesisId ?? ""));
  if (!hypothesis) return { ok: false, error: `Unknown hypothesis_id "${input.hypothesisId}". Link the prediction to an existing hypothesis.` };
  if (hypothesis.status === "retired") return { ok: false, error: `Hypothesis ${hypothesis.id} is retired.` };

  const latest = latestPrice(db, asset);
  if (!latest) return { ok: false, error: `No price stored yet for ${asset}; wait for the next collection.` };
  const age = ageMinutes(latest, now);
  if (age > cfg.staleMinutes) {
    return {
      ok: false,
      error: `The latest ${asset} price is ${Math.round(age)} minutes old (limit ${cfg.staleMinutes}). ` +
        "No prediction on stale prices; wait for fresh data.",
    };
  }

  const id = `p_${ulid()}`;
  const madeAt = isoSeconds(now);
  const horizonUntil = isoSeconds(new Date(now.getTime() + horizonHours * 3_600_000));
  db.prepare(
    `INSERT INTO trader_predictions (id, made_at, asset, direction, threshold, reference_price, reference_ts,
       horizon_until, probability, hypothesis_id, statement, rationale)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, madeAt, asset, input.direction, threshold, latest.price, latest.ts, horizonUntil, probability,
    hypothesis.id, statement, rationale);
  // Code's odds at the moment of the prediction, kept with it for post-mortems and the skill score.
  const odds = marketOdds(db, asset, input.direction as Direction, threshold, horizonHours);
  if (odds) recordPredictionSnapshot(db, id, odds, now);
  return { ok: true, prediction: getPrediction(db, id)!, odds };
}

export function getPrediction(db: DB, id: string): Prediction | undefined {
  const row = db.prepare("SELECT * FROM trader_predictions WHERE id = ?").get(id);
  return row ? rowToPrediction(row) : undefined;
}

export function listOpenPredictions(db: DB): Prediction[] {
  return (db.prepare(
    "SELECT * FROM trader_predictions WHERE resolved_at IS NULL ORDER BY horizon_until ASC",
  ).all() as any[]).map(rowToPrediction);
}

export function listResolvedPredictions(db: DB, limit: number): Prediction[] {
  return (db.prepare(
    "SELECT * FROM trader_predictions WHERE resolved_at IS NOT NULL ORDER BY resolved_at DESC, id DESC LIMIT ?",
  ).all(limit) as any[]).map(rowToPrediction);
}

/** Count and mean Brier score of scored (non-void) predictions. */
export function brierSummary(db: DB): { scored: number; meanBrier: number | null } {
  const row = db.prepare(
    "SELECT COUNT(*) AS n, AVG(brier) AS mean FROM trader_predictions WHERE brier IS NOT NULL",
  ).get() as { n: number; mean: number | null };
  return { scored: row.n, meanBrier: row.mean };
}

/**
 * Resolve every prediction whose horizon has passed. The resolution price
 * is the first stored price at or after the horizon, no later than
 * staleMinutes after it. When no such price exists and that window has
 * closed, the prediction is voided (no score, no evidence) rather than
 * judged on a price from another time.
 */
export function resolveDuePredictions(db: DB, cfg: TraderConfig, now: Date = new Date()): Prediction[] {
  const nowIso = isoSeconds(now);
  const due = (db.prepare(
    "SELECT * FROM trader_predictions WHERE resolved_at IS NULL AND horizon_until <= ? ORDER BY horizon_until ASC",
  ).all(nowIso) as any[]).map(rowToPrediction);

  const resolved: Prediction[] = [];
  const setOutcome = db.prepare(
    `UPDATE trader_predictions SET resolved_at = ?, outcome = ?, resolution_price = ?, resolution_ts = ?, brier = ?
     WHERE id = ? AND resolved_at IS NULL`,
  );
  const setVoid = db.prepare(
    "UPDATE trader_predictions SET resolved_at = ?, void_reason = ? WHERE id = ? AND resolved_at IS NULL",
  );
  const addEvidence = db.prepare(
    `INSERT INTO trader_hypothesis_evidence (id, hypothesis_id, prediction_id, kind, source, recorded_at)
     VALUES (?, ?, ?, ?, 'forward', ?)`,
  );

  for (const p of due) {
    const deadline = isoSeconds(new Date(Date.parse(p.horizonUntil) + cfg.staleMinutes * 60_000));
    const point = priceAtOrAfter(db, p.asset, p.horizonUntil, deadline);
    if (!point) {
      if (nowIso > deadline) {
        setVoid.run(nowIso, `no ${p.asset} price between ${p.horizonUntil} and ${deadline}`, p.id);
        resolved.push(getPrediction(db, p.id)!);
      }
      continue;
    }
    const outcome: 0 | 1 = (p.direction === "above" ? point.price > p.threshold : point.price < p.threshold) ? 1 : 0;
    const brier = (p.probability - outcome) ** 2;
    db.transaction(() => {
      const changed = setOutcome.run(nowIso, outcome, point.price, point.ts, brier, p.id).changes;
      if (changed === 0) return;
      addEvidence.run(`e_${ulid()}`, p.hypothesisId, p.id, outcome === 1 ? "support" : "contradict", nowIso);
      refreshHypothesis(db, p.hypothesisId);
    })();
    resolved.push(getPrediction(db, p.id)!);
  }
  return resolved;
}
