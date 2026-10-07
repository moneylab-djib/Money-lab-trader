/**
 * Sonni's morning report for the owner: what it did yesterday, what today
 * holds, and only real alerts. French, owner's time zone, local state
 * only (no network, no inference). Replaces Money Lab's health report as
 * the daily message when the trader block is active; /sante still gives
 * the technical report.
 */

import type Database from "better-sqlite3";
import type { TraderConfig } from "./config.js";
import type { MoneyLabConfig } from "../money-lab/profile.js";
import { getKV, getPauseState, OWNER_TELEGRAM_SENDER } from "../money-lab/journal.js";
import { listHealthEvents } from "../money-lab/health.js";
import { INCIDENT_LABEL_FR, listIncidents } from "./incidents.js";
import { consolidationStatusFr } from "./consolidation.js";
import { inferenceGetDailyCost } from "../state/database.js";
import { EVENT_LABEL_FR, upcomingEvents } from "./events.js";
import { getPrediction, listOpenPredictions, type Prediction } from "./predictions.js";
import { readerStatuses } from "./readers.js";
import { activeConfig } from "./universe.js";
import { agentStateFr, describePredictionFr, describeResolutionFr, orderNoteFr } from "./status.js";
import { fmtDay, fmtDayLong, fmtEur, fmtTime, fmtUsdCents, plural } from "./format.js";
import { listTrades, recentOrders, snapshots, valuation } from "./portfolio.js";

type DB = Database.Database;
const DAY_MS = 86_400_000;

export interface SonniReport {
  level: "ok" | "watch" | "problem";
  text: string;
}

function count(db: DB, sql: string, ...params: unknown[]): number {
  try {
    return Number((db.prepare(sql).get(...params) as { n: number } | undefined)?.n ?? 0);
  } catch {
    return 0;
  }
}

function sqlTime(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 19);
}

