/**
 * Sonni curiosity: self-wakes and watches (docs/MEMORY.md section 5, step 3)
 *
 * Code decides when something is worth a paid look and wakes the sleeping
 * agent: a large move, an event day, the morning after an event, resolved
 * predictions, or a watch the model set itself (a price level, a move, a
 * date to revisit a question). Every trigger is logged, delivered or not,
 * so the next memory pack can say what happened meanwhile. Wakes are
 * capped per day and spaced out; none while paused, dead or sleeping on
 * a budget cap (the caller's gate). Reasons are short and mostly numeric,
 * readable by the model and the owner alike.
 */

import type Database from "better-sqlite3";
import { ulid } from "ulid";
import { getKV, setKV } from "../money-lab/journal.js";
import { containsInjectionPatterns } from "../soul/validator.js";
import type { TraderConfig } from "./config.js";
import { EVENT_LABEL_FR, type EventType } from "./events.js";
import { ageMinutes, isoSeconds, latestPrice, priceAtOrAfter, priceAtOrBefore, type PricePoint } from "./prices.js";
import type { SoulResult } from "./soul.js";
import { listPositions, positionProblem } from "./portfolio.js";
import { plainPrice } from "./format.js";

type DB = Database.Database;

export const SONNI_WAKE_SOURCE = "sonni_curiosity";
/** Wake events whose source starts with this are Sonni's own (history, curiosity). */
export const SONNI_WAKE_PREFIX = "sonni_";
export const MOVE_WINDOW_MINUTES = 60;
export const MOVE_COOLDOWN_HOURS = 6;
export const RESOLVED_COOLDOWN_HOURS = 6;
/** UTC hours at which an event-day wake and a morning-after wake become due. */
export const EVENT_TODAY_HOUR = 7;
export const EVENT_REACTION_HOUR = 6;
export const MAX_OPEN_WATCHES = 15;
export const MAX_WATCH_DAYS = 30;
export const WATCH_KINDS = ["price", "move", "time"] as const;
export type WatchKind = (typeof WATCH_KINDS)[number];
const NOTE_MAX = 300;
const KV_SETTLED_REPORTED = "sonni.orders_reported_until";
const KV_RESOLVED_REPORTED = "sonni.resolved_reported_until";

export function isSonniWake(event: { source: string }): boolean {
  return event.source.startsWith(SONNI_WAKE_PREFIX);
}

export interface Trigger {
  /** Dedup key, e.g. "move:BTC" or "event_today:fomc:2026-10-29". */
  key: string;
  reason: string;
}

export interface WakeRecord {
  id: string;
  source: string;
  key: string;
  reason: string;
  at: string;
  delivered: boolean;
}

function rowToWake(row: any): WakeRecord {
  return { id: row.id, source: row.source, key: row.key, reason: row.reason, at: row.at, delivered: row.delivered === 1 };
}

function lastWakeAt(db: DB, key: string): string | undefined {
  const row = db.prepare("SELECT at FROM trader_wakes WHERE key = ? ORDER BY at DESC LIMIT 1").get(key) as { at: string } | undefined;
  return row?.at;
}

function hoursSince(iso: string | undefined, now: Date): number {
  return iso ? (now.getTime() - Date.parse(iso)) / 3_600_000 : Infinity;
}

function pct(change: number): string {
  return `${change >= 0 ? "+" : ""}${change.toFixed(1)} %`;
}

/**
 * The reference price for a move over a window ending at `last`: the price
 * at or before the window start, or, when history is shorter than the
 * window (a new asset, a fresh start), the earliest price inside it, so a
 * real move is never missed for lack of an older point.
 */
function windowReference(db: DB, asset: string, last: PricePoint, windowMs: number): PricePoint | undefined {
  const start = isoSeconds(new Date(Date.parse(last.ts) - windowMs));
  const before = priceAtOrBefore(db, asset, start);
  if (before) return before;
  const first = priceAtOrAfter(db, asset, start, last.ts);
  return first && first.ts !== last.ts ? first : undefined;
}

// ─── Watches ────────────────────────────────────────────────────

export interface Watch {
  id: string;
  kind: WatchKind;
  asset: string | null;
  direction: "above" | "below" | null;
  value: number | null;
  windowHours: number | null;
  dueAt: string | null;
  note: string;
  createdAt: string;
  expiresAt: string;
  firedAt: string | null;
  firedReason: string | null;
  cancelledAt: string | null;
}

