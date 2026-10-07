/**
 * Sonni data sources (step 3): free public JSON endpoints that code polls
 * on their own cadence, extracting a few numbers (an index, a rate, a
 * spread) into trader_metrics. The catalog (src/trader/catalog.ts) is
 * code-owned; Sonni enables or disables its entries with a reason, and
 * may propose a new endpoint that the owner approves or rejects on
 * Telegram. Every change is logged, append-only.
 *
 * A source is data: a JSON path per metric, no code. Model-proposed
 * sources pass the same public-host checks as read_page at every fetch.
 * A key (for example FRED) is read from the sealed environment at fetch
 * time and substituted into the URL template; it never appears in logs,
 * errors or the model's context.
 */

import type Database from "better-sqlite3";
import { ulid } from "ulid";
import { containsInjectionPatterns } from "../soul/validator.js";
import { SOURCE_CATALOG, DEFAULT_ENABLED_SOURCES, type SourceDef, type SourceMetric } from "./catalog.js";
import { checkPublicUrl, readCapped, type Resolver } from "./pages.js";
import type { SoulResult } from "./soul.js";

type DB = Database.Database;
type FetchFn = typeof fetch;

export const SOURCE_TIMEOUT_MS = 20_000;
export const SOURCE_MAX_BYTES = 512_000;
export const MIN_SOURCE_MINUTES = 15;
export const MAX_SOURCE_MINUTES = 7 * 24 * 60;
export const MAX_METRICS_PER_SOURCE = 4;
export const MAX_PROPOSED_SOURCES = 5;
/** Consecutive failures after which a source is disabled by code. */
export const MAX_FAILURES = 20;
export const METRIC_RETENTION_DAYS = 90;
const SOURCE_ID = /^[a-z0-9][a-z0-9_]{1,39}$/;
const METRIC_NAME = /^[a-z0-9][a-z0-9_]{0,39}$/;
const REASON_MAX = 300;

export type SourceStatus = "enabled" | "disabled" | "proposed" | "rejected";

export interface SourceRow {
  id: string;
  label: string;
  url: string;
  metrics: SourceMetric[];
  everyMinutes: number;
  keyEnv: string | null;
  origin: "catalog" | "model";
  status: SourceStatus;
  reason: string;
  createdAt: string;
  updatedAt: string;
  lastFetchAt: string | null;
  lastError: string | null;
  failures: number;
}

function rowToSource(row: any): SourceRow {
  return {
    id: row.id,
    label: row.label,
    url: row.url,
    metrics: JSON.parse(row.metrics),
    everyMinutes: row.every_minutes,
    keyEnv: row.key_env,
    origin: row.origin,
    status: row.status,
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastFetchAt: row.last_fetch_at,
    lastError: row.last_error,
    failures: row.failures,
  };
}

