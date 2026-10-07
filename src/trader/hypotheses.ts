/**
 * Sonni hypotheses ("intuitions", docs/MEMORY.md section 4)
 *
 * Confidence is computed by code from evidence, never written by the
 * model: a Beta(1 + supports, 1 + contradicts) posterior mean, with a
 * status that moves only when the numbers agree.
 */

import type Database from "better-sqlite3";
import { ulid } from "ulid";

type DB = Database.Database;

export const HYPOTHESIS_ORIGINS = ["prior", "observation", "owner", "review"] as const;
export type HypothesisOrigin = (typeof HYPOTHESIS_ORIGINS)[number];
export type HypothesisStatus = "untested" | "testing" | "supported" | "refuted" | "retired";

/** Resolved instances needed before a hypothesis can be called supported or refuted. */
export const MIN_INSTANCES = 8;
export const SUPPORTED_AT = 0.65;
export const REFUTED_AT = 0.35;

export interface Hypothesis {
  id: string;
  statement: string;
  origin: HypothesisOrigin;
  status: HypothesisStatus;
  supports: number;
  contradicts: number;
  confidence: number;
  recordedAt: string;
}

function rowToHypothesis(row: any): Hypothesis {
  return {
    id: row.id,
    statement: row.statement,
    origin: row.origin,
    status: row.status,
    supports: row.supports,
    contradicts: row.contradicts,
    confidence: row.confidence,
    recordedAt: row.recorded_at,
  };
}

/** Posterior mean and status for a count of supporting and contradicting evidence. */
export function computeConfidence(supports: number, contradicts: number): { confidence: number; status: HypothesisStatus } {
  const n = supports + contradicts;
  const confidence = (supports + 1) / (n + 2);
  if (n === 0) return { confidence, status: "untested" };
  if (n < MIN_INSTANCES) return { confidence, status: "testing" };
  if (confidence >= SUPPORTED_AT) return { confidence, status: "supported" };
  if (confidence <= REFUTED_AT) return { confidence, status: "refuted" };
  return { confidence, status: "testing" };
}

export function addHypothesis(
  db: DB,
  input: { statement: string; origin: HypothesisOrigin },
  now: Date = new Date(),
): Hypothesis {
  const statement = input.statement.trim();
  if (statement.length < 10 || statement.length > 1000) {
    throw new Error("Une intuition doit faire entre 10 et 1000 caractères.");
  }
  if (!HYPOTHESIS_ORIGINS.includes(input.origin)) throw new Error(`Origine inconnue : ${input.origin}`);
  const id = `h_${ulid()}`;
  const at = now.toISOString();
  db.prepare(
    `INSERT INTO trader_hypotheses (id, statement, origin, status, supports, contradicts, confidence, valid_from, recorded_at)
     VALUES (?, ?, ?, 'untested', 0, 0, 0.5, ?, ?)`,
  ).run(id, statement, input.origin, at, at);
  return getHypothesis(db, id)!;
}

export function getHypothesis(db: DB, id: string): Hypothesis | undefined {
  const row = db.prepare("SELECT * FROM trader_hypotheses WHERE id = ?").get(id);
  return row ? rowToHypothesis(row) : undefined;
}

/** Active hypotheses (not retired), most evidence first. */
export function listHypotheses(db: DB): Hypothesis[] {
  return (db.prepare(
    "SELECT * FROM trader_hypotheses WHERE status != 'retired' ORDER BY (supports + contradicts) DESC, recorded_at ASC",
  ).all() as any[]).map(rowToHypothesis);
}

/** Recompute a hypothesis from its evidence rows (the only writer of confidence). */
export function refreshHypothesis(db: DB, id: string): Hypothesis | undefined {
  const counts = db.prepare(
    `SELECT COALESCE(SUM(kind = 'support'), 0) AS supports, COALESCE(SUM(kind = 'contradict'), 0) AS contradicts
     FROM trader_hypothesis_evidence WHERE hypothesis_id = ?`,
  ).get(id) as { supports: number; contradicts: number };
  const current = getHypothesis(db, id);
  if (!current || current.status === "retired") return current;
  const { confidence, status } = computeConfidence(counts.supports, counts.contradicts);
  db.prepare(
    "UPDATE trader_hypotheses SET supports = ?, contradicts = ?, confidence = ?, status = ? WHERE id = ?",
  ).run(counts.supports, counts.contradicts, confidence, status, id);
  return getHypothesis(db, id);
}
