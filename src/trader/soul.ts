/**
 * Sonni identity, reflections and lessons (docs/MEMORY.md, step 3 "Sonni alive")
 *
 * The three stores the model writes about itself, all kept for good:
 * - identity: a short self-description it may revise (every version kept);
 * - reflections: an append-only journal (post-mortems of resolved
 *   predictions, session and weekly notes);
 * - lessons: short rules with the evidence that justifies them; a lesson is
 *   retired (by the model or by the owner's /veto), never deleted.
 *
 * What the model may not write, code computes here: the self-report
 * (calibration, Brier by asset and horizon, counts, spend), so the model
 * reads measured facts about itself before it reflects. Texts are
 * written in French: the owner reads them raw on Telegram.
 */

import type Database from "better-sqlite3";
import { ulid } from "ulid";
import { getKV, setKV, summarizeFinances } from "../money-lab/journal.js";
import { containsInjectionPatterns } from "../soul/validator.js";
import { inferenceGetDailyCost } from "../state/database.js";
import type { TraderConfig } from "./config.js";
import { getHypothesis, listHypotheses } from "./hypotheses.js";
import { getTrade, type Performance, performance } from "./portfolio.js";
import { getPrediction, type Prediction } from "./predictions.js";
import { decisionStats, type DecisionStats } from "./decisions.js";
import { skillBetween, type SkillWindow } from "./snapshot.js";

type DB = Database.Database;

export const IDENTITY_MAX_CHARS = 2500;
export const IDENTITY_MIN_CHARS = 80;
export const REASON_MAX_CHARS = 300;
export const REFLECTION_MAX_CHARS = 1500;
export const REFLECTION_MIN_CHARS = 20;
export const LESSON_MAX_CHARS = 300;
export const LESSON_MIN_CHARS = 15;
export const MAX_ACTIVE_LESSONS = 40;
export const MAX_LESSONS_PER_DAY = 3;
export const MAX_REFLECTIONS_PER_DAY = 12;
export const MAX_IDENTITY_REVISIONS_PER_DAY = 1;
/** The identity must keep saying who it is. */
export const IDENTITY_ANCHOR = "Je suis Sonni";

export const REFLECTION_KINDS = ["postmortem", "trade", "session", "daily", "weekly"] as const;
export type ReflectionKind = (typeof REFLECTION_KINDS)[number];

/** Version 1, written by code: the model revises it from here. */
export const SEED_IDENTITY = `Je suis Sonni, apprenti courtier. Je m'entraîne sur un portefeuille virtuel : aucun argent réel, aucun ordre,
aucun compte d'échange. Mon but est d'apprendre à lire les marchés comme le ferait un bon courtier, pour qu'un
jour mon propriétaire puisse me confier son épargne mensuelle, après une longue série de résultats mesurés et
seulement par sa décision.

Comment je travaille : je transforme ce que je crois en intuitions, puis en prédictions que le code vérifie et
note (score de Brier). Ma confiance dans une intuition est calculée, jamais déclarée. Je lis mon bilan avant de
réfléchir ; je note ce que j'apprends dans mon journal et mes leçons, avec les preuves.

Ce que je ne sais pas encore : si mes intuitions tiennent sur les mois à venir, quels pièges me guettent, et
à quels événements les prix réagissent vraiment. C'est ce que je mesure jour après jour.`;

export type SoulResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** The runtime's own section markers: model text must not be able to forge them in the prompt. */
export const RUNTIME_MARKERS = /SONNI RULES|Sonni Mission|MEMORY PACK|UNTRUSTED DATA|Wake-up reason|SELF-REPORT|AVAILABLE TOOLS|CONSTITUTION/i;

/**
 * Plain text only: no control characters, bounded length; refuses
 * prompt-boundary tricks and lines that would read as section headers or
 * runtime markers once spliced into the system prompt.
 */
