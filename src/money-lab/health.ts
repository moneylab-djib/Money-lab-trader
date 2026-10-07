/**
 * Money Lab daily health report
 *
 * A short message the owner reads in ten seconds on Telegram: a verdict
 * (all good / watch / problem), what the bot did in the last 24 hours,
 * the errors it hit, its spending and the server's state. It reads local
 * state only: no network call, no inference, no cost.
 *
 * Failed agent turns and background task failures are not in the database
 * otherwise, so the runtime records them here (recordHealthEvent).
 */

import fs from "fs";
import path from "path";
import type Database from "better-sqlite3";
import type { MoneyLabConfig } from "./profile.js";
import { getKV, getNoProgressCycles, getPauseState, listHelpRequests, OWNER_TELEGRAM_SENDER, setKV } from "./journal.js";
import { activeExperimentCount, ideaTotal, listIdeas } from "./ideas.js";
import { listPosts } from "./social.js";
import { survivalBalance } from "./selfhosted.js";
import { inferenceGetDailyCost } from "../state/database.js";

const EVENTS_KEY = "money_lab.health_events";
const MAX_EVENTS = 200;
const DAY_MS = 86_400_000;

export interface HealthEvent {
  at: string;
  /** "turn" for a failed agent turn, otherwise the background task's name. */
  source: string;
  message: string;
}

