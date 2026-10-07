/**
 * Asset dossiers and the owner's notes (step C1).
 *
 * A dossier is what Sonni knows about one followed asset: its long-term
 * thesis, the catalysts ahead, the levels it watches, what it learned.
 * Written by the model (update_dossier, at most one revision per asset
 * and UTC day) or by the owner; every version is kept, never edited.
 * The owner's notes (/note) are short observations from the one writer
 * Sonni trusts; they reach the next memory pack as such.
 */

import type Database from "better-sqlite3";
import { ulid } from "ulid";
import { containsInjectionPatterns } from "../soul/validator.js";
import type { TraderConfig } from "./config.js";
import { fmtWhen } from "./format.js";
import type { SoulResult } from "./soul.js";
import { activeAssets } from "./universe.js";

type DB = Database.Database;

export const DOSSIER_MIN_CHARS = 40;
export const DOSSIER_MAX_CHARS = 1500;
export const DOSSIER_REASON_MAX = 200;
export const MAX_DOSSIER_REVISIONS_PER_DAY = 1;
export const OWNER_NOTE_MIN = 5;
export const OWNER_NOTE_MAX = 600;

export interface Dossier {
  id: string;
  asset: string;
  version: number;
  content: string;
  reason: string;
  source: "model" | "owner";
  recordedAt: string;
}

export interface OwnerNote {
  id: string;
  at: string;
  text: string;
  assets: string[];
}

function rowToDossier(row: any): Dossier {
  return { id: row.id, asset: row.asset, version: row.version, content: row.content, reason: row.reason, source: row.source, recordedAt: row.recorded_at };
}