function cleanText(raw: unknown, min: number, max: number, what: string): SoulResult<string> {
  const text = String(raw ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/\r\n?/g, "\n").trim();
  if (text.length < min) return { ok: false, error: `${what} must be at least ${min} characters.` };
  if (text.length > max) return { ok: false, error: `${what} must be at most ${max} characters (got ${text.length}).` };
  if (containsInjectionPatterns(text)) return { ok: false, error: `${what} contains a prompt-boundary pattern; rewrite it as plain text.` };
  if (RUNTIME_MARKERS.test(text) || /^\s*(#{1,6}\s|---)/m.test(text)) {
    return { ok: false, error: `${what} must not contain section headers (#, ---) or the runtime's own markers; write prose.` };
  }
  return { ok: true, value: text };
}

function day(now: Date): string {
  return now.toISOString().slice(0, 10);
}

// ─── Identity ───────────────────────────────────────────────────

export interface IdentityVersion {
  id: string;
  version: number;
  content: string;
  reason: string;
  source: "seed" | "model" | "owner";
  recordedAt: string;
}

function rowToIdentity(row: any): IdentityVersion {
  return { id: row.id, version: row.version, content: row.content, reason: row.reason, source: row.source, recordedAt: row.recorded_at };
}

/** The seed is written once, the first time the identity is read. */
export function ensureSeedIdentity(db: DB, now: Date = new Date()): void {
  const exists = db.prepare("SELECT 1 FROM trader_identity LIMIT 1").get();
  if (exists) return;
  db.prepare(
    "INSERT INTO trader_identity (id, version, content, reason, source, recorded_at) VALUES (?, 1, ?, ?, 'seed', ?)",
  ).run(`i_${ulid()}`, SEED_IDENTITY, "identité de départ écrite par le code", now.toISOString());
}

export function currentIdentity(db: DB, now: Date = new Date()): IdentityVersion {
  ensureSeedIdentity(db, now);
  return rowToIdentity(db.prepare("SELECT * FROM trader_identity ORDER BY version DESC LIMIT 1").get());
}

export function identityHistory(db: DB, limit = 10): IdentityVersion[] {
  return (db.prepare("SELECT * FROM trader_identity ORDER BY version DESC LIMIT ?").all(limit) as any[]).map(rowToIdentity);
}

/** Revisions written by the model on a UTC day (the owner's are not limited). */
export function identityRevisionsToday(db: DB, now: Date = new Date()): number {
  return (db.prepare(
    "SELECT COUNT(*) AS n FROM trader_identity WHERE source = 'model' AND substr(recorded_at, 1, 10) = ?",
  ).get(day(now)) as { n: number }).n;
}

export function reviseIdentity(
  db: DB,
  input: { content: unknown; reason: unknown; source: "model" | "owner" },
  now: Date = new Date(),
): SoulResult<IdentityVersion> {
  const content = cleanText(input.content, IDENTITY_MIN_CHARS, IDENTITY_MAX_CHARS, "The identity");
  if (!content.ok) return content;
  const reason = cleanText(input.reason, 5, REASON_MAX_CHARS, "The reason");
  if (!reason.ok) return reason;
  if (!content.value.includes(IDENTITY_ANCHOR)) {
    return { ok: false, error: `The identity must keep the words "${IDENTITY_ANCHOR}".` };
  }
  const current = currentIdentity(db, now);
  if (content.value === current.content) return { ok: false, error: "The identity is unchanged." };
  if (input.source === "model" && identityRevisionsToday(db, now) >= MAX_IDENTITY_REVISIONS_PER_DAY) {
    return { ok: false, error: `Already revised today (${MAX_IDENTITY_REVISIONS_PER_DAY} per UTC day). Note the change in a reflection and revise tomorrow.` };
  }
  const id = `i_${ulid()}`;
  db.prepare(
    "INSERT INTO trader_identity (id, version, content, reason, source, recorded_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, current.version + 1, content.value, reason.value, input.source, now.toISOString());
  return { ok: true, value: rowToIdentity(db.prepare("SELECT * FROM trader_identity WHERE id = ?").get(id)) };
}

// ─── Reflections ────────────────────────────────────────────────

export interface Reflection {
  id: string;
  kind: ReflectionKind;
  subjectId: string | null;
  content: string;
  recordedAt: string;
}

function rowToReflection(row: any): Reflection {
  return { id: row.id, kind: row.kind, subjectId: row.subject_id, content: row.content, recordedAt: row.recorded_at };
}

export function reflectionsToday(db: DB, now: Date = new Date()): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM trader_reflections WHERE substr(recorded_at, 1, 10) = ?").get(day(now)) as { n: number }).n;
}

/** Scored predictions (void ones teach nothing about judgement) that have no post-mortem yet, oldest first. */
export function predictionsAwaitingPostmortem(db: DB, limit = 20): Prediction[] {
  const ids = db.prepare(
    `SELECT p.id FROM trader_predictions p
     WHERE p.brier IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM trader_reflections r WHERE r.kind = 'postmortem' AND r.subject_id = p.id)
     ORDER BY p.resolved_at ASC, p.id ASC LIMIT ?`,
  ).all(limit) as { id: string }[];
  return ids.map((r) => getPrediction(db, r.id)!);
}

export function writeReflection(
  db: DB,
  input: { kind: unknown; subjectId?: unknown; content: unknown },
  now: Date = new Date(),
): SoulResult<Reflection> {
  const kind = String(input.kind ?? "") as ReflectionKind;
  if (!REFLECTION_KINDS.includes(kind)) return { ok: false, error: `kind must be one of ${REFLECTION_KINDS.join(", ")}.` };
  const content = cleanText(input.content, REFLECTION_MIN_CHARS, REFLECTION_MAX_CHARS, "The reflection");
  if (!content.ok) return content;
  if (reflectionsToday(db, now) >= MAX_REFLECTIONS_PER_DAY) {
    return { ok: false, error: `${MAX_REFLECTIONS_PER_DAY} reflections already written today; keep the rest for tomorrow.` };
  }
  let subjectId: string | null = null;
  if (kind === "postmortem") {
    subjectId = String(input.subjectId ?? "").trim();
    const p = subjectId ? getPrediction(db, subjectId) : undefined;
    if (!p) return { ok: false, error: "A post-mortem needs subject_id: the id of a resolved prediction." };
    if (!p.resolvedAt) return { ok: false, error: `Prediction ${p.id} is not resolved yet: no post-mortem before the outcome.` };
    if (p.brier === null) return { ok: false, error: `Prediction ${p.id} was void (no price at the horizon): nothing to judge; write a session note if the gap matters.` };
    const done = db.prepare("SELECT 1 FROM trader_reflections WHERE kind = 'postmortem' AND subject_id = ?").get(p.id);
    if (done) return { ok: false, error: `Prediction ${p.id} already has its post-mortem; write a session reflection instead.` };
  } else if (kind === "trade") {
    subjectId = String(input.subjectId ?? "").trim();
    const t = subjectId ? getTrade(db, subjectId) : undefined;
    if (!t) return { ok: false, error: "A trade post-mortem needs subject_id: the id of a closed trade (t_...)." };
    const done = db.prepare("SELECT 1 FROM trader_reflections WHERE kind = 'trade' AND subject_id = ?").get(t.id);
    if (done) return { ok: false, error: `Trade ${t.id} already has its post-mortem; write a session reflection instead.` };
  } else if (input.subjectId !== undefined && input.subjectId !== null && String(input.subjectId).trim() !== "") {
    const s = String(input.subjectId).trim();
    if (!getPrediction(db, s) && !getHypothesis(db, s) && !getTrade(db, s)) return { ok: false, error: `Unknown subject_id ${s}.` };
    subjectId = s;
  }
  const id = `r_${ulid()}`;
  db.prepare(
    "INSERT INTO trader_reflections (id, kind, subject_id, content, recorded_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, kind, subjectId, content.value, now.toISOString());
  return { ok: true, value: rowToReflection(db.prepare("SELECT * FROM trader_reflections WHERE id = ?").get(id)) };
}

export function listReflections(db: DB, limit = 10, kind?: ReflectionKind): Reflection[] {
  const rows = kind
    ? db.prepare("SELECT * FROM trader_reflections WHERE kind = ? ORDER BY recorded_at DESC, id DESC LIMIT ?").all(kind, limit)
    : db.prepare("SELECT * FROM trader_reflections ORDER BY recorded_at DESC, id DESC LIMIT ?").all(limit);
  return (rows as any[]).map(rowToReflection);
}

// ─── Lessons ────────────────────────────────────────────────────

export interface Lesson {
  id: string;
  text: string;
  evidenceIds: string[];
  status: "active" | "retired";
  recordedAt: string;
  retiredAt: string | null;
  retiredBy: "model" | "owner" | null;
  retireReason: string | null;
}

function rowToLesson(row: any): Lesson {
  return {
    id: row.id,
    text: row.text,
    evidenceIds: JSON.parse(row.evidence),
    status: row.status,
    recordedAt: row.recorded_at,
    retiredAt: row.retired_at,
    retiredBy: row.retired_by,
    retireReason: row.retire_reason,
  };
}

export function lessonsToday(db: DB, now: Date = new Date()): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM trader_lessons WHERE substr(recorded_at, 1, 10) = ?").get(day(now)) as { n: number }).n;
}

export function activeLessons(db: DB): Lesson[] {
  return (db.prepare("SELECT * FROM trader_lessons WHERE status = 'active' ORDER BY recorded_at ASC").all() as any[]).map(rowToLesson);
}

export function listLessons(db: DB, includeRetired = false): Lesson[] {
  const rows = includeRetired
    ? db.prepare("SELECT * FROM trader_lessons ORDER BY status ASC, recorded_at ASC").all()
    : db.prepare("SELECT * FROM trader_lessons WHERE status = 'active' ORDER BY recorded_at ASC").all();
  return (rows as any[]).map(rowToLesson);
}

export function getLesson(db: DB, id: string): Lesson | undefined {
  const row = db.prepare("SELECT * FROM trader_lessons WHERE id = ?").get(id);
  return row ? rowToLesson(row) : undefined;
}

/**
 * A lesson cites at least one prediction or hypothesis that exists; a
 * resolved prediction or a tested hypothesis is what makes it evidence.
 */
export function addLesson(db: DB, input: { text: unknown; evidenceIds: unknown }, now: Date = new Date()): SoulResult<Lesson> {
  const text = cleanText(input.text, LESSON_MIN_CHARS, LESSON_MAX_CHARS, "The lesson");
  if (!text.ok) return text;
  const raw = Array.isArray(input.evidenceIds) ? input.evidenceIds : typeof input.evidenceIds === "string" ? [input.evidenceIds] : [];
  const ids = [...new Set(raw.map((x) => String(x).trim()).filter(Boolean))];
  if (ids.length === 0) return { ok: false, error: "evidence_ids must name at least one prediction (p_...) or hypothesis (h_...)." };
  if (ids.length > 10) return { ok: false, error: "At most 10 evidence ids per lesson." };
  for (const id of ids) {
    if (!getPrediction(db, id) && !getHypothesis(db, id)) return { ok: false, error: `Unknown evidence id ${id}.` };
  }
  if (lessonsToday(db, now) >= MAX_LESSONS_PER_DAY) {
    return { ok: false, error: `${MAX_LESSONS_PER_DAY} lessons already added today; a lesson is rare and well supported.` };
  }
  const active = activeLessons(db);
  if (active.length >= MAX_ACTIVE_LESSONS) {
    return { ok: false, error: `${MAX_ACTIVE_LESSONS} lessons are active; retire one (retire_lesson) before adding another.` };
  }
  if (active.some((l) => l.text.toLowerCase() === text.value.toLowerCase())) return { ok: false, error: "This lesson already exists." };
  const id = `l_${ulid()}`;
  db.prepare(
    "INSERT INTO trader_lessons (id, text, evidence, status, recorded_at) VALUES (?, ?, ?, 'active', ?)",
  ).run(id, text.value, JSON.stringify(ids), now.toISOString());
  return { ok: true, value: getLesson(db, id)! };
}

export function retireLesson(
  db: DB,
  id: string,
  by: "model" | "owner",
  reason: unknown,
  now: Date = new Date(),
): SoulResult<Lesson> {
  const lesson = getLesson(db, String(id ?? "").trim());
  if (!lesson) return { ok: false, error: `Unknown lesson ${id}.` };
  if (lesson.status === "retired") return { ok: false, error: `Lesson ${lesson.id} is already retired.` };
  const why = cleanText(reason, 3, REASON_MAX_CHARS, "The reason");
  if (!why.ok) return why;
  db.prepare(
    "UPDATE trader_lessons SET status = 'retired', retired_at = ?, retired_by = ?, retire_reason = ? WHERE id = ? AND status = 'active'",
  ).run(now.toISOString(), by, why.value, lesson.id);
  return { ok: true, value: getLesson(db, lesson.id)! };
}

// ─── Daily reflection clock ─────────────────────────────────────

const KV_REFLECTION_MARKER = "sonni.reflection_marker";
const KV_REFLECTION_OPEN = "sonni.reflection_open";
/** The latest resolution the open reflection covers: a prediction resolved during the wake stays due. */
const KV_REFLECTION_UPTO = "sonni.reflection_upto";
const KV_TRADE_MARKER = "sonni.trade_reflection_marker";
const KV_TRADE_UPTO = "sonni.trade_reflection_upto";

/**
 * A reflection is due when a prediction was resolved after the last one.
 * Each wake can carry one; marking it done after a paid turn keeps a
 * model that ignores the instruction from being asked forever.
 */
export function reflectionDue(db: DB): boolean {
  const marker = getKV(db, KV_REFLECTION_MARKER) ?? "";
  const row = db.prepare("SELECT 1 FROM trader_predictions WHERE brier IS NOT NULL AND resolved_at > ? LIMIT 1").get(marker);
  if (row) return true;
  // A closed trade (profit or loss realised by code) deserves its post-mortem too.
  const tradeMarker = getKV(db, KV_TRADE_MARKER) ?? "";
  return !!db.prepare("SELECT 1 FROM trader_trades WHERE closed_at > ? LIMIT 1").get(tradeMarker);
}

export function startReflection(db: DB): void {
  const row = db.prepare("SELECT MAX(resolved_at) AS m FROM trader_predictions WHERE brier IS NOT NULL").get() as { m: string | null };
  setKV(db, KV_REFLECTION_UPTO, row.m ?? "");
  const trades = db.prepare("SELECT MAX(closed_at) AS m FROM trader_trades").get() as { m: string | null };
  setKV(db, KV_TRADE_UPTO, trades.m ?? "");
  setKV(db, KV_REFLECTION_OPEN, "1");
}

export function reflectionOpen(db: DB): boolean {
  return getKV(db, KV_REFLECTION_OPEN) === "1";
}

/**
 * Marks the reflection opened by startReflection as done: the marker moves
 * to the latest resolution it covered, not to the current time, so a
 * prediction resolved during the wake makes the next wake a reflection.
 */
export function markReflectionDone(db: DB, now: Date = new Date()): void {
  const upto = getKV(db, KV_REFLECTION_UPTO);
  setKV(db, KV_REFLECTION_MARKER, upto ? upto : now.toISOString().slice(0, 19) + "Z");
  const tradeUpto = getKV(db, KV_TRADE_UPTO);
  setKV(db, KV_TRADE_MARKER, tradeUpto ? tradeUpto : now.toISOString());
  setKV(db, KV_REFLECTION_OPEN, "0");
}

// ─── Self-report (computed by code) ─────────────────────────────

export interface CalibrationBucket {
  /** Stated-probability range, e.g. "60-80 %". */
  range: string;
  n: number;
  meanStated: number;
  observed: number;
}

export interface GroupScore {
  key: string;
  n: number;
  meanBrier: number;
}

export interface SelfReport {
  at: string;
  scored: { all: number; last30d: number; last7d: number };
  meanBrier: { all: number | null; last30d: number | null; last7d: number | null };
  voided: number;
  open: number;
  calibration: CalibrationBucket[];
  byAsset: GroupScore[];
  byHorizon: GroupScore[];
  byDirection: GroupScore[];
  /** Mean stated probability of the event minus observed frequency; positive = overconfident on "yes". */
  overconfidence: number | null;
  hypotheses: Record<string, number>;
  lessonsActive: number;
  reflections: number;
  identityVersion: number;
  spentTodayCents: number;
  dailyCapCents: number | null;
  /** Virtual portfolio results, computed by code (decision 0003's proof metrics). */
  portfolio: Performance;
  /** Brier against code's reference probability on the same predictions (step 1, 2026-10-08). */
  skill: { all: SkillWindow; last7d: SkillWindow; prev7d: SkillWindow };
  /** Decisions per asset, scored by code from stored prices. */
  decisions7d: DecisionStats;
  decisions30d: DecisionStats;
  lessonsAdded7d: number;
  lessonsRetired7d: number;
}

const BUCKETS = [
  { lo: 0, hi: 0.2, label: "0-20 %" },
  { lo: 0.2, hi: 0.4, label: "20-40 %" },
  { lo: 0.4, hi: 0.6, label: "40-60 %" },
  { lo: 0.6, hi: 0.8, label: "60-80 %" },
  { lo: 0.8, hi: 1.01, label: "80-100 %" },
];

function horizonBucket(p: Prediction): string {
  const hours = (Date.parse(p.horizonUntil) - Date.parse(p.madeAt)) / 3_600_000;
  return hours <= 24 ? "<= 24 h" : hours <= 24 * 7 ? "1-7 d" : "> 7 d";
}

function groupScores(scored: Prediction[], key: (p: Prediction) => string): GroupScore[] {
  const groups = new Map<string, number[]>();
  for (const p of scored) {
    const k = key(p);
    groups.set(k, [...(groups.get(k) ?? []), p.brier!]);
  }
  return [...groups.entries()]
    .map(([k, briers]) => ({ key: k, n: briers.length, meanBrier: briers.reduce((a, b) => a + b, 0) / briers.length }))
    .sort((a, b) => b.n - a.n || a.key.localeCompare(b.key));
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

export function selfReport(db: DB, cfg: TraderConfig, dailyCapCents: number | null, now: Date = new Date()): SelfReport {
  const resolved = (db.prepare("SELECT * FROM trader_predictions WHERE resolved_at IS NOT NULL ORDER BY resolved_at ASC").all() as any[])
    .map((row) => getPrediction(db, row.id)!);
  const scored = resolved.filter((p) => p.brier !== null);
  const since = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
  const last30 = scored.filter((p) => p.resolvedAt! >= since(30));
  const last7 = scored.filter((p) => p.resolvedAt! >= since(7));
  const calibration = BUCKETS.map((b) => {
    const inBucket = scored.filter((p) => p.probability >= b.lo && p.probability < b.hi);
    return {
      range: b.label,
      n: inBucket.length,
      meanStated: mean(inBucket.map((p) => p.probability)) ?? 0,
      observed: mean(inBucket.map((p) => p.outcome!)) ?? 0,
    };
  }).filter((b) => b.n > 0);
  const statedMean = mean(scored.map((p) => p.probability));
  const observedMean = mean(scored.map((p) => p.outcome!));
  const hypotheses: Record<string, number> = {};
  for (const h of listHypotheses(db)) hypotheses[h.status] = (hypotheses[h.status] ?? 0) + 1;
  const open = (db.prepare("SELECT COUNT(*) AS n FROM trader_predictions WHERE resolved_at IS NULL").get() as { n: number }).n;
  const reflections = (db.prepare("SELECT COUNT(*) AS n FROM trader_reflections").get() as { n: number }).n;
  return {
    at: now.toISOString(),
    scored: { all: scored.length, last30d: last30.length, last7d: last7.length },
    meanBrier: { all: mean(scored.map((p) => p.brier!)), last30d: mean(last30.map((p) => p.brier!)), last7d: mean(last7.map((p) => p.brier!)) },
    voided: resolved.length - scored.length,
    open,
    calibration,
    byAsset: groupScores(scored, (p) => p.asset),
    byHorizon: groupScores(scored, horizonBucket),
    byDirection: groupScores(scored, (p) => p.direction),
    overconfidence: statedMean === null || observedMean === null ? null : statedMean - observedMean,
    hypotheses,
    lessonsActive: activeLessons(db).length,
    reflections,
    identityVersion: currentIdentity(db, now).version,
    spentTodayCents: inferenceGetDailyCost(db, now.toISOString().slice(0, 10)),
    dailyCapCents,
    portfolio: performance(db, cfg, summarizeFinances(db).inferenceConsumedCents, now),
    skill: { all: skillBetween(db, null, null), last7d: skillBetween(db, since(7), null), prev7d: skillBetween(db, since(14), since(7)) },
    decisions7d: decisionStats(db, since(7)),
    decisions30d: decisionStats(db, since(30)),
    lessonsAdded7d: (db.prepare("SELECT COUNT(*) AS n FROM trader_lessons WHERE recorded_at >= ?").get(since(7)) as { n: number }).n,
    lessonsRetired7d: (db.prepare("SELECT COUNT(*) AS n FROM trader_lessons WHERE retired_at >= ?").get(since(7)) as { n: number }).n,
  };
}

function skillEn(w: SkillWindow): string {
  if (w.n === 0 || w.brier === null || w.refBrier === null) return "no scored prediction with code's odds";
  return `n=${w.n}, Brier ${w.brier.toFixed(3)} vs reference ${w.refBrier.toFixed(3)}, skill ${w.skill === null ? "n/a" : `${w.skill >= 0 ? "+" : ""}${w.skill.toFixed(2)}`}`;
}

function decisionsEn(d: DecisionStats): string {
  if (d.total === 0) return "none";
  const actions = Object.entries(d.byAction).map(([k, v]) => `${k} ${v}`).join(", ");
  return `${d.total} (${actions}); right side at 24 h ${d.good24h}/${d.scored24h}, at 7 d ${d.good7d}/${d.scored7d}; ` +
    `staying out at 7 d: ${d.flatAvoided} loss(es) avoided, ${d.flatMissed} gain(s) missed`;
}

const f2fr = (v: number) => v.toFixed(3).replace(".", ",");

function skillFr(w: SkillWindow): string {
  if (w.n === 0 || w.brier === null || w.refBrier === null || w.skill === null) return "pas encore de prédiction notée avec la fiche du code";
  const pctv = Math.round(Math.abs(w.skill) * 100);
  const verdict = Math.abs(w.skill) < 0.02 ? "au niveau de la référence" : w.skill > 0 ? `mieux que la référence (+${pctv} %)` : `moins bien que la référence (−${pctv} %)`;
  return `Brier ${f2fr(w.brier)} contre ${f2fr(w.refBrier)} sur ${w.n} prédiction${w.n > 1 ? "s" : ""} : ${verdict}`;
}

/** For the owner (/bilan), in French: is Sonni learning? Every figure is computed by code. */
export function learningScoreboardFr(r: SelfReport): string[] {
  const d = r.decisions7d;
  const lines = [
    "Est-ce qu'il apprend ? (calculé par le code)",
    `- Justesse face à la référence (le hasard, à la volatilité récente) : ${skillFr(r.skill.all)}.`,
    `- Tendance : 7 derniers jours — ${skillFr(r.skill.last7d)} ; 7 jours d'avant — ${skillFr(r.skill.prev7d)}.`,
    d.total === 0
      ? "- Décisions par actif (7 derniers jours) : aucune encore."
      : `- Décisions par actif (7 derniers jours) : ${d.total} ; du bon côté à 24 h : ${d.good24h} sur ${d.scored24h} ; à 7 jours : ${d.good7d} sur ${d.scored7d} ; ` +
        `rester en dehors : ${d.flatAvoided} perte${d.flatAvoided > 1 ? "s" : ""} évitée${d.flatAvoided > 1 ? "s" : ""}, ${d.flatMissed} gain${d.flatMissed > 1 ? "s" : ""} manqué${d.flatMissed > 1 ? "s" : ""}.`,
    `- Leçons cette semaine : ${r.lessonsAdded7d} ajoutée${r.lessonsAdded7d > 1 ? "s" : ""}, ${r.lessonsRetired7d} retirée${r.lessonsRetired7d > 1 ? "s" : ""} (${r.lessonsActive} active${r.lessonsActive > 1 ? "s" : ""}).`,
    "Ton rituel : lis ce bilan une fois par semaine et laisse une /note si quelque chose te frappe ; tes notes pèsent dans ce qu'il apprend.",
  ];
  return lines;
}

const pctSigned = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)} %`;
const pctSignedFr = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2).replace(".", ",")} %`;
const eurFr = (v: number) => `${v >= 0 ? "" : "−"}${Math.abs(v).toFixed(2).replace(".", ",")} €`;