function rowToWatch(row: any): Watch {
  return {
    id: row.id,
    kind: row.kind,
    asset: row.asset,
    direction: row.direction,
    value: row.value,
    windowHours: row.window_hours,
    dueAt: row.due_at,
    note: row.note,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    firedAt: row.fired_at,
    firedReason: row.fired_reason,
    cancelledAt: row.cancelled_at,
  };
}

export function getWatch(db: DB, id: string): Watch | undefined {
  const row = db.prepare("SELECT * FROM trader_watches WHERE id = ?").get(id);
  return row ? rowToWatch(row) : undefined;
}

/** Watches that can still fire. */
export function openWatches(db: DB, now: Date = new Date()): Watch[] {
  return (db.prepare(
    "SELECT * FROM trader_watches WHERE fired_at IS NULL AND cancelled_at IS NULL AND expires_at > ? ORDER BY created_at ASC",
  ).all(now.toISOString()) as any[]).map(rowToWatch);
}

export function recentWatches(db: DB, limit = 20): Watch[] {
  return (db.prepare("SELECT * FROM trader_watches ORDER BY created_at DESC LIMIT ?").all(limit) as any[]).map(rowToWatch);
}

export interface WatchInput {
  kind: unknown;
  asset?: unknown;
  direction?: unknown;
  value?: unknown;
  windowHours?: unknown;
  dueAt?: unknown;
  note: unknown;
  expiresDays?: unknown;
}

