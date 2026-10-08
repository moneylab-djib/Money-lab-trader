/**
 * Incident log (guard G9): what the runtime did on its own that the owner
 * should know about, dated, in one place. Automatic pauses, caps reached,
 * unknown inference costs, error streaks, answers cut at the output
 * limit, unknown stop reasons, no-progress sleeps, sources disabled,
 * readers refused, backups that fail verification. Shown by /technique
 * and counted in the morning report; append-only, written by code only.
 */

import type Database from "better-sqlite3";
import { ulid } from "ulid";
import { fmtWhen, plural } from "./format.js";

type DB = Database.Database;

export const INCIDENT_KINDS = [
  "pause", "cap", "unknown_cost", "errors", "truncated", "unknown_stop", "no_progress",
  "source_disabled", "reader_refused", "backup", "loop", "brain_offline", "brain_recount",
] as const;
export type IncidentKind = (typeof INCIDENT_KINDS)[number];

export const INCIDENT_LABEL_FR: Record<IncidentKind, string> = {
  pause: "pause automatique",
  cap: "plafond atteint",
  unknown_cost: "coût d'inférence inconnu",
  errors: "série d'erreurs",
  truncated: "réponse coupée",
  unknown_stop: "raison d'arrêt inconnue",
  no_progress: "cycles sans progrès",
  source_disabled: "source désactivée",
  reader_refused: "IA lectrice refusée",
  backup: "sauvegarde",
  loop: "boucle",
  brain_offline: "second cerveau injoignable",
  brain_recount: "compteur du second cerveau remis à zéro",
};

export interface Incident {
  id: string;
  at: string;
  kind: IncidentKind;
  message: string;
}

const MAX_MESSAGE = 300;

/** Removes anything that looks like a key before a message is stored. */
function scrub(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[clé masquée]")
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[jeton masqué]")
    .replace(/(Bearer|token=|key=)\s*[^\s"']+/gi, "$1 [masqué]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_MESSAGE);
}

function hasTable(db: DB): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'trader_incidents'").get();
}

/** Never throws: recording an incident must not become one. */
export function recordIncident(db: DB, kind: IncidentKind, message: string, now: Date = new Date()): void {
  try {
    if (!hasTable(db)) return;
    db.prepare("INSERT INTO trader_incidents (id, at, kind, message) VALUES (?, ?, ?, ?)").run(`i_${ulid()}`, now.toISOString(), kind, scrub(message));
  } catch {
    // nothing: the log is best effort
  }
}

export function listIncidents(db: DB, limit = 20, since?: string): Incident[] {
  if (!hasTable(db)) return [];
  return db.prepare(
    `SELECT id, at, kind, message FROM trader_incidents${since ? " WHERE at >= ?" : ""} ORDER BY at DESC LIMIT ?`,
  ).all(...(since ? [since, limit] : [limit])) as Incident[];
}

/** For /technique: the last 7 days, newest first, in French. */
export function formatIncidentsFr(db: DB, now: Date = new Date(), tz?: string): string {
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const items = listIncidents(db, 10, since);
  if (items.length === 0) return "Incidents (7 derniers jours) : aucun.";
  const total = (db.prepare("SELECT COUNT(*) AS n FROM trader_incidents WHERE at >= ?").get(since) as { n: number }).n;
  const lines = [`Incidents (7 derniers jours) : ${plural(total, "incident")}${total > items.length ? `, les ${items.length} derniers` : ""} :`];
  for (const i of items) lines.push(`- ${fmtWhen(i.at, tz)} — ${INCIDENT_LABEL_FR[i.kind] ?? i.kind} : ${i.message}`);
  return lines.join("\n");
}