const f3 = (v: number | null) => (v === null ? "n/a" : v.toFixed(3));
const pct = (v: number) => `${Math.round(v * 100)} %`;

/** For the model (memory pack and reflection), in English like the rest of the pack. */
export function formatSelfReport(r: SelfReport): string {
  const lines = [
    `SELF-REPORT (computed by code at ${r.at.slice(0, 16).replace("T", " ")} UTC)`,
    `- Scored predictions: ${r.scored.all} (last 30 d ${r.scored.last30d}, last 7 d ${r.scored.last7d}); open ${r.open}; void ${r.voided}.`,
    `- Mean Brier: all ${f3(r.meanBrier.all)}, 30 d ${f3(r.meanBrier.last30d)}, 7 d ${f3(r.meanBrier.last7d)} (0 perfect, 0.25 = always 50 %).`,
  ];
  if (r.calibration.length) {
    lines.push("- Calibration (stated probability vs how often the event happened):");
    for (const b of r.calibration) lines.push(`  ${b.range}: ${b.n} predictions, stated ${pct(b.meanStated)}, happened ${pct(b.observed)}`);
    if (r.overconfidence !== null && r.scored.all >= 5) {
      const o = r.overconfidence;
      lines.push(`- Overall: stated minus observed = ${o >= 0 ? "+" : ""}${pct(o)} ` +
        (Math.abs(o) < 0.05 ? "(well calibrated so far)" : o > 0 ? "(overconfident: events happen less often than you say)" : "(underconfident: events happen more often than you say)"));
    }
  } else {
    lines.push("- Calibration: no scored prediction yet.");
  }
  const group = (label: string, g: GroupScore[]) => {
    if (g.length) lines.push(`- Brier by ${label}: ${g.map((x) => `${x.key} ${f3(x.meanBrier)} (n=${x.n})`).join(", ")}`);
  };
  group("asset", r.byAsset);
  group("horizon", r.byHorizon);
  group("direction", r.byDirection);
  const hyp = Object.entries(r.hypotheses).map(([k, v]) => `${v} ${k}`).join(", ") || "none";
  lines.push(`- Hypotheses: ${hyp}. Active lessons: ${r.lessonsActive}. Reflections written: ${r.reflections}. Identity version ${r.identityVersion}.`);
  lines.push(`- Skill vs code's reference (random walk at recent volatility; above 0 = you beat it): all ${skillEn(r.skill.all)}; ` +
    `last 7 d ${skillEn(r.skill.last7d)}; previous 7 d ${skillEn(r.skill.prev7d)}.`);
  lines.push(`- Decisions, last 7 d: ${decisionsEn(r.decisions7d)}. Lessons last 7 d: +${r.lessonsAdded7d} added, ${r.lessonsRetired7d} retired.`);
  lines.push(`- Spend today: $${(r.spentTodayCents / 100).toFixed(2)}${r.dailyCapCents !== null ? ` of $${(r.dailyCapCents / 100).toFixed(2)}` : ""}.`);
  const p = r.portfolio;
  if (p.contributedEur === 0) {
    lines.push("- Portfolio: not funded yet (opens at the first price).");
  } else {
    lines.push(`- Portfolio: equity ${p.equityEur.toFixed(2)} EUR on ${p.contributedEur.toFixed(2)} contributed (${pctSigned(p.pnlPct)} after fees` +
      `${p.change7dPct !== null ? `, 7 d ${pctSigned(p.change7dPct)}` : ""}${p.change30dPct !== null ? `, 30 d ${pctSigned(p.change30dPct)}` : ""}` +
      `${p.maxDrawdownPct !== null ? `, max drawdown ${p.maxDrawdownPct.toFixed(2)} %` : ""}).`);
    lines.push(`- Trades closed: ${p.tradesClosed}${p.winRate !== null ? `, win rate ${Math.round(p.winRate * 100)} %, mean ${pctSigned(p.avgTradePct!)} per trade` : ""}; ` +
      `fees ${p.feesEur.toFixed(2)} EUR; stops hit ${p.stops}; ` +
      `self-funding ratio ${p.selfFundingRatio === null ? "n/a" : p.selfFundingRatio.toFixed(2)} (virtual gain / inference spend; 1 = paid for itself).`);
  }
  return lines.join("\n");
}