export function setWatch(db: DB, cfg: TraderConfig, input: WatchInput, now: Date = new Date()): SoulResult<Watch> {
  const kind = String(input.kind ?? "") as WatchKind;
  if (!WATCH_KINDS.includes(kind)) return { ok: false, error: `kind must be one of ${WATCH_KINDS.join(", ")}.` };
  const note = String(input.note ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (note.length < 5 || note.length > NOTE_MAX) return { ok: false, error: `note must be 5 to ${NOTE_MAX} characters: what to check when it fires.` };
  // The note comes back to the model as a wake reason: plain text only.
  if (containsInjectionPatterns(note)) return { ok: false, error: "note contains a prompt-boundary pattern; write it as plain text." };
  if (openWatches(db, now).length >= MAX_OPEN_WATCHES) {
    return { ok: false, error: `${MAX_OPEN_WATCHES} watches are already open; cancel one first.` };
  }
  const days = input.expiresDays === undefined ? MAX_WATCH_DAYS : Number(input.expiresDays);
  if (!Number.isFinite(days) || days < 1 || days > MAX_WATCH_DAYS) return { ok: false, error: `expires_days must be 1 to ${MAX_WATCH_DAYS}.` };
  let asset: string | null = null;
  let direction: "above" | "below" | null = null;
  let value: number | null = null;
  let windowHours: number | null = null;
  let dueAt: string | null = null;
  if (kind === "price" || kind === "move") {
    asset = String(input.asset ?? "").trim().toUpperCase();
    if (!cfg.assets.some((a) => a.symbol === asset)) return { ok: false, error: `Unknown asset ${asset || "(none)"}; followed: ${cfg.assets.map((a) => a.symbol).join(", ")}.` };
    value = Number(input.value);
    if (!Number.isFinite(value) || value <= 0) return { ok: false, error: kind === "price" ? "value must be a price in EUR above 0." : "value must be a move in % above 0." };
  }
  if (kind === "price") {
    direction = String(input.direction ?? "") as "above" | "below";
    if (direction !== "above" && direction !== "below") return { ok: false, error: "direction must be above or below." };
    const last = latestPrice(db, asset!);
    if (last && ((direction === "above" && last.price > value!) || (direction === "below" && last.price < value!))) {
      return { ok: false, error: `${asset} is already ${direction} ${plainPrice(value!)} EUR (${plainPrice(last.price)} EUR): the watch would fire at once.` };
    }
  } else if (kind === "move") {
    windowHours = Number(input.windowHours ?? 24);
    if (!Number.isInteger(windowHours) || windowHours < 1 || windowHours > 24 * 7) return { ok: false, error: "window_hours must be an integer from 1 to 168." };
    if (value! > 50) return { ok: false, error: "value (move in %) must be at most 50." };
  } else {
    const due = Date.parse(String(input.dueAt ?? ""));
    if (!Number.isFinite(due)) return { ok: false, error: "due_at must be an ISO date-time, e.g. 2026-10-30T08:00:00Z." };
    if (due <= now.getTime()) return { ok: false, error: "due_at must be in the future." };
    if (due > now.getTime() + MAX_WATCH_DAYS * 86_400_000) return { ok: false, error: `due_at must be within ${MAX_WATCH_DAYS} days.` };
    dueAt = new Date(due).toISOString();
  }
  const expiresAt = new Date(Math.max(now.getTime() + days * 86_400_000, dueAt ? Date.parse(dueAt) + 3_600_000 : 0)).toISOString();
  const id = `w_${ulid()}`;
  db.prepare(
    `INSERT INTO trader_watches (id, kind, asset, direction, value, window_hours, due_at, note, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, kind, asset, direction, value, windowHours, dueAt, note, now.toISOString(), expiresAt);
  return { ok: true, value: getWatch(db, id)! };
}

export function cancelWatch(db: DB, id: unknown, now: Date = new Date()): SoulResult<Watch> {
  const w = getWatch(db, String(id ?? "").trim());
  if (!w) return { ok: false, error: `Unknown watch ${id}.` };
  if (w.firedAt) return { ok: false, error: `Watch ${w.id} already fired.` };
  if (w.cancelledAt) return { ok: false, error: `Watch ${w.id} is already cancelled.` };
  db.prepare("UPDATE trader_watches SET cancelled_at = ? WHERE id = ? AND fired_at IS NULL AND cancelled_at IS NULL").run(now.toISOString(), w.id);
  return { ok: true, value: getWatch(db, w.id)! };
}

export function describeWatch(w: Watch): string {
  const cond = w.kind === "price"
    ? `${w.asset} ${w.direction} ${plainPrice(w.value!)} EUR`
    : w.kind === "move"
      ? `${w.asset} moves ${w.value} % or more within ${w.windowHours} h`
      : `at ${w.dueAt!.slice(0, 16).replace("T", " ")} UTC`;
  return `${w.id} [${w.kind}] ${cond} — ${w.note}`;
}

/** Fires the watches whose condition holds; returns the triggers they produce. */
function fireWatches(db: DB, now: Date): Trigger[] {
  const out: Trigger[] = [];
  const fire = db.prepare("UPDATE trader_watches SET fired_at = ?, fired_reason = ? WHERE id = ? AND fired_at IS NULL AND cancelled_at IS NULL");
  for (const w of openWatches(db, now)) {
    // The condition is stated by code; the note is quoted as the model's own earlier words.
    let condition: string | null = null;
    if (w.kind === "time") {
      if (w.dueAt! <= now.toISOString()) condition = "the time you set has come";
    } else {
      const last = latestPrice(db, w.asset!);
      if (!last) continue;
      if (w.kind === "price") {
        const hit = w.direction === "above" ? last.price > w.value! : last.price < w.value!;
        if (hit) condition = `${w.asset} is ${w.direction} ${plainPrice(w.value!)} EUR (${plainPrice(last.price)} EUR)`;
      } else {
        const past = windowReference(db, w.asset!, last, w.windowHours! * 3_600_000);
        if (past) {
          const change = ((last.price - past.price) / past.price) * 100;
          if (Math.abs(change) >= w.value!) condition = `${w.asset} moved ${pct(change)} in ${w.windowHours} h`;
        }
      }
    }
    if (condition) {
      const reason = `${condition}; your note was: "${w.note}"`;
      fire.run(now.toISOString(), reason, w.id);
      out.push({ key: `watch:${w.id}`, reason: `your watch ${w.id} fired: ${reason}` });
    }
  }
  return out;
}

// ─── Triggers ───────────────────────────────────────────────────

/**
 * Triggers that hold right now and are not in their cooldown. Watches are
 * marked fired here even when the wake is not delivered: the model sees
 * them in its next pack.
 */
export function evaluateTriggers(db: DB, cfg: TraderConfig, now: Date = new Date()): Trigger[] {
  const out: Trigger[] = [];
  const threshold = cfg.curiosity.moveAlertPct;

  for (const asset of cfg.assets) {
    const last = latestPrice(db, asset.symbol);
    // A stale price (collection down) cannot be a move worth a wake: nothing changed.
    if (!last || ageMinutes(last, now) > cfg.staleMinutes) continue;
    const past = windowReference(db, asset.symbol, last, MOVE_WINDOW_MINUTES * 60_000);
    if (!past) continue;
    const change = ((last.price - past.price) / past.price) * 100;
    const key = `move:${asset.symbol}`;
    if (Math.abs(change) >= threshold && hoursSince(lastWakeAt(db, key), now) >= MOVE_COOLDOWN_HOURS) {
      out.push({ key, reason: `${asset.symbol} ${pct(change)} in ${MOVE_WINDOW_MINUTES} min (${plainPrice(past.price)} -> ${plainPrice(last.price)} EUR)` });
    }
  }

  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  const events = db.prepare("SELECT type, day FROM trader_events WHERE day IN (?, ?) ORDER BY day, type").all(today, yesterday) as { type: EventType; day: string }[];
  for (const e of events) {
    const label = EVENT_LABEL_FR[e.type] ?? e.type;
    if (e.day === today && now.getUTCHours() >= EVENT_TODAY_HOUR) {
      const key = `event_today:${e.type}:${e.day}`;
      if (!lastWakeAt(db, key)) out.push({ key, reason: `today: ${label} (${e.type} ${e.day})` });
    }
    if (e.day === yesterday && now.getUTCHours() >= EVENT_REACTION_HOUR) {
      const key = `event_reaction:${e.type}:${e.day}`;
      if (!lastWakeAt(db, key)) out.push({ key, reason: `the morning after ${label} (${e.type} ${e.day}): check the reaction` });
    }
  }

  // Resolutions already reported are remembered by their resolved_at (same precision as the
  // predictions table), not by the wake time, so one resolution is never reported twice.
  const lastResolvedWake = lastWakeAt(db, "resolved");
  const reportedUntil = getKV(db, KV_RESOLVED_REPORTED) ?? "";
  const resolved = db.prepare(
    "SELECT id, outcome, void_reason, resolved_at FROM trader_predictions WHERE resolved_at IS NOT NULL AND resolved_at > ? ORDER BY resolved_at ASC",
  ).all(reportedUntil) as { id: string; outcome: 0 | 1 | null; void_reason: string | null; resolved_at: string }[];
  if (resolved.length > 0 && hoursSince(lastResolvedWake, now) >= RESOLVED_COOLDOWN_HOURS) {
    const summary = resolved.slice(0, 5).map((p) => `${p.id} ${p.void_reason ? "void" : p.outcome === 1 ? "happened" : "did not happen"}`).join(", ");
    out.push({ key: "resolved", reason: `${resolved.length} prediction(s) resolved: ${summary}${resolved.length > 5 ? ", ..." : ""}` });
    setKV(db, KV_RESOLVED_REPORTED, resolved[resolved.length - 1].resolved_at);
  }

  // Portfolio: what code did that the model did not plan, since the last report: stops and expiries
  // (a plain fill of its own order waits for the next session, where the pack shows it; a paid wake
  // for an expected event would also block, by the spacing rule, a wake that matters). Remembered
  // by settled_at over all settled orders, like resolutions, so nothing is reported twice.
  const settledUntil = getKV(db, KV_SETTLED_REPORTED) ?? "";
  const settled = db.prepare(
    "SELECT id, asset, side, origin, status, fill_price, settled_at FROM trader_orders WHERE settled_at IS NOT NULL AND settled_at > ? AND status != 'cancelled' ORDER BY settled_at ASC",
  ).all(settledUntil) as { id: string; asset: string; side: string; origin: string; status: string; fill_price: number | null; settled_at: string }[];
  const unplanned = settled.filter((o) => o.origin === "stop" || o.status === "expired");
  if (unplanned.length > 0) {
    const summary = unplanned.slice(0, 5).map((o) =>
      `${o.id} ${o.origin === "stop" ? "STOP " : ""}${o.side} ${o.asset} ${o.status}${o.fill_price ? ` at ${plainPrice(o.fill_price)} EUR` : ""}`).join(", ");
    out.push({ key: "orders", reason: `${unplanned.length} order(s) settled by code without your decision: ${summary}${unplanned.length > 5 ? ", ..." : ""}` });
  }
  if (settled.length > 0) setKV(db, KV_SETTLED_REPORTED, settled[settled.length - 1].settled_at);
  const nowIso = isoSeconds(now);
  for (const p of listPositions(db)) {
    // A position code cannot value cannot be sold or managed: no paid wake for its horizon (step 0.3).
    if (!p.horizonUntil || p.horizonUntil > nowIso || positionProblem(p)) continue;
    const key = `horizon:${p.asset}:${p.horizonUntil}`;
    if (!lastWakeAt(db, key)) out.push({ key, reason: `your ${p.asset} position reached its horizon (${p.horizonUntil}): keep it with a new horizon (manage_position) or sell` });
  }

  out.push(...fireWatches(db, now));
  return out;
}

// ─── Wake log and tick ──────────────────────────────────────────

export function recordWake(db: DB, source: string, trigger: Trigger, delivered: boolean, now: Date): WakeRecord {
  const id = `k_${ulid()}`;
  db.prepare("INSERT INTO trader_wakes (id, source, key, reason, at, delivered) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, source, trigger.key, trigger.reason, now.toISOString(), delivered ? 1 : 0);
  return rowToWake(db.prepare("SELECT * FROM trader_wakes WHERE id = ?").get(id));
}

/** Self-wakes delivered on a UTC day. */
export function wakesDeliveredToday(db: DB, now: Date = new Date()): number {
  return (db.prepare(
    "SELECT COUNT(DISTINCT at) AS n FROM trader_wakes WHERE delivered = 1 AND substr(at, 1, 10) = ?",
  ).get(now.toISOString().slice(0, 10)) as { n: number }).n;
}

export function lastDeliveredWakeAt(db: DB): string | undefined {
  const row = db.prepare("SELECT at FROM trader_wakes WHERE delivered = 1 ORDER BY at DESC LIMIT 1").get() as { at: string } | undefined;
  return row?.at;
}

export function wakesSince(db: DB, since: string, limit = 20): WakeRecord[] {
  return (db.prepare("SELECT * FROM trader_wakes WHERE at > ? ORDER BY at DESC LIMIT ?").all(since, limit) as any[]).map(rowToWake);
}

export interface WakeGate {
  /** True when a wake would start a paid cycle now (sleeping, not paused, not on a budget cap). */
  canWake(): boolean;
  wake(source: string, reason: string): void;
}

export interface WakeGateState {
  /** The agent state persisted by the runtime ("sleeping", "running", "dead"...). */
  state: string;
  paused: boolean;
  /** KV sleep_reason; a budget sleep starts with "plafond" (src/agent/loop.ts). */
  sleepReason: string | undefined;
  /** True once the main loop has entered its sleep loop after a cycle (not the state left by a shutdown). */
  loopSlept: boolean;
}

/**
 * The one rule for delivering a self-wake, shared by index.ts and the
 * tests: only a sleeping, unpaused agent that is not resting on a budget
 * cap nor in the long sleep that follows cycles without progress
 * (src/money-lab/cycle.ts), and only once the loop has really slept in
 * this process. A refused trigger is still logged for the next pack.
 */
export function canDeliverWake(s: WakeGateState): boolean {
  const reason = String(s.sleepReason ?? "");
  return s.loopSlept && s.state === "sleeping" && !s.paused && !reason.startsWith("plafond") && !reason.includes("sans progrès");
}

export interface CuriosityOutcome {
  triggered: Trigger[];
  delivered: boolean;
  reason: string | null;
}

/**
 * Evaluate triggers, log them, and wake the agent at most once per tick
 * when the gate and the daily cap allow it. Delivered or not, the
 * triggers are logged, so a trigger fired while the agent was awake
 * appears in its next memory pack instead of being lost.
 */
export function curiosityTick(db: DB, cfg: TraderConfig, gate: WakeGate, now: Date = new Date()): CuriosityOutcome {
  const triggered = evaluateTriggers(db, cfg, now);
  if (triggered.length === 0) return { triggered, delivered: false, reason: null };
  const spaced = (now.getTime() - (lastDeliveredWakeAt(db) ? Date.parse(lastDeliveredWakeAt(db)!) : 0)) >= cfg.curiosity.minMinutesBetweenWakes * 60_000;
  const underCap = wakesDeliveredToday(db, now) < cfg.curiosity.maxSelfWakesPerDay;
  const deliver = spaced && underCap && gate.canWake();
  const reason = triggered.map((t) => t.reason).join("; ").slice(0, 600);
  db.transaction(() => {
    for (const t of triggered) recordWake(db, SONNI_WAKE_SOURCE, t, deliver, now);
  })();
  if (deliver) gate.wake(SONNI_WAKE_SOURCE, reason);
  return { triggered, delivered: deliver, reason: deliver ? reason : null };
}

/** For the owner (/reveils): the last wakes in French. */
export function formatWakesFr(db: DB, cfg: TraderConfig, now: Date = new Date()): string {
  const rows = wakesSince(db, new Date(now.getTime() - 7 * 86_400_000).toISOString(), 30);
  const head = `Réveils de Sonni (aujourd'hui ${wakesDeliveredToday(db, now)} sur ${cfg.curiosity.maxSelfWakesPerDay} au maximum ; ` +
    `seuil de mouvement ${cfg.curiosity.moveAlertPct} % en 1 h) :`;
  if (rows.length === 0) return `${head}\n- aucun déclencheur ces 7 derniers jours`;
  return [head, ...rows.map((w) => `- ${w.at.slice(0, 16).replace("T", " ")} ${w.delivered ? "réveillé" : "noté"} : ${w.reason.slice(0, 160)}`)].join("\n");
}