function logAction(db: DB, sourceId: string, action: "propose" | "enable" | "disable" | "approve" | "reject", by: "code" | "model" | "owner", reason: string, now: Date): void {
  db.prepare("INSERT INTO trader_source_log (id, source_id, action, by, reason, recorded_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(`s_${ulid()}`, sourceId, action, by, reason, now.toISOString());
}

/** Insert catalog entries that the database does not know yet (defaults enabled, the rest disabled). */
export function ensureCatalog(db: DB, now: Date = new Date()): number {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO trader_sources (id, label, url, metrics, every_minutes, key_env, origin, status, reason, created_at, updated_at, failures)
     VALUES (?, ?, ?, ?, ?, ?, 'catalog', ?, ?, ?, ?, 0)`,
  );
  let added = 0;
  db.transaction(() => {
    for (const s of SOURCE_CATALOG) {
      const status: SourceStatus = DEFAULT_ENABLED_SOURCES.includes(s.id) ? "enabled" : "disabled";
      const n = insert.run(s.id, s.label, s.url, JSON.stringify(s.metrics), s.everyMinutes, s.keyEnv ?? null, status, "catalogue", now.toISOString(), now.toISOString()).changes;
      if (n > 0) {
        added++;
        logAction(db, s.id, status === "enabled" ? "enable" : "disable", "code", "catalogue", now);
      }
    }
  })();
  return added;
}

export function getSource(db: DB, id: string): SourceRow | undefined {
  const row = db.prepare("SELECT * FROM trader_sources WHERE id = ?").get(id);
  return row ? rowToSource(row) : undefined;
}

export function listSources(db: DB, status?: SourceStatus): SourceRow[] {
  const rows = status
    ? db.prepare("SELECT * FROM trader_sources WHERE status = ? ORDER BY origin, id").all(status)
    : db.prepare("SELECT * FROM trader_sources ORDER BY status, origin, id").all();
  return (rows as any[]).map(rowToSource);
}

/** Plain text written by the model that the owner and later turns will read: no prompt-boundary tricks. */
function cleanReason(raw: unknown): string | null {
  const text = String(raw ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (text.length < 5 || text.length > REASON_MAX || containsInjectionPatterns(text)) return null;
  return text;
}

/** The model enables or disables a known source (catalog or owner-approved). */
export function setSourceEnabled(db: DB, id: unknown, enabled: boolean, reason: unknown, now: Date = new Date()): SoulResult<SourceRow> {
  const src = getSource(db, String(id ?? "").trim());
  if (!src) return { ok: false, error: `Unknown source ${id}. List them with action list.` };
  const why = cleanReason(reason);
  if (!why) return { ok: false, error: `reason must be 5 to ${REASON_MAX} characters.` };
  if (src.status === "proposed") return { ok: false, error: `Source ${src.id} is waiting for the owner's decision (/sources).` };
  if (src.status === "rejected") return { ok: false, error: `Source ${src.id} was rejected by the owner; propose another.` };
  const target: SourceStatus = enabled ? "enabled" : "disabled";
  if (src.status === target) return { ok: false, error: `Source ${src.id} is already ${target}.` };
  db.prepare("UPDATE trader_sources SET status = ?, reason = ?, updated_at = ?, failures = 0, last_error = NULL WHERE id = ?")
    .run(target, why, now.toISOString(), src.id);
  logAction(db, src.id, enabled ? "enable" : "disable", "model", why, now);
  return { ok: true, value: getSource(db, src.id)! };
}

export interface ProposedSource {
  id: unknown;
  label: unknown;
  url: unknown;
  metrics: unknown;
  everyMinutes: unknown;
  why: unknown;
}

/** Validate a metric list given by the model (name and JSON path, optional scale). */
export function parseMetrics(raw: unknown): SoulResult<SourceMetric[]> {
  const list = typeof raw === "string" ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : raw;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_METRICS_PER_SOURCE) {
    return { ok: false, error: `metrics must be a list of 1 to ${MAX_METRICS_PER_SOURCE} objects {name, path}.` };
  }
  const out: SourceMetric[] = [];
  const names = new Set<string>();
  for (const m of list) {
    const name = String((m as any)?.name ?? "").trim();
    const path = String((m as any)?.path ?? "").trim();
    if (!METRIC_NAME.test(name) || names.has(name)) return { ok: false, error: `metric name "${name}" must be unique, lowercase letters, digits or _.` };
    if (!/^[A-Za-z0-9_*\-.[\]]{1,120}$/.test(path)) return { ok: false, error: `metric path "${path}" must be a dotted JSON path, e.g. data.0.value or result.*.asks.0.0.` };
    const scale = (m as any)?.scale === undefined ? undefined : Number((m as any).scale);
    if (scale !== undefined && (!Number.isFinite(scale) || scale === 0)) return { ok: false, error: `metric scale for "${name}" must be a non-zero number.` };
    names.add(name);
    out.push(scale === undefined ? { name, path } : { name, path, scale });
  }
  return { ok: true, value: out };
}