function cleanText(raw: unknown, min: number, max: number, what: string): SoulResult<string> {
  const text = String(raw ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (text.length < min) return { ok: false, error: `${what} must be at least ${min} characters.` };
  if (text.length > max) return { ok: false, error: `${what} must be at most ${max} characters (got ${text.length}).` };
  if (containsInjectionPatterns(text)) return { ok: false, error: `${what} contains a prompt-boundary pattern; rewrite it as plain text.` };
  return { ok: true, value: text };
}

const day = (d: Date) => d.toISOString().slice(0, 10);

// ─── Dossiers ───────────────────────────────────────────────────

export function currentDossier(db: DB, asset: string): Dossier | undefined {
  const row = db.prepare("SELECT * FROM trader_dossiers WHERE asset = ? ORDER BY version DESC LIMIT 1").get(asset.toUpperCase());
  return row ? rowToDossier(row) : undefined;
}

export function dossierHistory(db: DB, asset: string, limit = 10): Dossier[] {
  return (db.prepare("SELECT * FROM trader_dossiers WHERE asset = ? ORDER BY version DESC LIMIT ?").all(asset.toUpperCase(), limit) as any[]).map(rowToDossier);
}

/** The latest version per asset, followed assets first in config order. */
export function listDossiers(db: DB, cfg: TraderConfig): Dossier[] {
  const rows = (db.prepare(
    "SELECT d.* FROM trader_dossiers d WHERE d.version = (SELECT MAX(version) FROM trader_dossiers WHERE asset = d.asset) ORDER BY d.asset",
  ).all() as any[]).map(rowToDossier);
  const order = activeAssets(db, cfg).map((a) => a.symbol);
  return rows.sort((a, b) => (order.indexOf(a.asset) === -1 ? 99 : order.indexOf(a.asset)) - (order.indexOf(b.asset) === -1 ? 99 : order.indexOf(b.asset)));
}

export function dossierRevisionsToday(db: DB, asset: string, now: Date = new Date()): number {
  return (db.prepare(
    "SELECT COUNT(*) AS n FROM trader_dossiers WHERE asset = ? AND source = 'model' AND substr(recorded_at, 1, 10) = ?",
  ).get(asset, day(now)) as { n: number }).n;
}

export function updateDossier(
  db: DB,
  cfg: TraderConfig,
  input: { asset: unknown; content: unknown; reason: unknown },
  now: Date = new Date(),
  source: "model" | "owner" = "model",
): SoulResult<Dossier> {
  const asset = String(input.asset ?? "").toUpperCase().trim();
  const followed = activeAssets(db, cfg).map((a) => a.symbol);
  if (!followed.includes(asset)) return { ok: false, error: `Unknown asset ${asset || "(none)"}: you follow ${followed.join(", ")}.` };
  const content = cleanText(input.content, DOSSIER_MIN_CHARS, DOSSIER_MAX_CHARS, "The dossier");
  if (!content.ok) return content;
  const reason = cleanText(input.reason, 5, DOSSIER_REASON_MAX, "The reason");
  if (!reason.ok) return reason;
  const current = currentDossier(db, asset);
  if (current && current.content === content.value) return { ok: false, error: `The ${asset} dossier is unchanged.` };
  if (source === "model" && dossierRevisionsToday(db, asset, now) >= MAX_DOSSIER_REVISIONS_PER_DAY) {
    return { ok: false, error: `The ${asset} dossier was already revised today (${MAX_DOSSIER_REVISIONS_PER_DAY} per asset and UTC day). Note the change in a reflection and revise tomorrow.` };
  }
  const id = `d_${ulid()}`;
  db.prepare(
    "INSERT INTO trader_dossiers (id, asset, version, content, reason, source, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, asset, (current?.version ?? 0) + 1, content.value, reason.value, source, now.toISOString());
  return { ok: true, value: rowToDossier(db.prepare("SELECT * FROM trader_dossiers WHERE id = ?").get(id)) };
}

// ─── Owner notes ────────────────────────────────────────────────

/** Followed symbols mentioned in a text, as whole words (BTC, btc, $ETH). */
export function mentionedAssets(text: string, symbols: string[]): string[] {
  return symbols.filter((s) => new RegExp(`(^|[^A-Za-z0-9])\\$?${s}(?![A-Za-z0-9])`, "i").test(text));
}

export function addOwnerNote(db: DB, cfg: TraderConfig, text: unknown, now: Date = new Date()): SoulResult<OwnerNote> {
  const clean = cleanText(text, OWNER_NOTE_MIN, OWNER_NOTE_MAX, "The note");
  if (!clean.ok) return clean;
  const assets = mentionedAssets(clean.value, activeAssets(db, cfg).map((a) => a.symbol));
  const id = `n_${ulid()}`;
  db.prepare("INSERT INTO trader_owner_notes (id, at, text, assets) VALUES (?, ?, ?, ?)").run(id, now.toISOString(), clean.value, assets.join(","));
  return { ok: true, value: { id, at: now.toISOString(), text: clean.value, assets } };
}

export function listOwnerNotes(db: DB, since?: string, limit = 20): OwnerNote[] {
  return (db.prepare(
    `SELECT id, at, text, assets FROM trader_owner_notes${since ? " WHERE at >= ?" : ""} ORDER BY at DESC LIMIT ?`,
  ).all(...(since ? [since, limit] : [limit])) as any[]).map((r) => ({ id: r.id, at: r.at, text: r.text, assets: r.assets ? String(r.assets).split(",") : [] }));
}

// ─── Owner views (French) ───────────────────────────────────────

export function formatDossierFr(db: DB, cfg: TraderConfig, asset: string, tz?: string): string {
  const symbol = asset.toUpperCase().trim();
  const followed = activeAssets(db, cfg).map((a) => a.symbol);
  if (!followed.includes(symbol)) return `Actif inconnu : ${symbol || "(aucun)"}. Sonni suit ${followed.join(", ")}.`;
  const history = dossierHistory(db, symbol, 5);
  if (history.length === 0) return `📁 ${symbol} : pas encore de dossier. Sonni l'écrit lors d'une séance ou de sa revue du dimanche (thèse, catalyseurs, niveaux, ce qu'il a appris).`;
  const current = history[0];
  const lines = [
    `📁 Dossier ${symbol} — version ${current.version}, ${current.source === "owner" ? "écrite par toi" : "écrite par Sonni"} le ${fmtWhen(current.recordedAt, tz)}`,
    current.content,
  ];
  if (history.length > 1) {
    lines.push("", "Versions précédentes :");
    for (const d of history.slice(1)) lines.push(`- v${d.version}, ${fmtWhen(d.recordedAt, tz)} (${d.source === "owner" ? "toi" : "Sonni"}) : ${d.reason}`);
  }
  return lines.join("\n");
}

export function refusalFr(error: string): string {
  if (error.includes("Unknown asset")) return error.replace("Unknown asset", "actif inconnu :").replace("you follow", "Sonni suit");
  if (error.includes("unchanged")) return "c'est déjà la version actuelle.";
  const short = /at least (\d+)/.exec(error);
  if (short) return `trop court (au moins ${short[1]} caractères).`;
  const long = /at most (\d+) characters \(got (\d+)\)/.exec(error);
  if (long) return `trop long (${long[2]} caractères, au plus ${long[1]}).`;
  if (error.includes("prompt-boundary")) return "le texte contient un motif de balise de prompt ; écris-le en texte simple.";
  return error;
}
