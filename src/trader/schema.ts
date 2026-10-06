/**
 * Sonni storage
 *
 * Tables added to the existing state database (docs/MEMORY.md). Only the
 * stores the first slice needs exist so far: prices, hypotheses,
 * predictions and hypothesis evidence.
 *
 * Integrity (docs/MEMORY.md section 7): predictions and evidence are
 * append-only. Triggers refuse any delete, and any update of a prediction
 * except the single resolution write done by code. These triggers live in
 * the database, so they hold for every code path in this process; they do
 * not stop someone with shell access from dropping them (known limitation,
 * acceptable while no money is at stake).
 */

import type Database from "better-sqlite3";

type DB = Database.Database;

/** Columns of trader_predictions that never change after insertion. */
const IMMUTABLE_PREDICTION_COLUMNS = [
  "id", "made_at", "asset", "direction", "threshold", "reference_price", "reference_ts",
  "horizon_until", "probability", "hypothesis_id", "statement", "rationale",
];

export function ensureTraderSchema(db: DB): void {
  const changed = IMMUTABLE_PREDICTION_COLUMNS.map((c) => `NEW.${c} IS NOT OLD.${c}`).join(" OR ");
  db.exec(`
    CREATE TABLE IF NOT EXISTS trader_prices (
      asset TEXT NOT NULL,
      ts TEXT NOT NULL,
      price REAL NOT NULL CHECK (price > 0),
      source TEXT NOT NULL,
      PRIMARY KEY (asset, ts)
    );

    CREATE TABLE IF NOT EXISTS trader_hypotheses (
      id TEXT PRIMARY KEY,
      statement TEXT NOT NULL,
      origin TEXT NOT NULL CHECK (origin IN ('prior', 'observation', 'owner', 'review')),
      status TEXT NOT NULL CHECK (status IN ('untested', 'testing', 'supported', 'refuted', 'retired')),
      supports INTEGER NOT NULL DEFAULT 0,
      contradicts INTEGER NOT NULL DEFAULT 0,
      confidence REAL NOT NULL DEFAULT 0.5,
      valid_from TEXT,
      valid_to TEXT,
      recorded_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trader_predictions (
      id TEXT PRIMARY KEY,
      made_at TEXT NOT NULL,
      asset TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('above', 'below')),
      threshold REAL NOT NULL CHECK (threshold > 0),
      reference_price REAL NOT NULL,
      reference_ts TEXT NOT NULL,
      horizon_until TEXT NOT NULL,
      probability REAL NOT NULL CHECK (probability >= 0 AND probability <= 1),
      hypothesis_id TEXT NOT NULL REFERENCES trader_hypotheses(id),
      statement TEXT NOT NULL,
      rationale TEXT NOT NULL,
      resolved_at TEXT,
      outcome INTEGER CHECK (outcome IN (0, 1)),
      resolution_price REAL,
      resolution_ts TEXT,
      brier REAL,
      void_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_trader_predictions_open ON trader_predictions (resolved_at, horizon_until);

    CREATE TABLE IF NOT EXISTS trader_hypothesis_evidence (
      id TEXT PRIMARY KEY,
      hypothesis_id TEXT NOT NULL REFERENCES trader_hypotheses(id),
      prediction_id TEXT NOT NULL UNIQUE REFERENCES trader_predictions(id),
      kind TEXT NOT NULL CHECK (kind IN ('support', 'contradict')),
      source TEXT NOT NULL CHECK (source IN ('forward', 'historical')),
      recorded_at TEXT NOT NULL
    );

    CREATE TRIGGER IF NOT EXISTS trader_predictions_no_delete
      BEFORE DELETE ON trader_predictions
      BEGIN SELECT RAISE(ABORT, 'trader_predictions is append-only'); END;

    CREATE TRIGGER IF NOT EXISTS trader_predictions_resolve_once
      BEFORE UPDATE ON trader_predictions
      WHEN OLD.resolved_at IS NOT NULL OR ${changed}
      BEGIN SELECT RAISE(ABORT, 'trader_predictions is append-only'); END;

    CREATE TRIGGER IF NOT EXISTS trader_evidence_no_update
      BEFORE UPDATE ON trader_hypothesis_evidence
      BEGIN SELECT RAISE(ABORT, 'trader_hypothesis_evidence is append-only'); END;

    CREATE TRIGGER IF NOT EXISTS trader_evidence_no_delete
      BEFORE DELETE ON trader_hypothesis_evidence
      BEGIN SELECT RAISE(ABORT, 'trader_hypothesis_evidence is append-only'); END;
  `);
}

/** True once ensureTraderSchema has run on this database. */
export function hasTraderSchema(db: DB): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'trader_predictions'").get();
}