export function buildSonniDailyReport(
  db: DB,
  baseCfg: TraderConfig,
  lab: MoneyLabConfig | null,
  env: NodeJS.ProcessEnv,
  now: Date = new Date(),
): SonniReport {
  const cfg = activeConfig(db, baseCfg);
  const tz = cfg.timeZone;
  const nowMs = now.getTime();
  const sinceIso = new Date(nowMs - DAY_MS).toISOString();
  const problems: string[] = [];
  const watch: string[] = [];
  const yesterday: string[] = [];
  const today: string[] = [];

  // ── Yesterday (last 24 h) ──
  const resolved = (db.prepare("SELECT id FROM trader_predictions WHERE resolved_at >= ? ORDER BY resolved_at ASC").all(sinceIso) as { id: string }[])
    .map((r) => getPrediction(db, r.id)!);
  const scored = resolved.filter((p) => p.brier !== null);
  const made = count(db, "SELECT COUNT(*) AS n FROM trader_predictions WHERE made_at >= ?", sinceIso);
  if (resolved.length) {
    const right = scored.filter((p) => (p.outcome === 1 ? p.probability >= 0.5 : p.probability < 0.5)).length;
    const mean = scored.length ? scored.reduce((s, p) => s + p.brier!, 0) / scored.length : null;
    yesterday.push(
      `${plural(resolved.length, "prédiction résolue", "prédictions résolues")}` +
        (scored.length ? ` : ${right} dans le bon sens sur ${scored.length}, score ${mean!.toFixed(3).replace(".", ",")}` : "") +
        (resolved.length > scored.length ? ` (${resolved.length - scored.length} annulée(s) faute de prix)` : ""),
    );
    for (const p of resolved.slice(0, 4)) yesterday.push(`  · ${describeResolutionFr(p)}`);
  }
  yesterday.push(made ? `${plural(made, "nouvelle prédiction", "nouvelles prédictions")}` : "aucune nouvelle prédiction");
  const observations = count(db, "SELECT COUNT(*) AS n FROM trader_observations WHERE observed_at >= ?", sinceIso);
  const headlines = count(db, "SELECT COUNT(*) AS n FROM trader_headlines WHERE fetched_at >= ?", sinceIso);
  const pages = count(db, "SELECT COUNT(*) AS n FROM trader_page_reads WHERE at >= ? AND ok = 1", sinceIso);
  yesterday.push(`${plural(headlines, "titre lu", "titres lus")}, ${plural(observations, "observation extraite", "observations extraites")}${pages ? `, ${plural(pages, "page lue", "pages lues")}` : ""}`);
  const wakes = db.prepare("SELECT reason FROM trader_wakes WHERE delivered = 1 AND at >= ? ORDER BY at ASC").all(sinceIso) as { reason: string }[];
  if (wakes.length) yesterday.push(`${plural(wakes.length, "réveil spontané", "réveils spontanés")} (${wakes.map((w) => w.reason.replace(/\s+/g, " ").slice(0, 60)).join(" ; ")})`);
  const reflections = count(db, "SELECT COUNT(*) AS n FROM trader_reflections WHERE recorded_at >= ?", sinceIso);
  const lessons = count(db, "SELECT COUNT(*) AS n FROM trader_lessons WHERE recorded_at >= ?", sinceIso);
  const hypotheses = count(db, "SELECT COUNT(*) AS n FROM trader_hypotheses WHERE recorded_at >= ?", sinceIso);
  const written: string[] = [];
  if (reflections) written.push(plural(reflections, "note de journal", "notes de journal"));
  if (lessons) written.push(plural(lessons, "leçon"));
  if (hypotheses) written.push(plural(hypotheses, "intuition"));
  if (written.length) yesterday.push(`Écrit : ${written.join(", ")}`);
  const spentYesterday = inferenceGetDailyCost(db, new Date(nowMs - DAY_MS).toISOString().slice(0, 10));
  const spentToday = inferenceGetDailyCost(db, now.toISOString().slice(0, 10));
  const cap = lab?.inference.dailyCents ?? null;
  yesterday.push(`IA : ${fmtUsdCents(spentYesterday)} hier${cap !== null ? ` (plafond ${fmtUsdCents(cap)} par jour)` : ""}`);

  // ── Today ──
  const due = listOpenPredictions(db).filter((p: Prediction) => Date.parse(p.horizonUntil) <= nowMs + DAY_MS);
  if (due.length) {
    today.push(`${plural(due.length, "prédiction arrive", "prédictions arrivent")} à échéance :`);
    for (const p of due.slice(0, 5)) today.push(`  · ${describePredictionFr(p, tz)}`);
  } else {
    today.push(`aucune prédiction à échéance (${plural(listOpenPredictions(db).length, "ouverte")})`);
  }
  const events = upcomingEvents(db, now, 2);
  if (events.length) today.push(`Événement : ${events.map((e) => `${EVENT_LABEL_FR[e.type]} le ${fmtDay(e.day)}`).join(", ")}`);
  today.push(`Sonni ${agentStateFr(db, tz, now)}`);

  // ── Real alerts only ──
  const paused = getPauseState(db);
  const state = getKV(db, "agent_state");
  if (paused) watch.push("Sonni est en pause (/reprendre pour le relancer)");
  if (state === "dead") problems.push("le programme s'est arrêté faute de fonds (/fonds)");
  const lastTurn = db.prepare("SELECT timestamp FROM turns ORDER BY timestamp DESC LIMIT 1").get() as { timestamp: string } | undefined;
  if (!paused && state !== "dead" && (!lastTurn || nowMs - Date.parse(lastTurn.timestamp) > 26 * 3_600_000)) {
    problems.push("aucune séance depuis plus de 26 h");
  }
  if (cap && spentToday > cap * 1.2) problems.push("la dépense IA d'aujourd'hui dépasse nettement le plafond");
  if (cap && spentYesterday > cap * 1.2) watch.push(`hier, la dépense IA (${fmtUsdCents(spentYesterday)}) a dépassé le plafond (${fmtUsdCents(cap)})`);
  const stuck = count(
    db,
    "SELECT COUNT(*) AS n FROM inbox_messages WHERE from_address = ? AND processed_at IS NULL AND received_at < ?",
    OWNER_TELEGRAM_SENDER, sqlTime(new Date(nowMs - 3_600_000)),
  );
  if (stuck > 0 && !paused && state !== "dead") problems.push(`${stuck} de tes messages attendent depuis plus d'1 h`);
  const turnErrors = listHealthEvents(db).filter((e) => e.source === "turn" && Date.parse(e.at) >= nowMs - DAY_MS).length;
  if (turnErrors >= 5) problems.push(`${turnErrors} séances ont échoué (erreurs de l'IA)`);
  // A background task is a problem only when it keeps failing: 12 times in 24 h and still within the last 2 h.
  const bySource = new Map<string, { n: number; last: number }>();
  for (const e of listHealthEvents(db)) {
    if (e.source === "turn" || e.source === "Telegram" || Date.parse(e.at) < nowMs - DAY_MS) continue;
    const cur = bySource.get(e.source) ?? { n: 0, last: 0 };
    bySource.set(e.source, { n: cur.n + 1, last: Math.max(cur.last, Date.parse(e.at)) });
  }
  for (const [source, s] of bySource) {
    if (s.n >= 12 && s.last >= nowMs - 2 * 3_600_000) watch.push(`la tâche « ${source} » échoue en continu`);
  }
  // Guard G9: what the runtime did on its own since yesterday's report.
  const incidents = listIncidents(db, 20, new Date(nowMs - DAY_MS).toISOString());
  if (incidents.length) {
    const kinds = [...new Set(incidents.map((i) => INCIDENT_LABEL_FR[i.kind] ?? i.kind))];
    watch.push(`${plural(incidents.length, "incident")} depuis hier (${kinds.join(", ")}) : /technique`);
  }
  if (cfg.readers.length) {
    const statuses = readerStatuses(db, cfg, env, now);
    const waiting = count(db, "SELECT COUNT(*) AS n FROM trader_headlines WHERE digested_at IS NULL AND published_at >= ?", sinceIso);
    if (waiting > 0 && statuses.every((s) => !s.keyPresent || s.restingUntil || s.callsToday >= s.dailyRequests)) {
      watch.push(`aucune IA lectrice disponible alors que ${plural(waiting, "titre attend", "titres attendent")} (/lecteurs)`);
    }
  }

  const level: SonniReport["level"] = problems.length ? "problem" : watch.length ? "watch" : "ok";
  const head = level === "ok" ? "✅ Tout va bien." : level === "watch" ? `⚠️ À surveiller : ${watch.join(" ; ")}.` : `🚨 Problème : ${problems.join(" ; ")}.${watch.length ? ` À surveiller aussi : ${watch.join(" ; ")}.` : ""}`;
  const text = [
    `☀️ Sonni — ${fmtDayLong(now, tz)}`,
    head,
    "",
    "Hier :",
    ...yesterday.map((l) => (l.startsWith("  ·") ? l : `- ${l}`)),
    "",
    "Aujourd'hui :",
    ...today.map((l) => (l.startsWith("  ·") ? l : `- ${l}`)),
    "",
    "Détails : /statut · /journal · /sante (serveur)",
  ].join("\n");
  return { level, text };
}

