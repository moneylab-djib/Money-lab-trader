/**
 * The owner's notebooks (step C1): Markdown files written by code from
 * the memory stores, in French, under ~/carnet on the VPS. One export
 * every Sunday (and on /carnets); files are rewritten whole, so they
 * always mirror the database. Nothing here uses inference.
 */

import fs from "fs";
import path from "path";
import type Database from "better-sqlite3";
import { getKV, setKV } from "../money-lab/journal.js";
import type { TraderConfig } from "./config.js";
import { dossierHistory } from "./dossiers.js";
import { formatCyclesFr } from "./cycles.js";
import { fmtDayLong, fmtWhen } from "./format.js";
import { listTrades, listTraps } from "./portfolio.js";
import { getPrediction } from "./predictions.js";
import { listLessons, listReflections, identityHistory } from "./soul.js";
import { describePredictionFr, describeResolutionFr, formatHypotheses, formatPortfolioFr } from "./status.js";
import { activeAssets } from "./universe.js";

type DB = Database.Database;

const KV_LAST_EXPORT = "sonni.notebooks_day";
const KIND_FR: Record<string, string> = { postmortem: "post-mortem", trade: "autopsie d'opération", session: "note de séance", daily: "journée", weekly: "revue de la semaine" };

export function notebooksDir(home = process.env.HOME || "/root"): string {
  return path.join(home, "carnet");
}

/** Sunday in the owner's time zone, once per day. */
export function notebooksDue(db: DB, tz: string, now: Date = new Date()): boolean {
  const weekday = now.toLocaleDateString("en-GB", { weekday: "long", timeZone: tz });
  if (weekday !== "Sunday") return false;
  return getKV(db, KV_LAST_EXPORT) !== now.toLocaleDateString("en-CA", { timeZone: tz });
}

export function markNotebooksExported(db: DB, tz: string, now: Date = new Date()): void {
  setKV(db, KV_LAST_EXPORT, now.toLocaleDateString("en-CA", { timeZone: tz }));
}

function header(title: string, now: Date, tz: string): string {
  return `# ${title}\n\n_Écrit par le code le ${fmtDayLong(now, tz)} à ${fmtWhen(now.toISOString(), tz).slice(-5)} depuis la base de Sonni ; ce fichier est réécrit à chaque export._\n\n`;
}

/** Writes every notebook and returns the file names written. */
export function exportNotebooks(db: DB, cfg: TraderConfig, dir: string, now: Date = new Date()): string[] {
  const tz = cfg.timeZone;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files: Record<string, string> = {};

  const reflections = listReflections(db, 500);
  files["journal.md"] = header("Journal de Sonni", now, tz) + (reflections.length === 0 ? "Rien encore.\n" : reflections.map((r) =>
    `## ${fmtWhen(r.recordedAt, tz)} — ${KIND_FR[r.kind] ?? r.kind}${r.subjectId ? ` (${r.subjectId})` : ""}\n\n${r.content}\n`).join("\n"));

  files["intuitions.md"] = header("Intuitions de Sonni", now, tz) + formatHypotheses(db, 500) + "\n";

  const traps = listTraps(db);
  files["pieges.md"] = header("Pièges nommés par Sonni", now, tz) + (traps.length === 0 ? "Aucun piège nommé encore.\n" : traps.map((t) => {
    const hits = db.prepare("SELECT trade_id, note, recorded_at FROM trader_trap_hits WHERE trap_id = ? ORDER BY recorded_at ASC").all(t.id) as { trade_id: string; note: string; recorded_at: string }[];
    return `## ${t.name} (${t.hits} fois)\n\n${t.description}\n\nSignes avant-coureurs : ${t.warningSigns}\n` +
      (hits.length ? "\nOpérations touchées :\n" + hits.map((h) => `- ${fmtWhen(h.recorded_at, tz)} (${h.trade_id}) : ${h.note}`).join("\n") + "\n" : "");
  }).join("\n"));

  const lessons = listLessons(db, true);
  files["lecons.md"] = header("Leçons de Sonni", now, tz) + (lessons.length === 0 ? "Aucune leçon encore.\n" : lessons.map((l) =>
    `- ${l.status === "active" ? "✅" : "⛔"} ${l.text} _(preuves : ${l.evidenceIds.join(", ")}${l.status === "retired" ? ` ; retirée ${l.retiredAt ? fmtWhen(l.retiredAt, tz) : ""} par ${l.retiredBy === "owner" ? "toi" : "Sonni"}` : ""})_`).join("\n") + "\n");

  const identities = identityHistory(db, 50);
  files["identite.md"] = header("Identité de Sonni", now, tz) + identities.map((i) =>
    `## Version ${i.version} — ${fmtWhen(i.recordedAt, tz)} (${i.source === "owner" ? "toi" : i.source === "model" ? "Sonni" : "le code"})\n\n${i.content}\n\n_Raison : ${i.reason}_\n`).join("\n");

  const trades = listTrades(db, 10_000);
  files["portefeuille.md"] = header("Portefeuille virtuel de Sonni", now, tz) + formatPortfolioFr(db, cfg, now) + "\n" +
    (trades.length ? "\n## Toutes les opérations closes\n\n" + trades.map((t) =>
      `- ${fmtWhen(t.closedAt, tz)} ${t.asset} : ${t.pnlEur >= 0 ? "+" : "−"}${Math.abs(t.pnlEur).toFixed(2)} € (${t.pnlPct >= 0 ? "+" : "−"}${Math.abs(t.pnlPct).toFixed(2)} %)${t.closeReason === "stop" ? ", par le stop" : ""} — ${t.thesis}`).join("\n") + "\n" : "");

  files["cycles.md"] = header("Cycles de Sonni", now, tz) + formatCyclesFr(db, cfg) + "\n";

  for (const a of activeAssets(db, cfg)) {
    const history = dossierHistory(db, a.symbol, 50);
    const predictions = (db.prepare("SELECT id FROM trader_predictions WHERE asset = ? ORDER BY made_at DESC LIMIT 200").all(a.symbol) as { id: string }[])
      .map((r) => getPrediction(db, r.id)!);
    const assetTrades = trades.filter((t) => t.asset === a.symbol);
    let body = header(`Dossier ${a.symbol}`, now, tz);
    body += history.length === 0 ? "Pas encore de dossier écrit par Sonni.\n" : history.map((d) =>
      `## Version ${d.version} — ${fmtWhen(d.recordedAt, tz)} (${d.source === "owner" ? "toi" : "Sonni"})\n\n${d.content}\n\n_Raison : ${d.reason}_\n`).join("\n");
    body += `\n## Prédictions (${predictions.length})\n\n` + (predictions.length === 0 ? "Aucune.\n" : predictions.map((p) =>
      `- ${p.resolvedAt ? describeResolutionFr(p) : describePredictionFr(p, tz)}`).join("\n") + "\n");
    body += `\n## Opérations closes (${assetTrades.length})\n\n` + (assetTrades.length === 0 ? "Aucune.\n" : assetTrades.map((t) =>
      `- ${fmtWhen(t.closedAt, tz)} : ${t.pnlEur >= 0 ? "+" : "−"}${Math.abs(t.pnlEur).toFixed(2)} €${t.closeReason === "stop" ? ", par le stop" : ""} — ${t.thesis}`).join("\n") + "\n");
    files[`${a.symbol.toLowerCase()}.md`] = body;
  }

  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content, { mode: 0o600 });
  return Object.keys(files).sort();
}