/** The model proposes a public JSON endpoint; it waits for the owner's /source ok. */
export async function proposeSource(db: DB, input: ProposedSource, resolve?: Resolver, now: Date = new Date()): Promise<SoulResult<SourceRow>> {
  const id = String(input.id ?? "").trim().toLowerCase();
  if (!SOURCE_ID.test(id)) return { ok: false, error: "id must be 2 to 40 lowercase letters, digits or _ (e.g. eth_gas)." };
  if (getSource(db, id)) return { ok: false, error: `Source ${id} already exists.` };
  const label = String(input.label ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (label.length < 3 || label.length > 80 || containsInjectionPatterns(label)) return { ok: false, error: "label must be 3 to 80 characters of plain text." };
  const why = cleanReason(input.why);
  if (!why) return { ok: false, error: `why must be 5 to ${REASON_MAX} characters: what the numbers would tell you.` };
  const every = Number(input.everyMinutes);
  if (!Number.isInteger(every) || every < MIN_SOURCE_MINUTES || every > MAX_SOURCE_MINUTES) {
    return { ok: false, error: `every_minutes must be an integer from ${MIN_SOURCE_MINUTES} to ${MAX_SOURCE_MINUTES}.` };
  }
  const metrics = parseMetrics(input.metrics);
  if (!metrics.ok) return metrics;
  const url = String(input.url ?? "").trim();
  if (url.includes("{key}") || /api[_-]?key|token=|secret/i.test(url)) return { ok: false, error: "Only keyless public endpoints can be proposed; the owner adds keyed sources." };
  const checked = await checkPublicUrl(url, resolve);
  if (!checked.ok) return { ok: false, error: checked.error };
  if (listSources(db, "proposed").length >= MAX_PROPOSED_SOURCES) {
    return { ok: false, error: `${MAX_PROPOSED_SOURCES} proposals are already waiting for the owner.` };
  }
  db.prepare(
    `INSERT INTO trader_sources (id, label, url, metrics, every_minutes, key_env, origin, status, reason, created_at, updated_at, failures)
     VALUES (?, ?, ?, ?, ?, NULL, 'model', 'proposed', ?, ?, ?, 0)`,
  ).run(id, label, checked.value.toString(), JSON.stringify(metrics.value), every, why, now.toISOString(), now.toISOString());
  logAction(db, id, "propose", "model", why, now);
  return { ok: true, value: getSource(db, id)! };
}

/** The owner approves (enables) or rejects a proposal. */
export function decideSource(db: DB, id: unknown, approve: boolean, note: string, now: Date = new Date()): SoulResult<SourceRow> {
  const src = getSource(db, String(id ?? "").trim());
  if (!src) return { ok: false, error: `Source inconnue : ${id}` };
  if (src.status !== "proposed") return { ok: false, error: `La source ${src.id} n'est pas en attente (état : ${src.status}).` };
  const reason = note.trim() || (approve ? "approuvée par le propriétaire" : "refusée par le propriétaire");
  db.prepare("UPDATE trader_sources SET status = ?, reason = ?, updated_at = ? WHERE id = ?")
    .run(approve ? "enabled" : "rejected", reason, now.toISOString(), src.id);
  logAction(db, src.id, approve ? "approve" : "reject", "owner", reason, now);
  return { ok: true, value: getSource(db, src.id)! };
}

// ─── Fetching and metrics ───────────────────────────────────────

/** Walk a dotted path: keys, numeric indexes (negative from the end), "*" for the first key of an object. */
export function extractPath(json: unknown, path: string): unknown {
  const parts = path.replace(/\[(\d+|-\d+)\]/g, ".$1").split(".").filter(Boolean);
  let cur: any = json;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (part === "*") {
      const keys = Array.isArray(cur) ? [0] : Object.keys(cur);
      if (keys.length === 0) return undefined;
      cur = cur[keys[0] as any];
    } else if (/^-?\d+$/.test(part) && Array.isArray(cur)) {
      const i = Number(part);
      cur = cur[i < 0 ? cur.length + i : i];
    } else {
      cur = cur[part];
    }
  }
  return cur;
}

export function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export interface FetchDeps {
  env: NodeJS.ProcessEnv;
  fetchFn?: FetchFn;
  resolve?: Resolver;
}


export interface FetchedMetrics {
  metrics: { name: string; value: number }[];
  /** Metric names whose path gave no number in this answer. */
  missing: string[];
}