// ─── Evening summary ────────────────────────────────────────────

/**
 * The day's operations with their reasons, the portfolio's value and
 * change, the predictions resolved, what Sonni wrote and spent. Sent
 * once a day in the owner's evening and on demand (/journee).
 */
export function buildSonniEveningSummary(db: DB, baseCfg: TraderConfig, lab: MoneyLabConfig | null, now: Date = new Date()): string {
  const cfg = activeConfig(db, baseCfg);
  const tz = cfg.timeZone;
  const sinceIso = new Date(now.getTime() - DAY_MS).toISOString();
  const lines: string[] = [`🌙 Sonni — ${fmtDayLong(now, tz)}, résumé du jour`];
  const v = valuation(db);
  const snaps = snapshots(db, 2);
  const yesterday = snaps.find((s) => s.day < now.toISOString().slice(0, 10));
  const dayChange = yesterday ? v.equityEur - (v.contributedEur - yesterday.contributedEur) - yesterday.equityEur : null;
  lines.push("", "Portefeuille :");
  if (v.contributedEur === 0) {
    lines.push(`- pas encore ouvert (${fmtEur(cfg.portfolio.startEur)} au premier relevé de prix)`);
  } else {
    lines.push(`- valeur ${fmtEur(v.equityEur)}${dayChange !== null ? ` (${dayChange >= 0 ? "+" : "−"}${fmtEur(Math.abs(dayChange))} sur la journée)` : ""}, ` +
      `${v.pnlEur >= 0 ? "+" : "−"}${fmtEur(Math.abs(v.pnlEur))} depuis le départ · liquidités ${fmtEur(v.cashEur)}`);
    for (const p of v.positions) lines.push(`- ${p.asset} : ${fmtEur(p.valueEur)} (${p.pnlEur >= 0 ? "+" : "−"}${fmtEur(Math.abs(p.pnlEur))})${p.invalidation !== null ? `, stop ${fmtEur(p.invalidation)}` : ""}`);
  }
  // Chronological, the way the owner reads a day.
  const orders = recentOrders(db, 20, sinceIso).filter((o) => o.placedAt >= sinceIso || (o.settledAt ?? "") >= sinceIso).reverse();
  lines.push("", "Opérations du jour :");
  if (orders.length === 0) lines.push("- aucune");
  for (const o of orders) {
    const what = o.side === "buy" ? `achat de ${fmtEur(o.amountEur ?? 0)} de ${o.asset}` : `vente de ${o.quantity} ${o.asset}`;
    const state = o.status === "pending" ? "en attente" : o.status === "filled" ? `exécuté à ${fmtEur(o.fillPrice!)} (frais ${fmtEur(o.feeEur!)})` : o.status === "expired" ? `expiré (${orderNoteFr(o.note)})` : o.status === "cancelled" ? `annulé (${orderNoteFr(o.note)})` : "refusé";
    lines.push(`- ${fmtTime(o.placedAt, tz)} ${what}${o.origin === "stop" ? " [stop automatique]" : ""} : ${state}`);
    if (o.origin !== "stop") lines.push(`  Raison : ${o.thesis}`);
  }
  const trades = listTrades(db, 10, sinceIso).reverse();
  for (const t of trades) lines.push(`- opération close sur ${t.asset} : ${t.pnlEur >= 0 ? "+" : "−"}${fmtEur(Math.abs(t.pnlEur))} (${t.pnlPct >= 0 ? "+" : "−"}${Math.abs(t.pnlPct).toFixed(2).replace(".", ",")} %)${t.closeReason === "stop" ? ", par le stop" : ""}`);
  const resolved = (db.prepare("SELECT id FROM trader_predictions WHERE resolved_at >= ? ORDER BY resolved_at ASC").all(sinceIso) as { id: string }[]).map((r) => getPrediction(db, r.id)!);
  const made = count(db, "SELECT COUNT(*) AS n FROM trader_predictions WHERE made_at >= ?", sinceIso);
  lines.push("", "Prédictions :");
  lines.push(`- ${plural(made, "nouvelle", "nouvelles")}, ${plural(resolved.length, "résolue")}${resolved.length ? " :" : ""}`);
  for (const p of resolved.slice(0, 4)) lines.push(`  · ${describeResolutionFr(p)}`);
  const reflections = count(db, "SELECT COUNT(*) AS n FROM trader_reflections WHERE recorded_at >= ?", sinceIso);
  const lessons = count(db, "SELECT COUNT(*) AS n FROM trader_lessons WHERE recorded_at >= ?", sinceIso);
  const spentToday = inferenceGetDailyCost(db, now.toISOString().slice(0, 10));
  const cap = lab?.inference.dailyCents ?? null;
  lines.push("", `Écrit : ${plural(reflections, "note de journal", "notes de journal")}, ${plural(lessons, "leçon")} · autopsie du soir : ${consolidationStatusFr(db, cfg, now)} · IA aujourd'hui : ${fmtUsdCents(spentToday)}${cap !== null ? ` sur ${fmtUsdCents(cap)}` : ""}`);
  const daily = db.prepare("SELECT content FROM trader_reflections WHERE kind = 'daily' AND recorded_at >= ? ORDER BY recorded_at DESC LIMIT 1").get(sinceIso) as { content: string } | undefined;
  if (daily) lines.push("", `Sa note du soir : ${daily.content}`);
  lines.push("", "Détails : /portefeuille · /statut · /journal");
  return lines.join("\n");
}
