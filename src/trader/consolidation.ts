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
export const CONSOLIDATION_WAKE_REASON = "evening consolidation due: the day's post-mortems, trap hits, dossiers and a daily note";
const KV_DONE_DAY = "sonni.consolidation_done_day";
const KV_PENDING_DAY = "sonni.consolidation_pending_day";

export function localDay(now: Date, tz: string): string {
  return now.toLocaleDateString("en-CA", { timeZone: tz });
}

function localMinutes(now: Date, tz: string): number {
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

/** For /journee: "faite", "prévue à 19:30" or "pas faite" in French. */
export function consolidationStatusFr(db: DB, cfg: TraderConfig, now: Date = new Date()): string {
  const at = `${String(cfg.consolidation.hour).padStart(2, "0")} h ${String(cfg.consolidation.minute).padStart(2, "0")}`;
  if (consolidationDoneToday(db, cfg, now)) return "faite";
  if (consolidationDue(db, cfg, now)) return `pas encore faite (prévue à ${at} ; en attente d'un réveil hors pause et hors plafond)`;
  return `prévue à ${at}`;
}
