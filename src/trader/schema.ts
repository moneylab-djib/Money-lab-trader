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

import { ensureMemoryIndex } from "./memory.js";
import type Database from "better-sqlite3";

type DB = Database.Database;

/** Columns of trader_predictions that never change after insertion. */
const IMMUTABLE_PREDICTION_COLUMNS = [
  "id", "made_at", "asset", "direction", "threshold", "reference_price", "reference_ts",
  "horizon_until", "probability", "hypothesis_id", "statement", "rationale",
];

/**
 * Step 4 B (virtual portfolio, docs/MEMORY.md and ARCHITECTURE.md): the
 * cash ledger, orders, positions, closed trades, traps and daily equity
 * snapshots. The model inserts orders and traps; code alone fills orders
 * (one transition out of "pending"), moves cash, closes trades and takes
 * snapshots. Nothing is ever deleted.
 */
/**
 * Databases created before step 4 B have trader_reflections without the
 * 'trade' kind in its CHECK; SQLite cannot alter a CHECK, so the table is
 * rebuilt once, rows and append-only triggers kept.
 */
function migrateReflectionKinds(db: DB): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'trader_reflections'").get() as { sql: string } | undefined;
  if (!row || row.sql.includes("'trade'")) return;
  db.exec(`
    DROP TRIGGER IF EXISTS trader_reflections_no_update;
    DROP TRIGGER IF EXISTS trader_reflections_no_delete;
    DROP INDEX IF EXISTS idx_trader_reflections_subject;
    ALTER TABLE trader_reflections RENAME TO trader_reflections_old;
    CREATE TABLE trader_reflections (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('postmortem', 'trade', 'session', 'daily', 'weekly')),
      subject_id TEXT,
      content TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    );
    INSERT INTO trader_reflections (id, kind, subject_id, content, recorded_at)
      SELECT id, kind, subject_id, content, recorded_at FROM trader_reflections_old;
    DROP TABLE trader_reflections_old;
    CREATE INDEX IF NOT EXISTS idx_trader_reflections_subject ON trader_reflections (subject_id);
    ${appendOnly("trader_reflections")}
  `);
}

/** Step C2: reactions measured by code around events, and the cycles the model names on them. */
function ensureCycleSchema(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trader_reactions (
      type TEXT NOT NULL,
      day TEXT NOT NULL,
      asset TEXT NOT NULL,
      window TEXT NOT NULL CHECK (window IN ('run_up', 'day', 'week', 'hour')),
      return_pct REAL NOT NULL,
      computed_at TEXT NOT NULL,
      PRIMARY KEY (type, day, asset, window)
    );
    ${appendOnly("trader_reactions")}

    CREATE TABLE IF NOT EXISTS trader_patterns (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      asset TEXT NOT NULL,
      window TEXT NOT NULL CHECK (window IN ('run_up', 'day', 'week', 'hour')),
      direction TEXT NOT NULL CHECK (direction IN ('up', 'down', 'big_move')),
      threshold_pct REAL,
      note TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    );
    ${appendOnly("trader_patterns")}
  `);
}

/** Step C1: asset dossiers (versioned) and the owner's notes. */
function ensureDossierSchema(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trader_dossiers (
      id TEXT PRIMARY KEY,
      asset TEXT NOT NULL,
      version INTEGER NOT NULL,
      content TEXT NOT NULL,
      reason TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('model', 'owner')),
      recorded_at TEXT NOT NULL,
      UNIQUE (asset, version)
    );
    ${appendOnly("trader_dossiers")}

    CREATE TABLE IF NOT EXISTS trader_owner_notes (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      text TEXT NOT NULL,
      assets TEXT NOT NULL
    );
    ${appendOnly("trader_owner_notes")}
  `);
}

