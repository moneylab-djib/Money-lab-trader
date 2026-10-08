/**
 * Evening consolidation (step C3): one scheduled paid turn a day, in the
 * owner's evening before the 20:00 summary, where the model writes the
 * post-mortems still due, counts trap hits, rewrites the dossiers that
 * changed and leaves one "daily" reflection. Code decides when it is
 * due (local time, once per local day), wakes the sleeping agent through
 * its own wake event and marks the day done only after a paid turn ran,
 * so a paused or budget-blocked evening is not counted. Costs one turn
 * (Sonnet) a day within the owner's caps.
 */

import type Database from "better-sqlite3";
import { getKV, setKV } from "../money-lab/journal.js";
import type { TraderConfig } from "./config.js";

type DB = Database.Database;

export const CONSOLIDATION_WAKE_SOURCE = "sonni_evening";
/**
 * Kept for the evening turn: until it has run, a day-time paid call is not
 * started once the UTC day's spend reaches the daily cap minus this (owner
 * messages excepted). The turn itself usually costs 15 to 30 cents.
 */
export const CONSOLIDATION_RESERVE_CENTS = 40;
export const CONSOLIDATION_WAKE_REASON = "evening consolidation due: the day's post-mortems, trap hits, dossiers and a daily note";
const KV_DONE_DAY = "sonni.consolidation_done_day";
const KV_PENDING_DAY = "sonni.consolidation_pending_day";

export function localDay(now: Date, tz: string): string {
  return now.toLocaleDateString("en-CA", { timeZone: tz });
}

export function localMinutes(now: Date, tz: string): number {
  const parts = now.toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });
  const [h, m] = parts.split(":").map(Number);
  return h * 60 + m;
}

/** Due from the configured local time until midnight, once per local day, while not done. */
export function consolidationDue(db: DB, cfg: TraderConfig, now: Date = new Date()): boolean {
  const tz = cfg.timeZone;
  const day = localDay(now, tz);
  if (getKV(db, KV_DONE_DAY) === day) return false;
  return localMinutes(now, tz) >= cfg.consolidation.hour * 60 + cfg.consolidation.minute;
}

/** The wake was delivered for this local day: the loop adds the instructions on its next start. */
export function markConsolidationPending(db: DB, cfg: TraderConfig, now: Date = new Date()): void {
  setKV(db, KV_PENDING_DAY, localDay(now, cfg.timeZone));
}

/** A wake delivered today and not yet done (a wake that lands after midnight is dropped). */
export function consolidationPending(db: DB, cfg: TraderConfig, now: Date = new Date()): boolean {
  const day = localDay(now, cfg.timeZone);
  return getKV(db, KV_PENDING_DAY) === day && getKV(db, KV_DONE_DAY) !== day;
}

export function markConsolidationDone(db: DB, cfg: TraderConfig, now: Date = new Date()): void {
  setKV(db, KV_DONE_DAY, localDay(now, cfg.timeZone));
}

export function consolidationDoneToday(db: DB, cfg: TraderConfig, now: Date = new Date()): boolean {
  return getKV(db, KV_DONE_DAY) === localDay(now, cfg.timeZone);
}

/** Today's consolidation time as an instant, or null once it has passed (local day). */
export function consolidationTimeToday(cfg: TraderConfig, now: Date = new Date()): Date | null {
  const diff = cfg.consolidation.hour * 60 + cfg.consolidation.minute - localMinutes(now, cfg.timeZone);
  if (diff <= 0) return null;
  const at = new Date(now.getTime() + diff * 60_000);
  at.setUTCSeconds(0, 0);
  return at;
}

/**
 * True when a day-time paid call must not start: the evening turn of the
 * local day has not run and the day's spend already eats into its reserve.
 */
export function reserveBlocks(db: DB, cfg: TraderConfig, dailyCapCents: number | null, spentTodayCents: number, now: Date = new Date()): boolean {
  if (dailyCapCents === null || dailyCapCents <= CONSOLIDATION_RESERVE_CENTS * 2) return false;
  if (consolidationDoneToday(db, cfg, now)) return false;
  return spentTodayCents >= dailyCapCents - CONSOLIDATION_RESERVE_CENTS;
}

/** For /journee: "faite", "prévue à 19:30" or "pas faite" in French. */
export function consolidationStatusFr(db: DB, cfg: TraderConfig, now: Date = new Date()): string {
  const at = `${String(cfg.consolidation.hour).padStart(2, "0")} h ${String(cfg.consolidation.minute).padStart(2, "0")}`;
  if (consolidationDoneToday(db, cfg, now)) return "faite";
  if (consolidationDue(db, cfg, now)) return `pas encore faite (prévue à ${at} ; en attente d'un réveil hors pause et hors plafond)`;
  return `prévue à ${at}`;
}