/** Removes anything that looks like a key before an error is stored or shown. */
function scrub(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[clé masquée]")
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[jeton masqué]")
    .replace(/(Bearer|token=|key=)\s*[^\s"']+/gi, "$1 [masqué]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

export function recordHealthEvent(db: Database.Database, source: string, message: string, now = new Date()): void {
  try {
    const events = listHealthEvents(db).filter((e) => now.getTime() - Date.parse(e.at) < 2 * DAY_MS);
    events.push({ at: now.toISOString(), source, message: scrub(message) });
    setKV(db, EVENTS_KEY, JSON.stringify(events.slice(-MAX_EVENTS)));
  } catch {
    // Recording a failure must never become a failure itself.
  }
}

export function listHealthEvents(db: Database.Database): HealthEvent[] {
  try {
    const events = JSON.parse(getKV(db, EVENTS_KEY) ?? "[]");
    return Array.isArray(events) ? (events as HealthEvent[]) : [];
  } catch {
    return [];
  }
}

/** SQLite datetime('now') format (UTC, no T, no milliseconds). */
function sqlTime(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 19);
}

function usd(cents: number): string {
  return `${cents < 0 ? "-" : ""}${(Math.abs(cents) / 100).toFixed(2)} $`;
}

function ago(fromMs: number, nowMs: number): string {
  const minutes = Math.max(0, Math.round((nowMs - fromMs) / 60_000));
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `il y a ${hours} h` : `il y a ${Math.round(hours / 24)} jours`;
}

function parisTime(iso: string): string {
  return new Date(iso).toLocaleString("fr-FR", {
    timeZone: "Europe/Paris", weekday: "short", hour: "2-digit", minute: "2-digit",
  });
}

function count(db: Database.Database, sql: string, ...params: unknown[]): number {
  try {
    return Number((db.prepare(sql).get(...params) as { n: number } | undefined)?.n ?? 0);
  } catch {
    return 0;
  }
}

export interface HealthReport {
  level: "ok" | "watch" | "problem";
  text: string;
}

export function buildHealthReport(
  db: Database.Database,
  lab: MoneyLabConfig,
  options: { home?: string; now?: Date; statfs?: (dir: string) => { bavail: number; bsize: number; blocks: number } } = {},
): HealthReport {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const since = sqlTime(new Date(nowMs - DAY_MS));
  const sinceIso = new Date(nowMs - DAY_MS).toISOString();
  const home = options.home ?? process.env.HOME ?? "/root";
  const problems: string[] = [];
  const watch: string[] = [];
  const lines: string[] = [];

  // ── State ──
  const paused = getPauseState(db);
  const state = getKV(db, "agent_state") ?? "inconnu";
  const sleepUntil = getKV(db, "sleep_until");
  const sleepReason = getKV(db, "sleep_reason");
  if (paused) {
    lines.push(`État : ⏸️ en pause depuis ${parisTime(paused.at)} (${paused.reason})`);
    watch.push("le bot est en pause (/reprendre pour le relancer)");
  } else if (state === "dead") {
    lines.push("État : 💀 mort, plus de fonds");
    problems.push("le bot n'a plus de fonds (/fonds pour le ranimer)");
  } else if (state === "sleeping" && sleepUntil) {
    lines.push(`État : 😴 dort jusqu'à ${parisTime(sleepUntil)}${sleepReason ? ` (${sleepReason.slice(0, 120)})` : ""}`);
  } else {
    lines.push(`État : ${state === "running" ? "▶️ au travail" : state}`);
  }

  // ── Activity ──
  const turns = count(db, "SELECT COUNT(*) AS n FROM turns WHERE timestamp >= ?", sinceIso);
  const lastTurn = db.prepare("SELECT timestamp, thinking FROM turns ORDER BY timestamp DESC LIMIT 1").get() as
    | { timestamp: string; thinking: string }
    | undefined;
  // Many turns are tool calls without text: show the last one that said something.
  const lastNote = db.prepare("SELECT thinking FROM turns WHERE TRIM(thinking) != '' ORDER BY timestamp DESC LIMIT 1").get() as
    | { thinking: string }
    | undefined;
  const toolCalls = count(db, "SELECT COUNT(*) AS n FROM tool_calls WHERE created_at >= ?", since);
  const toolErrors = db.prepare(
    "SELECT name, COUNT(*) AS n FROM tool_calls WHERE created_at >= ? AND error IS NOT NULL GROUP BY name ORDER BY n DESC",
  ).all(since) as Array<{ name: string; n: number }>;
  const toolErrorCount = toolErrors.reduce((sum, e) => sum + e.n, 0);
  lines.push("", "Dernières 24 h :");
  lines.push(`  ${turns} tours de réflexion, ${toolCalls} actions${toolErrorCount ? ` (${toolErrorCount} en erreur)` : ""}`);
  if (lastTurn) {
    lines.push(`  Dernier tour : ${ago(Date.parse(lastTurn.timestamp), nowMs)}`);
    const note = (lastNote?.thinking ?? "").replace(/\s+/g, " ").trim();
    if (note) lines.push(`  Sa dernière note : « ${note.slice(0, 220)}${note.length > 220 ? "…" : ""} »`);
  }
  if (!paused && state !== "dead") {
    if (!lastTurn || nowMs - Date.parse(lastTurn.timestamp) > 26 * 3_600_000) {
      problems.push("aucun tour depuis plus de 26 h alors qu'il ne devrait jamais dormir plus de 6 h");
    }
  }
  if (toolErrorCount >= 5 && toolErrorCount > toolCalls * 0.3) {
    watch.push(`beaucoup d'actions échouent (${toolErrorCount} sur ${toolCalls})`);
  }

  // ── Errors ──
  const events = listHealthEvents(db).filter((e) => Date.parse(e.at) >= nowMs - DAY_MS);
  const turnErrors = events.filter((e) => e.source === "turn");
  const background = events.filter((e) => e.source !== "turn");
  lines.push("", "Erreurs :");
  if (turnErrors.length === 0 && background.length === 0 && toolErrors.length === 0) lines.push("  Aucune.");
  if (turnErrors.length) {
    lines.push(`  Tours échoués : ${turnErrors.length} (dernier ${ago(Date.parse(turnErrors.at(-1)!.at), nowMs)})`);
    lines.push(`    « ${turnErrors.at(-1)!.message.slice(0, 200)} »`);
    if (turnErrors.length >= 5) problems.push(`${turnErrors.length} tours ont échoué (erreurs de l'IA)`);
    else watch.push(`${turnErrors.length} tour(s) échoué(s)`);
  }
  if (background.length) {
    const bySource = new Map<string, number>();
    for (const e of background) bySource.set(e.source, (bySource.get(e.source) ?? 0) + 1);
    lines.push(`  Tâches de fond : ${[...bySource].map(([s, n]) => `${s} ×${n}`).join(", ")}`);
    const notTelegram = background.filter((e) => e.source !== "Telegram");
    if (notTelegram.length) lines.push(`    « ${notTelegram.at(-1)!.source} : ${notTelegram.at(-1)!.message.slice(0, 160)} »`);
    // A few network hiccups on Telegram are normal; anything else is worth a look.
    if (notTelegram.length >= 3 || background.length >= 30) watch.push("des tâches de fond échouent");
  }
  if (toolErrors.length) {
    lines.push(`  Actions en erreur : ${toolErrors.slice(0, 4).map((e) => `${e.name} ×${e.n}`).join(", ")}`);
  }
  const stuckOwner = count(
    db,
    "SELECT COUNT(*) AS n FROM inbox_messages WHERE from_address = ? AND processed_at IS NULL AND received_at < ?",
    OWNER_TELEGRAM_SENDER, sqlTime(new Date(nowMs - 3_600_000)),
  );
  if (stuckOwner > 0 && !paused && state !== "dead") {
    problems.push(`${stuckOwner} de tes messages attendent depuis plus d'1 h sans être lus`);
  }

  // ── Money ──
  // The cap is per UTC day: a rolling 24 h window can legitimately hold up to
  // two days of capped spending, so each UTC day is compared on its own.
  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(nowMs - DAY_MS).toISOString().slice(0, 10);
  const spentToday = inferenceGetDailyCost(db, today);
  const spentYesterday = inferenceGetDailyCost(db, yesterday);
  const cap = lab.inference.dailyCents;
  lines.push("", "Argent :");
  lines.push(`  IA aujourd'hui (depuis minuit UTC) : ${usd(spentToday)}${cap !== null ? ` / ${usd(cap)}` : ""}`);
  lines.push(`  IA hier : ${usd(spentYesterday)}`);
  // A call is allowed while the estimate fits, so the real cost can pass the
  // cap by a little; far beyond it means the cap is not holding.
  if (cap && spentToday > cap * 1.2) problems.push("la dépense IA d'aujourd'hui dépasse nettement le plafond journalier");
  if (cap && spentYesterday > cap * 1.2) {
    watch.push(`hier, la dépense IA (${usd(spentYesterday)}) a dépassé le plafond actuel (${usd(cap)}), sauf si tu l'as changé depuis`);
  }
  if (lab.runtime === "self-hosted") {
    const s = survivalBalance(db, lab, now);
    lines.push(`  Solde : ${usd(s.balanceCents)}${s.daysLeft !== null ? ` — environ ${Math.floor(s.daysLeft)} jours au rythme actuel (${usd(s.burnPerDayCents)}/jour)` : ""}`);
    if (s.daysLeft !== null && s.daysLeft < 3 && s.balanceCents >= 0) watch.push("moins de 3 jours de fonds");
  }

  // ── Work ──
  const ideas = listIdeas(db);
  const scored = ideas.filter((i) => ideaTotal(i.scores) !== null).length;
  const approved = ideas.filter((i) => i.status === "approved" || i.status === "launched").length;
  const help = listHelpRequests(db, "open").length;
  const pendingPosts = listPosts(db).filter((p) => p.status === "pending").length;
  lines.push("", "Travail :");
  lines.push(`  Idées : ${ideas.length} (${scored} notées, ${approved} validées) — expériences actives : ${activeExperimentCount(db)}`);
  const noProgress = getNoProgressCycles(db);
  if (lab.noProgressCycles && noProgress >= Math.max(1, lab.noProgressCycles - 2)) {
    watch.push(`il tourne en rond (${noProgress} cycles sans progrès sur ${lab.noProgressCycles} avant pause)`);
  }
  if (help || pendingPosts) {
    lines.push(`  En attente de toi : ${[help ? `${help} demande(s) d'aide (/aides)` : "", pendingPosts ? `${pendingPosts} publication(s) (/publications)` : ""].filter(Boolean).join(", ")}`);
  }

  // ── Server ──
  lines.push("", "Serveur :");
  try {
    const st = (options.statfs ?? fs.statfsSync)(home);
    const freeGb = (st.bavail * st.bsize) / 1e9;
    const freePct = (st.bavail / st.blocks) * 100;
    lines.push(`  Disque libre : ${freeGb.toFixed(1)} Go (${freePct.toFixed(0)} %)`);
    if (freeGb < 1) problems.push("le disque est presque plein");
    else if (freeGb < 3) watch.push("le disque se remplit");
  } catch {
    lines.push("  Disque libre : inconnu");
  }
  try {
    const dir = path.join(home, ".automaton", "backups");
    const last = fs.readdirSync(dir).filter((f) => /^state\.db\.backup-\d{4}-\d{2}-\d{2}$/.test(f)).sort().at(-1);
    const day = last?.slice(-10);
    lines.push(`  Dernière sauvegarde : ${day ?? "aucune"}`);
    if (!day || nowMs - Date.parse(`${day}T00:00:00Z`) > 2 * DAY_MS) watch.push("pas de sauvegarde récente");
  } catch {
    lines.push("  Dernière sauvegarde : aucune");
    watch.push("pas de sauvegarde récente");
  }

  const level: HealthReport["level"] = problems.length ? "problem" : watch.length ? "watch" : "ok";
  const head = level === "ok"
    ? "✅ Tout va bien."
    : level === "watch"
      ? `⚠️ À surveiller : ${watch.join(" ; ")}.`
      : `🚨 Problème : ${problems.join(" ; ")}.${watch.length ? `\nÀ surveiller aussi : ${watch.join(" ; ")}.` : ""}`;
  const date = now.toLocaleDateString("fr-FR", { timeZone: "Europe/Paris", weekday: "long", day: "numeric", month: "long" });
  const footer = level === "problem"
    ? "\nEnvoie ce rapport et la sortie de « journalctl -u money-lab --since \"24 hours ago\" | grep -iE \"error|warn|failed\" | tail -40 » pour analyse."
    : "";
  return {
    level,
    text: `🩺 Rapport de santé — ${date}\n${head}\n\n${lines.join("\n")}\n\nDétails : /statut${footer}`,
  };
}