/** Guard G9: the incident log, written by code only. */
function ensureGuardSchema(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trader_incidents (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      kind TEXT NOT NULL,
      message TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trader_incidents_at ON trader_incidents (at);
    ${appendOnly("trader_incidents")}
  `);
}

function ensurePortfolioSchema(db: DB): void {
  migrateReflectionKinds(db);
  const ORDER_FIXED = ["id", "placed_at", "asset", "side", "kind", "amount_eur", "quantity", "limit_price", "thesis", "probability",
    "invalidation", "horizon_until", "hypothesis_ids", "origin"];
  const orderChanged = ORDER_FIXED.map((c) => `NEW.${c} IS NOT OLD.${c}`).join(" OR ");
  db.exec(`
    CREATE TABLE IF NOT EXISTS trader_ledger (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('capital', 'contribution', 'buy', 'sell')),
      asset TEXT,
      quantity REAL,
      price REAL,
      amount_eur REAL NOT NULL,
      fee_eur REAL NOT NULL DEFAULT 0,
      order_id TEXT,
      note TEXT
    );
    ${appendOnly("trader_ledger")}
    CREATE INDEX IF NOT EXISTS idx_trader_ledger_at ON trader_ledger (at);

    CREATE TABLE IF NOT EXISTS trader_orders (
      id TEXT PRIMARY KEY,
      placed_at TEXT NOT NULL,
      asset TEXT NOT NULL,
      side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
      kind TEXT NOT NULL CHECK (kind IN ('market', 'limit')),
      amount_eur REAL,
      quantity REAL,
      limit_price REAL,
      thesis TEXT NOT NULL,
      probability REAL,
      invalidation REAL,
      horizon_until TEXT NOT NULL,
      hypothesis_ids TEXT NOT NULL DEFAULT '[]',
      origin TEXT NOT NULL CHECK (origin IN ('model', 'stop', 'owner')),
      status TEXT NOT NULL CHECK (status IN ('pending', 'filled', 'cancelled', 'rejected', 'expired')),
      settled_at TEXT,
      fill_price REAL,
      fill_quantity REAL,
      fill_eur REAL,
      fee_eur REAL,
      slippage_eur REAL,
      note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_trader_orders_pending ON trader_orders (status, asset);
    CREATE TRIGGER IF NOT EXISTS trader_orders_no_delete BEFORE DELETE ON trader_orders
      BEGIN SELECT RAISE(ABORT, 'trader_orders is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS trader_orders_settle_once BEFORE UPDATE ON trader_orders
      WHEN OLD.status != 'pending' OR NEW.status = 'pending' OR ${orderChanged}
      BEGIN SELECT RAISE(ABORT, 'trader_orders is append-only'); END;

    CREATE TABLE IF NOT EXISTS trader_positions (
      asset TEXT PRIMARY KEY,
      quantity REAL NOT NULL CHECK (quantity >= 0),
      avg_cost REAL NOT NULL,
      opened_at TEXT NOT NULL,
      open_order_id TEXT NOT NULL,
      invalidation REAL,
      horizon_until TEXT,
      thesis TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trader_position_updates (
      id TEXT PRIMARY KEY,
      asset TEXT NOT NULL,
      at TEXT NOT NULL,
      field TEXT NOT NULL CHECK (field IN ('invalidation', 'horizon_until')),
      old_value TEXT,
      new_value TEXT,
      reason TEXT NOT NULL,
      by TEXT NOT NULL CHECK (by IN ('model', 'code'))
    );
    ${appendOnly("trader_position_updates")}

    CREATE TABLE IF NOT EXISTS trader_trades (
      id TEXT PRIMARY KEY,
      asset TEXT NOT NULL,
      opened_at TEXT NOT NULL,
      closed_at TEXT NOT NULL,
      quantity REAL NOT NULL,
      entry_price REAL NOT NULL,
      exit_price REAL NOT NULL,
      fees_eur REAL NOT NULL,
      pnl_eur REAL NOT NULL,
      pnl_pct REAL NOT NULL,
      open_order_id TEXT NOT NULL,
      close_order_id TEXT NOT NULL,
      close_reason TEXT NOT NULL CHECK (close_reason IN ('model', 'stop')),
      thesis TEXT NOT NULL
    );
    ${appendOnly("trader_trades")}
    CREATE INDEX IF NOT EXISTS idx_trader_trades_closed ON trader_trades (closed_at);

    CREATE TABLE IF NOT EXISTS trader_traps (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      warning_signs TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    );
    ${appendOnly("trader_traps")}
    CREATE TABLE IF NOT EXISTS trader_trap_hits (
      id TEXT PRIMARY KEY,
      trap_id TEXT NOT NULL REFERENCES trader_traps(id),
      trade_id TEXT NOT NULL REFERENCES trader_trades(id),
      note TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    );
    ${appendOnly("trader_trap_hits")}

    CREATE TABLE IF NOT EXISTS trader_portfolio_days (
      day TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      cash_eur REAL NOT NULL,
      positions_eur REAL NOT NULL,
      equity_eur REAL NOT NULL,
      contributed_eur REAL NOT NULL
    );
    ${appendOnly("trader_portfolio_days")}
  `);
}

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
  ensureKnowledgeSchema(db);
}

/**
 * Second slice ("Sonni already knows things"): daily candles, test rules
 * on hypotheses, and the history of code-run historical tests.
 */
function ensureKnowledgeSchema(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trader_candles (
      asset TEXT NOT NULL,
      day TEXT NOT NULL,
      open REAL NOT NULL,
      high REAL NOT NULL,
      low REAL NOT NULL,
      close REAL NOT NULL CHECK (close > 0),
      volume REAL NOT NULL,
      source TEXT NOT NULL,
      PRIMARY KEY (asset, day)
    );

    CREATE TABLE IF NOT EXISTS trader_historical_tests (
      id TEXT PRIMARY KEY,
      hypothesis_id TEXT NOT NULL REFERENCES trader_hypotheses(id),
      tested_at TEXT NOT NULL,
      data_from TEXT,
      data_to TEXT,
      cases INTEGER NOT NULL,
      hits INTEGER NOT NULL,
      rate REAL,
      base_cases INTEGER,
      base_rate REAL,
      z REAL,
      verdict TEXT NOT NULL CHECK (verdict IN ('supported', 'refuted', 'inconclusive', 'insufficient'))
    );
    CREATE INDEX IF NOT EXISTS idx_trader_historical_tests ON trader_historical_tests (hypothesis_id, tested_at);

    CREATE TRIGGER IF NOT EXISTS trader_historical_tests_no_update
      BEFORE UPDATE ON trader_historical_tests
      BEGIN SELECT RAISE(ABORT, 'trader_historical_tests is append-only'); END;

    CREATE TRIGGER IF NOT EXISTS trader_historical_tests_no_delete
      BEFORE DELETE ON trader_historical_tests
      BEGIN SELECT RAISE(ABORT, 'trader_historical_tests is append-only'); END;
  `);
  // Step 2: event calendar and headlines.
  db.exec(`
    CREATE TABLE IF NOT EXISTS trader_events (
      type TEXT NOT NULL,
      day TEXT NOT NULL,
      source TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (type, day)
    );
    CREATE TABLE IF NOT EXISTS trader_headlines (
      url TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      domain TEXT NOT NULL,
      published_at TEXT NOT NULL,
      fetched_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trader_headlines_published ON trader_headlines (published_at);
  `);
  const columns = (db.prepare("PRAGMA table_info(trader_hypotheses)").all() as { name: string }[]).map((c) => c.name);
  if (!columns.includes("test_rule")) db.exec("ALTER TABLE trader_hypotheses ADD COLUMN test_rule TEXT");
  // French wording for the owner (the statement the model reasons on stays in `statement`).
  if (!columns.includes("statement_fr")) db.exec("ALTER TABLE trader_hypotheses ADD COLUMN statement_fr TEXT");
  // Step 3: a headline is marked once a reader digested it (or skipped it), so no batch is lost.
  const headlineColumns = (db.prepare("PRAGMA table_info(trader_headlines)").all() as { name: string }[]).map((c) => c.name);
  if (!headlineColumns.includes("digested_at")) db.exec("ALTER TABLE trader_headlines ADD COLUMN digested_at TEXT");
  ensureAliveSchema(db);
  ensurePortfolioSchema(db);
  ensureGuardSchema(db);
  ensureDossierSchema(db);
  ensureCycleSchema(db);
}

/** Append-only: refuse every update and delete on a table. */
function appendOnly(table: string): string {
  return `
    CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;`;
}

/**
 * Step 3 ("Sonni alive", docs/MEMORY.md): identity versions, reflections,
 * lessons, watches, the wake log, observations from reader models, reader
 * calls, sources with their metrics, and the asset universe log. Model
 * texts are versioned or append-only; code-computed numbers live in
 * their own tables.
 */
function ensureAliveSchema(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trader_identity (
      id TEXT PRIMARY KEY,
      version INTEGER NOT NULL UNIQUE,
      content TEXT NOT NULL,
      reason TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('seed', 'model', 'owner')),
      recorded_at TEXT NOT NULL
    );
    ${appendOnly("trader_identity")}

    CREATE TABLE IF NOT EXISTS trader_reflections (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('postmortem', 'trade', 'session', 'daily', 'weekly')),
      subject_id TEXT,
      content TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trader_reflections_subject ON trader_reflections (subject_id);
    ${appendOnly("trader_reflections")}

    CREATE TABLE IF NOT EXISTS trader_lessons (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      evidence TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
      recorded_at TEXT NOT NULL,
      retired_at TEXT,
      retired_by TEXT CHECK (retired_by IN ('model', 'owner')),
      retire_reason TEXT
    );
    CREATE TRIGGER IF NOT EXISTS trader_lessons_no_delete BEFORE DELETE ON trader_lessons
      BEGIN SELECT RAISE(ABORT, 'trader_lessons is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS trader_lessons_retire_once BEFORE UPDATE ON trader_lessons
      WHEN OLD.status = 'retired' OR NEW.text IS NOT OLD.text OR NEW.evidence IS NOT OLD.evidence
        OR NEW.recorded_at IS NOT OLD.recorded_at
      BEGIN SELECT RAISE(ABORT, 'trader_lessons: a lesson can only be retired, once'); END;

    CREATE TABLE IF NOT EXISTS trader_watches (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('price', 'move', 'time')),
      asset TEXT,
      direction TEXT CHECK (direction IN ('above', 'below')),
      value REAL,
      window_hours INTEGER,
      due_at TEXT,
      note TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      fired_at TEXT,
      fired_reason TEXT,
      cancelled_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_trader_watches_open ON trader_watches (fired_at, cancelled_at, expires_at);
    CREATE TRIGGER IF NOT EXISTS trader_watches_no_delete BEFORE DELETE ON trader_watches
      BEGIN SELECT RAISE(ABORT, 'trader_watches is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS trader_watches_condition_fixed BEFORE UPDATE ON trader_watches
      WHEN NEW.kind IS NOT OLD.kind OR NEW.asset IS NOT OLD.asset OR NEW.direction IS NOT OLD.direction
        OR NEW.value IS NOT OLD.value OR NEW.window_hours IS NOT OLD.window_hours OR NEW.due_at IS NOT OLD.due_at
        OR NEW.note IS NOT OLD.note OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
        OR (OLD.fired_at IS NOT NULL AND NEW.fired_at IS NOT OLD.fired_at)
        OR (OLD.cancelled_at IS NOT NULL AND NEW.cancelled_at IS NOT OLD.cancelled_at)
      BEGIN SELECT RAISE(ABORT, 'trader_watches: only fired_at and cancelled_at may be set, once'); END;

    CREATE TABLE IF NOT EXISTS trader_wakes (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      key TEXT NOT NULL,
      reason TEXT NOT NULL,
      at TEXT NOT NULL,
      delivered INTEGER NOT NULL CHECK (delivered IN (0, 1))
    );
    CREATE INDEX IF NOT EXISTS idx_trader_wakes_at ON trader_wakes (at);
    CREATE INDEX IF NOT EXISTS idx_trader_wakes_key ON trader_wakes (key, at);
    ${appendOnly("trader_wakes")}

    CREATE TABLE IF NOT EXISTS trader_observations (
      id TEXT PRIMARY KEY,
      observed_at TEXT NOT NULL,
      published_at TEXT NOT NULL,
      source TEXT NOT NULL,
      url TEXT,
      assets TEXT NOT NULL,
      kind TEXT NOT NULL,
      sentiment REAL CHECK (sentiment IS NULL OR (sentiment >= -1 AND sentiment <= 1)),
      summary TEXT NOT NULL,
      event_date TEXT,
      trust TEXT NOT NULL CHECK (trust IN ('untrusted'))
    );
    CREATE INDEX IF NOT EXISTS idx_trader_observations_published ON trader_observations (published_at);
    CREATE INDEX IF NOT EXISTS idx_trader_observations_url ON trader_observations (url);
    ${appendOnly("trader_observations")}

    CREATE TABLE IF NOT EXISTS trader_reader_calls (
      id TEXT PRIMARY KEY,
      reader_id TEXT NOT NULL,
      at TEXT NOT NULL,
      purpose TEXT NOT NULL,
      ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
      ms INTEGER NOT NULL,
      status INTEGER,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_trader_reader_calls_at ON trader_reader_calls (reader_id, at);
    ${appendOnly("trader_reader_calls")}

    CREATE TABLE IF NOT EXISTS trader_sources (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      url TEXT NOT NULL,
      metrics TEXT NOT NULL,
      every_minutes INTEGER NOT NULL,
      key_env TEXT,
      origin TEXT NOT NULL CHECK (origin IN ('catalog', 'model')),
      status TEXT NOT NULL CHECK (status IN ('enabled', 'disabled', 'proposed', 'rejected')),
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_fetch_at TEXT,
      last_error TEXT,
      failures INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS trader_source_log (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('propose', 'enable', 'disable', 'approve', 'reject')),
      by TEXT NOT NULL CHECK (by IN ('code', 'model', 'owner')),
      reason TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    );
    ${appendOnly("trader_source_log")}

    CREATE TABLE IF NOT EXISTS trader_metrics (
      source_id TEXT NOT NULL,
      metric TEXT NOT NULL,
      ts TEXT NOT NULL,
      value REAL NOT NULL,
      PRIMARY KEY (source_id, metric, ts)
    );

    CREATE TABLE IF NOT EXISTS trader_page_reads (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      at TEXT NOT NULL,
      ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
      outcome TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trader_page_reads_at ON trader_page_reads (at);
    ${appendOnly("trader_page_reads")}

    CREATE TABLE IF NOT EXISTS trader_universe (
      id TEXT PRIMARY KEY,
      asset TEXT NOT NULL,
      kraken_pair TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('follow', 'unfollow')),
      reason TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    );
    ${appendOnly("trader_universe")}

    -- Step 1 of the 2026-10-08 plan: explicit decisions per asset and the odds code computed for each prediction.
    CREATE TABLE IF NOT EXISTS trader_decisions (
      id TEXT PRIMARY KEY,
      made_at TEXT NOT NULL,
      asset TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('buy', 'add', 'hold', 'reduce', 'sell', 'stay_out')),
      reason TEXT NOT NULL,
      price REAL NOT NULL CHECK (price > 0),
      position_eur REAL NOT NULL,
      equity_eur REAL NOT NULL,
      order_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_trader_decisions_asset ON trader_decisions (asset, made_at);
    ${appendOnly("trader_decisions")}

    CREATE TABLE IF NOT EXISTS trader_prediction_snapshots (
      prediction_id TEXT PRIMARY KEY REFERENCES trader_predictions(id),
      price REAL NOT NULL,
      distance_pct REAL NOT NULL,
      daily_vol_pct REAL NOT NULL,
      sigmas REAL,
      ref_probability REAL NOT NULL CHECK (ref_probability >= 0 AND ref_probability <= 1),
      historical_share REAL,
      historical_windows INTEGER NOT NULL,
      computed_at TEXT NOT NULL
    );
    ${appendOnly("trader_prediction_snapshots")}

    -- Step 2 of the 2026-10-08 plan: Kraken's EUR/USD rate (dollars per euro) for USD-quoted pairs.
    CREATE TABLE IF NOT EXISTS trader_fx (
      ts TEXT PRIMARY KEY,
      eurusd REAL NOT NULL CHECK (eurusd > 0)
    );
    CREATE TABLE IF NOT EXISTS trader_fx_daily (
      day TEXT PRIMARY KEY,
      eurusd REAL NOT NULL CHECK (eurusd > 0)
    );

    -- The weekly screen of Kraken pairs Sonni does not follow (src/trader/screen.ts).
    CREATE TABLE IF NOT EXISTS trader_screen (
      screen_id TEXT NOT NULL,
      at TEXT NOT NULL,
      asset TEXT NOT NULL,
      pair TEXT NOT NULL,
      volume_eur REAL NOT NULL,
      ret30_pct REAL,
      ret90_pct REAL,
      above_ma50 INTEGER,
      vol_pct REAL,
      corr_btc REAL,
      max_corr REAL,
      max_corr_with TEXT,
      score REAL NOT NULL,
      PRIMARY KEY (screen_id, pair)
    );
    ${appendOnly("trader_screen")}

    -- Step 3 of the 2026-10-08 plan: the second brain's work queue and what it produced (src/trader/brain.ts).
    CREATE TABLE IF NOT EXISTS trader_brain_jobs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      priority INTEGER NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      not_before TEXT NOT NULL,
      not_after TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'leased', 'done', 'failed', 'expired')),
      attempts INTEGER NOT NULL DEFAULT 0,
      lease_until TEXT,
      result TEXT,
      error TEXT,
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_trader_brain_jobs_queue ON trader_brain_jobs (status, priority, created_at);
    CREATE TRIGGER IF NOT EXISTS trader_brain_jobs_no_delete BEFORE DELETE ON trader_brain_jobs
      BEGIN SELECT RAISE(ABORT, 'trader_brain_jobs keeps its history'); END;

    CREATE TABLE IF NOT EXISTS trader_brain_outputs (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      subject TEXT,
      content TEXT NOT NULL,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trader_brain_outputs_kind ON trader_brain_outputs (kind, subject, at);
    ${appendOnly("trader_brain_outputs")}

    CREATE TABLE IF NOT EXISTS trader_brain_triage (
      observation_id TEXT PRIMARY KEY,
      relevance REAL NOT NULL,
      impact REAL NOT NULL,
      novelty REAL NOT NULL,
      note TEXT,
      would_wake INTEGER NOT NULL,
      at TEXT NOT NULL
    );
    ${appendOnly("trader_brain_triage")}

    CREATE TABLE IF NOT EXISTS trader_brain_predictions (
      prediction_id TEXT PRIMARY KEY,
      probability REAL NOT NULL CHECK (probability >= 0 AND probability <= 1),
      reason TEXT,
      at TEXT NOT NULL
    );
    ${appendOnly("trader_brain_predictions")}

    -- Step 4 of the 2026-10-08 plan: summaries of finished days, weeks and months computed by code (src/trader/summaries.ts).
    CREATE TABLE IF NOT EXISTS trader_summaries (
      period TEXT NOT NULL CHECK (period IN ('day', 'week', 'month')),
      start_day TEXT NOT NULL,
      end_day TEXT NOT NULL,
      content TEXT NOT NULL,
      sources TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (period, start_day)
    );
    ${appendOnly("trader_summaries")}

    -- Step 4 of the 2026-10-08 plan: which lessons a prediction or decision applied, scored by code later.
    CREATE TABLE IF NOT EXISTS trader_lesson_uses (
      lesson_id TEXT NOT NULL,
      subject_kind TEXT NOT NULL CHECK (subject_kind IN ('prediction', 'decision')),
      subject_id TEXT NOT NULL,
      at TEXT NOT NULL,
      PRIMARY KEY (lesson_id, subject_kind, subject_id)
    );
    ${appendOnly("trader_lesson_uses")}
  `);
  ensureMemoryIndex(db);
}

/** True once ensureTraderSchema has run on this database. */
export function hasTraderSchema(db: DB): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'trader_predictions'").get();
}