/** Fetch one source and extract its metrics; throws with a key-free message. */
export async function fetchSourceMetrics(src: SourceDef | SourceRow, deps: FetchDeps): Promise<FetchedMetrics> {
  const key = src.keyEnv ? deps.env[src.keyEnv] : undefined;
  if (src.keyEnv && !key) throw new Error(`key ${src.keyEnv} absent`);
  const url = src.url.replace("{key}", key ?? "");
  const scrub = (s: string) => (key ? s.split(key).join("[key]") : s).slice(0, 160);
  if ("origin" in src && src.origin === "model") {
    const checked = await checkPublicUrl(url, deps.resolve);
    if (!checked.ok) throw new Error(checked.error);
  }
  let resp: Response;
  try {
    // No redirect is followed: a source that moves is re-proposed, and a model-proposed
    // host cannot bounce the runtime to a private address through a 3xx.
    resp = await (deps.fetchFn ?? fetch)(url, {
      redirect: "manual",
      headers: { Accept: "application/json", "User-Agent": "Sonni/1.0 (personal research agent)" },
      signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
    });
  } catch (err: any) {
    throw new Error(scrub(String(err?.message ?? err)));
  }
  if (resp.status >= 300 && resp.status < 400) throw new Error(`redirect refused (HTTP ${resp.status})`);
  const text = await readCapped(resp, SOURCE_MAX_BYTES);
  // Error texts are code-owned: a provider's body never reaches the owner or the model.
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`not JSON (${text.length} bytes)`);
  }
  const out: { name: string; value: number }[] = [];
  const missing: string[] = [];
  for (const m of src.metrics) {
    const value = toNumber(extractPath(json, m.path));
    if (value === null) missing.push(m.name);
    else out.push({ name: m.name, value: m.scale ? value * m.scale : value });
  }
  if (out.length === 0) throw new Error(`no metric found at ${src.metrics.map((m) => m.path).join(", ")}`);
  return { metrics: out, missing };
}

export interface SourcesOutcome {
  fetched: number;
  stored: number;
  errors: string[];
  disabled: string[];
}

/** Poll the enabled sources that are due; store their metrics; rest failing ones. */
export async function sourcesTick(db: DB, deps: FetchDeps, now: Date = new Date()): Promise<SourcesOutcome> {
  const out: SourcesOutcome = { fetched: 0, stored: 0, errors: [], disabled: [] };
  const ts = now.toISOString().slice(0, 19) + "Z";
  const insert = db.prepare("INSERT OR REPLACE INTO trader_metrics (source_id, metric, ts, value) VALUES (?, ?, ?, ?)");
  for (const src of listSources(db, "enabled")) {
    const due = !src.lastFetchAt || now.getTime() - Date.parse(src.lastFetchAt) >= src.everyMinutes * 60_000 - 1000;
    if (!due) continue;
    out.fetched++;
    try {
      const { metrics, missing } = await fetchSourceMetrics(src, deps);
      // A partial answer is stored; the missing names stay visible as the last error.
      const note = missing.length ? `metric(s) absent from the answer: ${missing.join(", ")}` : null;
      db.transaction(() => {
        for (const m of metrics) insert.run(src.id, m.name, ts, m.value);
        db.prepare("UPDATE trader_sources SET last_fetch_at = ?, last_error = ?, failures = 0, updated_at = ? WHERE id = ?")
          .run(now.toISOString(), note, now.toISOString(), src.id);
      })();
      out.stored += metrics.length;
    } catch (err: any) {
      const message = String(err?.message ?? err).slice(0, 160);
      const failures = src.failures + 1;
      out.errors.push(`${src.id}: ${message}`);
      if (failures >= MAX_FAILURES) {
        db.prepare("UPDATE trader_sources SET status = 'disabled', last_fetch_at = ?, last_error = ?, failures = ?, reason = ?, updated_at = ? WHERE id = ?")
          .run(now.toISOString(), message, failures, `désactivée par le code après ${failures} échecs`, now.toISOString(), src.id);
        logAction(db, src.id, "disable", "code", `${failures} échecs consécutifs : ${message}`, now);
        out.disabled.push(src.id);
      } else {
        db.prepare("UPDATE trader_sources SET last_fetch_at = ?, last_error = ?, failures = ?, updated_at = ? WHERE id = ?")
          .run(now.toISOString(), message, failures, now.toISOString(), src.id);
      }
    }
  }
  db.prepare("DELETE FROM trader_metrics WHERE ts < ?").run(new Date(now.getTime() - METRIC_RETENTION_DAYS * 86_400_000).toISOString().slice(0, 19) + "Z");
  return out;
}

export interface MetricSnapshot {
  sourceId: string;
  label: string;
  metric: string;
  ts: string;
  value: number;
  /** Value about 24 h earlier, when stored. */
  dayAgo: number | null;
  /** Value about 7 days earlier, when stored. */
  weekAgo: number | null;
}

