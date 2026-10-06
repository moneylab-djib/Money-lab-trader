/**
 * Money Lab journal
 *
 * Small durable records stored in the existing state database:
 * experiments, owner help requests, an operator ledger, and pause /
 * no-progress state (in the existing KV table). No new storage engine.
 */

import type Database from "better-sqlite3";
import { ulid } from "ulid";
import { createHash } from "crypto";

type DB = Database.Database;

export const EXPERIMENT_STATUSES = [
  "exploring",
  "building",
  "observing",
  "waiting_for_owner",
  "paused",
  "finished",
] as const;
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];

export const HELP_STATUSES = ["open", "resolved", "rejected"] as const;
export type HelpStatus = (typeof HELP_STATUSES)[number];

/**
 * Ledger kinds. Owner funding and credit purchases are not expenses;
 * estimated revenue is not cash. Inference usage is read from the
 * existing inference_costs table and is not entered here, so it cannot
 * be counted twice.
 */
export const LEDGER_KINDS = [
  "owner_funding",
  "credit_purchase",
  "hosting",
  "external_service",
  "fee",
  "refund",
  "estimated_revenue",
  "confirmed_revenue",
  "cash_received",
] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

export interface Experiment {
  id: string;
  status: ExperimentStatus;
  hypothesis: string;
  evidence: string[];
  artifactRef: string | null;
  revenueModel: string | null;
  acquisitionChannel: string | null;
  spendAllowanceCents: number | null;
  consumedCostCents: number | null;
  reviewDate: string | null;
  metrics: Record<string, unknown>;
  result: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HelpRequest {
  id: string;
  experimentId: string | null;
  reason: string;
  humanAction: string;
  link: string | null;
  expectedCostCents: number | null;
  permissionsRequested: string[];
  resumeCondition: string;
  status: HelpStatus;
  resolutionNote: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface LedgerEntry {
  id: string;
  kind: LedgerKind;
  /** USD cents; null when the amount is unknown. */
  amountCents: number | null;
  source: "operator" | "provider_import";
  reference: string;
  experimentId: string | null;
  note: string | null;
  createdAt: string;
}

const KV_PAUSED = "money_lab.paused";
const KV_NO_PROGRESS = "money_lab.no_progress_cycles";

export function ensureMoneyLabSchema(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS money_lab_experiments (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      hypothesis TEXT NOT NULL,
      evidence TEXT NOT NULL DEFAULT '[]',
      artifact_ref TEXT,
      revenue_model TEXT,
      acquisition_channel TEXT,
      spend_allowance_cents INTEGER,
      consumed_cost_cents INTEGER,
      review_date TEXT,
      metrics TEXT NOT NULL DEFAULT '{}',
      result TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS money_lab_help_requests (
      id TEXT PRIMARY KEY,
      experiment_id TEXT,
      reason TEXT NOT NULL,
      human_action TEXT NOT NULL,
      link TEXT,
      expected_cost_cents INTEGER,
      permissions_requested TEXT NOT NULL DEFAULT '[]',
      resume_condition TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      resolution_note TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE TABLE IF NOT EXISTS money_lab_outbox (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      sent_at TEXT
    );
    CREATE TABLE IF NOT EXISTS money_lab_ledger (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      amount_cents INTEGER,
      source TEXT NOT NULL,
      reference TEXT NOT NULL UNIQUE,
      experiment_id TEXT,
      note TEXT,
      created_at TEXT NOT NULL
    );
  `);
}

function now(): string {
  return new Date().toISOString();
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowToExperiment(row: any): Experiment {
  return {
    id: row.id,
    status: row.status,
    hypothesis: row.hypothesis,
    evidence: parseJson<string[]>(row.evidence, []),
    artifactRef: row.artifact_ref,
    revenueModel: row.revenue_model,
    acquisitionChannel: row.acquisition_channel,
    spendAllowanceCents: row.spend_allowance_cents,
    consumedCostCents: row.consumed_cost_cents,
    reviewDate: row.review_date,
    metrics: parseJson<Record<string, unknown>>(row.metrics, {}),
    result: row.result,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToHelp(row: any): HelpRequest {
  return {
    id: row.id,
    experimentId: row.experiment_id,
    reason: row.reason,
    humanAction: row.human_action,
    link: row.link,
    expectedCostCents: row.expected_cost_cents,
    permissionsRequested: parseJson<string[]>(row.permissions_requested, []),
    resumeCondition: row.resume_condition,
    status: row.status,
    resolutionNote: row.resolution_note,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

// ─── Experiments ────────────────────────────────────────────────

export interface ExperimentInput {
  id?: string;
  status: ExperimentStatus;
  hypothesis?: string;
  evidence?: string[];
  artifactRef?: string | null;
  revenueModel?: string | null;
  acquisitionChannel?: string | null;
  spendAllowanceCents?: number | null;
  consumedCostCents?: number | null;
  reviewDate?: string | null;
  metrics?: Record<string, unknown>;
  result?: string | null;
}

export function getExperiment(db: DB, id: string): Experiment | undefined {
  const row = db.prepare("SELECT * FROM money_lab_experiments WHERE id = ?").get(id);
  return row ? rowToExperiment(row) : undefined;
}

export function listExperiments(db: DB): Experiment[] {
  return (db.prepare("SELECT * FROM money_lab_experiments ORDER BY created_at, id").all() as any[])
    .map(rowToExperiment);
}

/**
 * Create or update an experiment. Evidence is appended, metrics are merged.
 */
export function upsertExperiment(db: DB, input: ExperimentInput): Experiment {
  if (!EXPERIMENT_STATUSES.includes(input.status)) {
    throw new Error(`Invalid experiment status: ${input.status}`);
  }
  for (const field of ["spendAllowanceCents", "consumedCostCents"] as const) {
    const value = input[field];
    if (value !== undefined && value !== null && (!Number.isInteger(value) || value < 0)) {
      throw new Error(`${field} must be a non-negative integer (USD cents) or null`);
    }
  }

  return db.transaction(() => {
    const existing = input.id ? getExperiment(db, input.id) : undefined;
    const ts = now();

    if (!existing) {
      if (!input.hypothesis || input.hypothesis.trim() === "") {
        throw new Error("A new experiment requires a hypothesis");
      }
      const id = input.id ?? `exp_${ulid()}`;
      db.prepare(
        `INSERT INTO money_lab_experiments
         (id, status, hypothesis, evidence, artifact_ref, revenue_model, acquisition_channel,
          spend_allowance_cents, consumed_cost_cents, review_date, metrics, result, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id, input.status, input.hypothesis.trim(), JSON.stringify(input.evidence ?? []),
        input.artifactRef ?? null, input.revenueModel ?? null, input.acquisitionChannel ?? null,
        input.spendAllowanceCents ?? null, input.consumedCostCents ?? null, input.reviewDate ?? null,
        JSON.stringify(input.metrics ?? {}), input.result ?? null, ts, ts,
      );
      return getExperiment(db, id)!;
    }

    const evidence = [...existing.evidence];
    for (const item of input.evidence ?? []) {
      if (!evidence.includes(item)) evidence.push(item);
    }
    const merged: Experiment = {
      ...existing,
      status: input.status,
      hypothesis: input.hypothesis?.trim() || existing.hypothesis,
      evidence,
      artifactRef: input.artifactRef !== undefined ? input.artifactRef : existing.artifactRef,
      revenueModel: input.revenueModel !== undefined ? input.revenueModel : existing.revenueModel,
      acquisitionChannel: input.acquisitionChannel !== undefined ? input.acquisitionChannel : existing.acquisitionChannel,
      spendAllowanceCents: input.spendAllowanceCents !== undefined ? input.spendAllowanceCents : existing.spendAllowanceCents,
      consumedCostCents: input.consumedCostCents !== undefined ? input.consumedCostCents : existing.consumedCostCents,
      reviewDate: input.reviewDate !== undefined ? input.reviewDate : existing.reviewDate,
      metrics: { ...existing.metrics, ...(input.metrics ?? {}) },
      result: input.result !== undefined ? input.result : existing.result,
    };
    db.prepare(
      `UPDATE money_lab_experiments SET status = ?, hypothesis = ?, evidence = ?, artifact_ref = ?,
         revenue_model = ?, acquisition_channel = ?, spend_allowance_cents = ?, consumed_cost_cents = ?,
         review_date = ?, metrics = ?, result = ?, updated_at = ? WHERE id = ?`,
    ).run(
      merged.status, merged.hypothesis, JSON.stringify(merged.evidence), merged.artifactRef,
      merged.revenueModel, merged.acquisitionChannel, merged.spendAllowanceCents,
      merged.consumedCostCents, merged.reviewDate, JSON.stringify(merged.metrics), merged.result,
      ts, merged.id,
    );
    return getExperiment(db, merged.id)!;
  })();
}

// ─── Help requests ──────────────────────────────────────────────

export interface HelpRequestInput {
  experimentId: string | null;
  reason: string;
  humanAction: string;
  link?: string | null;
  expectedCostCents?: number | null;
  permissionsRequested?: string[];
  resumeCondition: string;
}

export function createHelpRequest(db: DB, input: HelpRequestInput): HelpRequest {
  for (const [field, value] of [
    ["reason", input.reason],
    ["humanAction", input.humanAction],
    ["resumeCondition", input.resumeCondition],
  ] as const) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`Help request requires ${field}`);
    }
  }
  const cost = input.expectedCostCents;
  if (cost !== undefined && cost !== null && (!Number.isInteger(cost) || cost < 0)) {
    throw new Error("expectedCostCents must be a non-negative integer (USD cents) or null");
  }

  return db.transaction(() => {
    if (input.experimentId) {
      const exp = getExperiment(db, input.experimentId);
      if (!exp) throw new Error(`Unknown experiment: ${input.experimentId}`);
      if (exp.status !== "finished") {
        db.prepare("UPDATE money_lab_experiments SET status = 'waiting_for_owner', updated_at = ? WHERE id = ?")
          .run(now(), exp.id);
      }
    }
    const id = `help_${ulid()}`;
    queueOwnerNotification(
      db,
      `🙋 Demande d'aide ${id}\nRaison : ${input.reason.trim()}\nAction demandée : ${input.humanAction.trim()}` +
        (input.link ? `\nLien : ${input.link}` : "") +
        (cost !== undefined && cost !== null ? `\nCoût prévu : ${(cost / 100).toFixed(2)} $` : "") +
        `\nReprise quand : ${input.resumeCondition.trim()}\n\nRéponds /ok ${id} ou /non ${id}`,
    );
    db.prepare(
      `INSERT INTO money_lab_help_requests
       (id, experiment_id, reason, human_action, link, expected_cost_cents, permissions_requested,
        resume_condition, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
    ).run(
      id, input.experimentId, input.reason.trim(), input.humanAction.trim(), input.link ?? null,
      cost ?? null, JSON.stringify(input.permissionsRequested ?? []), input.resumeCondition.trim(), now(),
    );
    return getHelpRequest(db, id)!;
  })();
}

export function getHelpRequest(db: DB, id: string): HelpRequest | undefined {
  const row = db.prepare("SELECT * FROM money_lab_help_requests WHERE id = ?").get(id);
  return row ? rowToHelp(row) : undefined;
}

export function listHelpRequests(db: DB, status?: HelpStatus): HelpRequest[] {
  const rows = status
    ? db.prepare("SELECT * FROM money_lab_help_requests WHERE status = ? ORDER BY created_at, id").all(status)
    : db.prepare("SELECT * FROM money_lab_help_requests ORDER BY created_at, id").all();
  return (rows as any[]).map(rowToHelp);
}

export type ResolveOutcome = "updated" | "already_closed" | "not_found";

/**
 * Operator resolution. Only the local operator CLI calls this; no agent
 * tool or inbound message path can. A second resolution of a closed
 * request changes nothing and does not wake the agent again.
 */
export function resolveHelpRequest(
  db: DB,
  id: string,
  status: "resolved" | "rejected",
  note: string,
): { outcome: ResolveOutcome; request?: HelpRequest } {
  return db.transaction(() => {
    const existing = getHelpRequest(db, id);
    if (!existing) return { outcome: "not_found" as const };
    if (existing.status !== "open") return { outcome: "already_closed" as const, request: existing };
    db.prepare(
      "UPDATE money_lab_help_requests SET status = ?, resolution_note = ?, resolved_at = ? WHERE id = ? AND status = 'open'",
    ).run(status, note, now(), id);
    db.prepare(
      "INSERT INTO wake_events (source, reason, payload) VALUES ('money_lab_operator', ?, ?)",
    ).run(`Help request ${id} ${status}${note ? ` by the owner: ${note}` : ""}`, JSON.stringify({ helpRequestId: id, status }));
    return { outcome: "updated" as const, request: getHelpRequest(db, id) };
  })();
}

// ─── Ledger ─────────────────────────────────────────────────────

export interface LedgerInput {
  kind: LedgerKind;
  amountCents: number | null;
  source: "operator" | "provider_import";
  reference: string;
  experimentId?: string | null;
  note?: string | null;
}

/** Returns false when the reference was already imported (deduplicated). */
export function addLedgerEntry(db: DB, input: LedgerInput): boolean {
  if (!LEDGER_KINDS.includes(input.kind)) throw new Error(`Invalid ledger kind: ${input.kind}`);
  if (input.amountCents !== null && (!Number.isInteger(input.amountCents) || input.amountCents < 0)) {
    throw new Error("amountCents must be a non-negative integer (USD cents) or null for unknown");
  }
  if (!input.reference || input.reference.trim() === "") throw new Error("A ledger reference is required");
  const result = db.prepare(
    `INSERT OR IGNORE INTO money_lab_ledger (id, kind, amount_cents, source, reference, experiment_id, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `led_${ulid()}`, input.kind, input.amountCents, input.source, input.reference.trim(),
    input.experimentId ?? null, input.note ?? null, now(),
  );
  return result.changes === 1;
}

export interface FinancialSummary {
  ownerFundingCents: number;
  creditPurchasesCents: number;
  inferenceConsumedCents: number;
  hostingCents: number;
  externalServicesCents: number;
  feesCents: number;
  refundsCents: number;
  estimatedRevenueCents: number;
  confirmedRevenueCents: number;
  cashReceivedCents: number;
  /** confirmed revenue - refunds - fees - consumed costs (no funding, no purchases). */
  profitCents: number;
  /** Ledger rows with an unknown amount; profit is incomplete while > 0. */
  unknownAmountEntries: number;
}

export function summarizeFinances(db: DB): FinancialSummary {
  const sums: Record<string, number> = {};
  const rows = db.prepare(
    "SELECT kind, COALESCE(SUM(amount_cents), 0) AS total, SUM(amount_cents IS NULL) AS unknown FROM money_lab_ledger GROUP BY kind",
  ).all() as { kind: string; total: number; unknown: number }[];
  let unknown = 0;
  for (const row of rows) {
    sums[row.kind] = row.total;
    unknown += row.unknown;
  }
  const inference = (db.prepare("SELECT COALESCE(SUM(cost_cents), 0) AS total FROM inference_costs").get() as {
    total: number;
  }).total;

  const get = (k: LedgerKind) => sums[k] ?? 0;
  const consumed = inference + get("hosting") + get("external_service");
  return {
    ownerFundingCents: get("owner_funding"),
    creditPurchasesCents: get("credit_purchase"),
    inferenceConsumedCents: inference,
    hostingCents: get("hosting"),
    externalServicesCents: get("external_service"),
    feesCents: get("fee"),
    refundsCents: get("refund"),
    estimatedRevenueCents: get("estimated_revenue"),
    confirmedRevenueCents: get("confirmed_revenue"),
    cashReceivedCents: get("cash_received"),
    profitCents: get("confirmed_revenue") - get("refund") - get("fee") - consumed,
    unknownAmountEntries: unknown,
  };
}

// ─── Pause / no-progress (existing KV table) ────────────────────

export interface PauseState {
  at: string;
  reason: string;
  by: "operator" | "runtime";
}

export function getKV(db: DB, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function setKV(db: DB, key: string, value: string): void {
  db.prepare(
    "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).run(key, value);
}

export function deleteKV(db: DB, key: string): void {
  db.prepare("DELETE FROM kv WHERE key = ?").run(key);
}

export function getPauseState(db: DB): PauseState | null {
  const raw = getKV(db, KV_PAUSED);
  if (raw === undefined) return null;
  // A corrupted pause record still counts as paused (fail closed).
  return parseJson<PauseState>(raw, { at: "unknown", reason: "unreadable pause record", by: "runtime" });
}

export function pause(db: DB, reason: string, by: PauseState["by"]): PauseState {
  const existing = getPauseState(db);
  if (existing) return existing;
  const state: PauseState = { at: now(), reason, by };
  setKV(db, KV_PAUSED, JSON.stringify(state));
  if (by === "runtime") queueOwnerNotification(db, `⏸️ Money Lab mis en pause automatiquement : ${reason}\n/reprendre quand c'est réglé.`);
  return state;
}

/** Operator-only. Also resets the no-progress counter and wakes the loop. */
export function resume(db: DB): boolean {
  const wasPaused = getPauseState(db) !== null;
  db.transaction(() => {
    deleteKV(db, KV_PAUSED);
    deleteKV(db, KV_NO_PROGRESS);
    deleteKV(db, "sleep_until");
    deleteKV(db, "sleep_reason");
    if (wasPaused) {
      db.prepare("INSERT INTO wake_events (source, reason, payload) VALUES ('money_lab_operator', 'Operator resumed Money Lab', '{}')").run();
    }
  })();
  return wasPaused;
}

export function getNoProgressCycles(db: DB): number {
  const value = Number(getKV(db, KV_NO_PROGRESS) ?? "0");
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export function setNoProgressCycles(db: DB, cycles: number): void {
  setKV(db, KV_NO_PROGRESS, String(cycles));
}

/**
 * Fingerprint of journal state. A wake cycle that leaves it unchanged
 * made no recorded progress. Opening a help request is not progress (it
 * cannot be used to dodge the no-progress sleep); an operator resolution is.
 */
export function journalFingerprint(db: DB): string {
  const exp = db.prepare("SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), '') AS t FROM money_lab_experiments").get() as any;
  const help = db.prepare("SELECT COALESCE(MAX(resolved_at), '') AS t FROM money_lab_help_requests").get() as any;
  // Discovery work (the idea pipeline) is progress too.
  const ideas = createHash("sha256").update(getKV(db, "money_lab.ideas") ?? "").digest("hex").slice(0, 16);
  return `${exp.n}|${exp.t}|${help.t}|${ideas}`;
}

/** Closed help requests, most recently resolved first. */
export function listRecentlyClosedHelp(db: DB, limit: number): HelpRequest[] {
  return (db.prepare(
    "SELECT * FROM money_lab_help_requests WHERE status != 'open' ORDER BY resolved_at DESC, id DESC LIMIT ?",
  ).all(limit) as any[]).map(rowToHelp);
}

// ─── Owner notifications (outbox, delivered by the Telegram channel) ──

/** Queue a message for the owner. Delivery happens outside the agent loop. */
export function queueOwnerNotification(db: DB, text: string): string {
  const id = `msg_${ulid()}`;
  db.prepare("INSERT INTO money_lab_outbox (id, text, created_at) VALUES (?, ?, ?)").run(id, text, now());
  return id;
}

export function pendingOwnerNotifications(db: DB, limit = 20): { id: string; text: string }[] {
  return db.prepare(
    "SELECT id, text FROM money_lab_outbox WHERE sent_at IS NULL ORDER BY created_at, id LIMIT ?",
  ).all(limit) as { id: string; text: string }[];
}

export function markOwnerNotificationSent(db: DB, id: string): void {
  db.prepare("UPDATE money_lab_outbox SET sent_at = ? WHERE id = ?").run(now(), id);
}

/** Notifications queued today (UTC), for the agent's daily message budget. */
export function ownerNotificationsToday(db: DB): number {
  const day = new Date().toISOString().slice(0, 10);
  return (db.prepare("SELECT COUNT(*) AS n FROM money_lab_outbox WHERE created_at >= ?").get(day) as { n: number }).n;
}

/** Sender of owner messages relayed from Telegram (only the owner's chat is accepted). */
export const OWNER_TELEGRAM_SENDER = "owner (Telegram)";

/** KV key holding the reason of the operator event that ended the last sleep. */
export const MONEY_LAB_WAKE_REASON_KEY = "money_lab.wake_reason";