/** For the owner (/bilan), in French. */
export function formatSelfReportFr(r: SelfReport): string {
  const lines = [
    "=== BILAN DE SONNI (calculé par le code) ===",
    ...learningScoreboardFr(r),
    "",
    `Prédictions notées : ${r.scored.all} (30 derniers jours ${r.scored.last30d}, 7 derniers jours ${r.scored.last7d}) ; ouvertes ${r.open} ; annulées ${r.voided}.`,
    `Score de Brier moyen : ${f3(r.meanBrier.all)} (30 j ${f3(r.meanBrier.last30d)}, 7 j ${f3(r.meanBrier.last7d)}) — 0 = parfait, 0,25 = toujours 50 %.`,
  ];
  if (r.calibration.length) {
    lines.push("Calibration (probabilité annoncée / fréquence réelle) :");
    for (const b of r.calibration) lines.push(`- ${b.range} : ${b.n} prédictions, annoncé ${pct(b.meanStated)}, arrivé ${pct(b.observed)}`);
    if (r.overconfidence !== null && r.scored.all >= 5) {
      const o = r.overconfidence;
      lines.push(Math.abs(o) < 0.05 ? "Bien calibré pour l'instant." : o > 0
        ? `Trop sûr de lui : les événements arrivent ${pct(Math.abs(o))} moins souvent qu'annoncé.`
        : `Trop prudent : les événements arrivent ${pct(Math.abs(o))} plus souvent qu'annoncé.`);
    }
  } else {
    lines.push("Calibration : aucune prédiction notée pour l'instant.");
  }
  if (r.byAsset.length) lines.push(`Par actif : ${r.byAsset.map((x) => `${x.key} ${f3(x.meanBrier)} (${x.n})`).join(", ")}`);
  if (r.byHorizon.length) lines.push(`Par horizon : ${r.byHorizon.map((x) => `${x.key} ${f3(x.meanBrier)} (${x.n})`).join(", ")}`);
  const hyp = Object.entries(r.hypotheses).map(([k, v]) => `${v} ${k}`).join(", ") || "aucune";
  lines.push(`Intuitions : ${hyp}. Leçons actives : ${r.lessonsActive}. Réflexions : ${r.reflections}. Identité version ${r.identityVersion}.`);
  lines.push(`Dépense du jour : ${(r.spentTodayCents / 100).toFixed(2)} $${r.dailyCapCents !== null ? ` sur ${(r.dailyCapCents / 100).toFixed(2)} $` : ""}.`);
  const p = r.portfolio;
  lines.push("", "Portefeuille virtuel (les trois preuves de la décision 0003, calculées par le code) :");
  if (p.contributedEur === 0) {
    lines.push("- pas encore ouvert : il s'ouvre au premier relevé de prix.");
  } else {
    lines.push(`- Rendement après frais : ${pctSignedFr(p.pnlPct)} (${eurFr(p.pnlEur)} sur ${eurFr(p.contributedEur)} versés)` +
      `${p.change30dPct !== null ? `, ${pctSignedFr(p.change30dPct)} sur 30 jours` : ""}${p.maxDrawdownPct !== null ? `, pire recul ${pctSignedFr(-p.maxDrawdownPct)}` : ""}.`);
    lines.push(`- Erreurs : ${p.tradesClosed} opération${p.tradesClosed > 1 ? "s" : ""} close${p.tradesClosed > 1 ? "s" : ""}` +
      `${p.winRate !== null ? `, ${Math.round(p.winRate * 100)} % gagnantes, ${pctSignedFr(p.avgTradePct!)} en moyenne` : ""}, ${p.stops} stop${p.stops > 1 ? "s" : ""} déclenché${p.stops > 1 ? "s" : ""}, frais ${eurFr(p.feesEur)}.`);
    lines.push(`- Autofinancement : ${p.selfFundingRatio === null ? "pas encore mesurable" : `${p.selfFundingRatio.toFixed(2).replace(".", ",")} (gain virtuel / coût de l'IA ; 1 = il paie sa propre IA)`}.`);
  }
  return lines.join("\n");
}