/** Latest value per enabled metric with the values a day and a week before. */
export function latestMetrics(db: DB, now: Date = new Date()): MetricSnapshot[] {
  const latest = db.prepare(
    `SELECT m.source_id, s.label, m.metric, m.ts, m.value FROM trader_metrics m
     JOIN trader_sources s ON s.id = m.source_id
     WHERE s.status = 'enabled' AND m.ts = (SELECT MAX(ts) FROM trader_metrics x WHERE x.source_id = m.source_id AND x.metric = m.metric)
     ORDER BY m.source_id, m.metric`,
  ).all() as { source_id: string; label: string; metric: string; ts: string; value: number }[];
  const before = db.prepare(
    "SELECT value FROM trader_metrics WHERE source_id = ? AND metric = ? AND ts <= ? ORDER BY ts DESC LIMIT 1",
  );
  const at = (sourceId: string, metric: string, hoursAgo: number): number | null => {
    const row = before.get(sourceId, metric, new Date(now.getTime() - hoursAgo * 3_600_000).toISOString().slice(0, 19) + "Z") as { value: number } | undefined;
    return row ? row.value : null;
  };
  return latest.map((r) => ({
    sourceId: r.source_id,
    label: r.label,
    metric: r.metric,
    ts: r.ts,
    value: r.value,
    dayAgo: at(r.source_id, r.metric, 24),
    weekAgo: at(r.source_id, r.metric, 24 * 7),
  }));
}

function fmt(v: number): string {
  if (Math.abs(v) >= 1e12) return `${(v / 1e12).toFixed(2)}T`;
  if (Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(2)}G`;
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  return Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2);
}

/** Lines for the memory pack: one per metric with its 24 h and 7 d references. */
export function metricsForPack(db: DB, now: Date = new Date()): string[] {
  return latestMetrics(db, now).map((m) => {
    const refs = [m.dayAgo !== null ? `24 h ago ${fmt(m.dayAgo)}` : null, m.weekAgo !== null ? `7 d ago ${fmt(m.weekAgo)}` : null].filter(Boolean);
    const age = Math.round((now.getTime() - Date.parse(m.ts)) / 3_600_000);
    return `- ${m.label} ${m.metric}: ${fmt(m.value)} (${age} h old${refs.length ? `; ${refs.join(", ")}` : ""})`;
  });
}

/** For the model (manage_source list) and the owner (/sources). */
export function describeSources(db: DB, lang: "en" | "fr" = "en"): string {
  const rows = listSources(db);
  if (rows.length === 0) return lang === "fr" ? "Aucune source." : "No source.";
  const state = (s: SourceStatus) => lang === "fr"
    ? ({ enabled: "active", disabled: "inactive", proposed: "proposée, en attente de ta décision", rejected: "refusée" } as const)[s]
    : s;
  return rows.map((s) => {
    const health = s.lastError ? (lang === "fr" ? ` ; dernière erreur : ${s.lastError.slice(0, 80)}` : `; last error: ${s.lastError.slice(0, 80)}`) : "";
    const every = lang === "fr" ? `toutes les ${s.everyMinutes} min` : `every ${s.everyMinutes} min`;
    // The owner decides on a proposal from its URL: always shown for model-proposed sources.
    const url = s.origin === "model" ? `\n    URL : ${s.url}` : "";
    return `- ${s.id} [${state(s.status)}${s.origin === "model" ? (lang === "fr" ? ", proposée par Sonni" : ", proposed by you") : ""}] ${s.label}: ` +
      `${s.metrics.map((m) => m.name).join(", ")} ${every}${s.keyEnv ? ` (${lang === "fr" ? "clé" : "key"} ${s.keyEnv})` : ""} — ${s.reason}${health}${url}`;
  }).join("\n");
}

export function formatSourcesFr(db: DB, now: Date = new Date()): string {
  const lines = ["Sources de données (interrogées par le code, sans IA) :", describeSources(db, "fr")];
  const proposed = listSources(db, "proposed");
  if (proposed.length) lines.push("", `Pour décider : /source ok <id> ou /source non <id> [raison]. ${proposed.length} proposition(s) en attente.`);
  const metrics = metricsForPack(db, now);
  if (metrics.length) lines.push("", "Dernières valeurs :", ...metrics);
  lines.push("", "Données : CoinGecko, alternative.me (Fear & Greed), Kraken, mempool.space, DefiLlama, OKX. " +
    "This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.");
  return lines.join("\n");
}
