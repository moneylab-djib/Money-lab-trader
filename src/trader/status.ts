/**
 * Sonni owner views, in French and in the owner's time zone (project
 * rule). Local state only: no network call, no inference. The status is
 * four short blocks (portfolio, market and predictions, learning, budget);
 * the runtime's technical state lives behind /technique.
 */

import type Database from "better-sqlite3";
import type { TraderConfig } from "./config.js";
import type { MoneyLabConfig } from "../money-lab/profile.js";
import { displayStatement, listHypotheses, type HypothesisStatus } from "./hypotheses.js";
import { latestHistoricalTest, verdictCounts, type HistoricalTest } from "./historical.js";
import { rankHypotheses } from "./pack.js";
import { EVENT_LABEL_FR, upcomingEvents } from "./events.js";
import { brierSummary, listOpenPredictions, listResolvedPredictions, type Prediction } from "./predictions.js";
import { ageMinutes, latestPrice } from "./prices.js";
import { wakesDeliveredToday } from "./curiosity.js";
import { listSources } from "./sources.js";
import { activeLessons, currentIdentity, identityHistory, listLessons, listReflections } from "./soul.js";
import { activeConfig } from "./universe.js";
import { getKV, getPauseState } from "../money-lab/journal.js";
import { survivalBalance } from "../money-lab/selfhosted.js";
import { inferenceGetDailyCost } from "../state/database.js";
import { ago, fmtDay, fmtDayLong, fmtEur, fmtPrice, fmtTime, fmtUsdCents, fmtWhen, plural, qtyText } from "./format.js";
import { describeEvidenceFr, lessonEvidence } from "./lessonuse.js";
import { describeRegimeFr, regimeAt } from "./analogs.js";
import { listTrades, listTraps, type Order, pendingOrders, performance, POSITION_PROBLEM_FR, recentOrders, rejectionNoteFr, suspensionFr, valuation } from "./portfolio.js";

type DB = Database.Database;

export const STATUS_FR: Record<HypothesisStatus, string> = {
  untested: "non testée",
  testing: "en test",
  supported: "confirmée",
  refuted: "réfutée",
  retired: "retirée",
};

const VERDICT_FR: Record<string, string> = {
  supported: "confirmée par l'historique",
  refuted: "contredite par l'historique",
  inconclusive: "historique peu concluant",
  insufficient: "pas assez de cas dans l'historique",
};

const ORIGIN_FR: Record<string, string> = { prior: "savoir de Sonni", observation: "Sonni", owner: "toi", review: "revue" };

function historyFr(t: HistoricalTest | undefined): string {
  if (!t) return "";
  if (t.cases === 0) return " — historique : aucun cas";
  const base = t.baseCases === null ? "50 %" : `${Math.round((t.baseRate ?? 0) * 100)} % d'habitude`;
  return ` — historique : ${Math.round((t.rate ?? 0) * 100)} % des ${t.cases} cas contre ${base}, ${VERDICT_FR[t.verdict]}`;
}

function sens(direction: string): string {
  return direction === "above" ? "au-dessus de" : "en dessous de";
}

export function describePredictionFr(p: Prediction, tz: string): string {
  return `${p.asset} ${sens(p.direction)} ${fmtPrice(p.threshold)} d'ici ${fmtWhen(p.horizonUntil, tz)} — ${Math.round(p.probability * 100)} %`;
}

export function describeResolutionFr(p: Prediction): string {
  if (p.voidReason) return `${p.asset} ${sens(p.direction)} ${fmtPrice(p.threshold)} : annulée, pas de prix à l'échéance`;
  return `${p.asset} ${sens(p.direction)} ${fmtPrice(p.threshold)} : ${p.outcome === 1 ? "VRAI" : "FAUX"} ` +
    `(prix ${fmtPrice(p.resolutionPrice!)}), annoncé à ${Math.round(p.probability * 100)} %, score ${p.brier!.toFixed(3).replace(".", ",")}`;
}

// ─── Budget, from the Money Lab ledger ──────────────────────────

export interface BudgetView {
  spentTodayCents: number;
  dailyCapCents: number | null;
  balanceCents: number;
  daysLeft: number | null;
}

export function budgetView(db: DB, lab: MoneyLabConfig, now: Date = new Date()): BudgetView {
  const s = survivalBalance(db, lab, now);
  return {
    spentTodayCents: inferenceGetDailyCost(db, now.toISOString().slice(0, 10)),
    dailyCapCents: lab.inference.dailyCents,
    balanceCents: s.balanceCents,
    daysLeft: s.daysLeft,
  };
}

/** One line on what the agent is doing now, from the runtime's state. */
export function agentStateFr(db: DB, tz: string, now: Date = new Date()): string {
  const paused = getPauseState(db);
  if (paused) return `en pause depuis ${fmtWhen(paused.at, tz)} (${paused.reason}) — /reprendre pour le relancer`;
  const state = getKV(db, "agent_state");
  const sleepUntil = getKV(db, "sleep_until");
  if (state === "sleeping" && sleepUntil) {
    const reason = (getKV(db, "sleep_reason") ?? "").replace(/\s+/g, " ").slice(0, 120);
    const when = Date.parse(sleepUntil) > now.getTime() ? `jusqu'à ${fmtWhen(sleepUntil, tz)}` : "un instant encore";
    return `dort ${when}${reason ? ` (${reason})` : ""} ; un mouvement de prix, un événement ou ton message le réveillent`;
  }
  if (state === "running") return "au travail en ce moment";
  return state ? `état : ${state}` : "pas encore démarré";
}

// ─── /statut ────────────────────────────────────────────────────

export function formatSonniStatus(db: DB, baseCfg: TraderConfig, now: Date = new Date(), budget: BudgetView | null = null): string {
  const cfg = activeConfig(db, baseCfg);
  const tz = cfg.timeZone;
  const out: string[] = [`🧭 SONNI — ${fmtDayLong(now, tz)}, ${fmtTime(now.toISOString(), tz)}`];

  out.push("", "💼 Portefeuille virtuel");
  out.push(...portfolioLinesFr(db, cfg, now, true));

  out.push("", "📈 Marché");
  const prices = cfg.assets.map((asset) => {
    const last = latestPrice(db, asset.symbol);
    if (!last) return `${asset.symbol} : aucun prix encore`;
    const age = Math.round(ageMinutes(last, now));
    const stale = age > cfg.staleMinutes ? " — PÉRIMÉ" : "";
    return `${asset.symbol} ${fmtPrice(last.price)} (${ago(last.ts, now)})${stale}`;
  });
  out.push(prices.join(" · "));
  const next = upcomingEvents(db, now, 30)[0];
  out.push(next ? `Prochain événement : ${EVENT_LABEL_FR[next.type]} le ${fmtDay(next.day)} (/agenda)` : "Prochain événement : aucun connu (/agenda)");

  const open = listOpenPredictions(db);
  out.push("", `🎯 Prédictions ouvertes (${open.length})${open.length ? " :" : ""}`);
  if (open.length === 0) out.push("Aucune pour l'instant.");
  for (const p of open.slice(0, 8)) out.push(`- ${describePredictionFr(p, tz)}`);
  if (open.length > 8) out.push(`(${open.length - 8} autres)`);
  const summary = brierSummary(db);
  const resolved = listResolvedPredictions(db, 3);
  if (summary.scored === 0 && resolved.length === 0) {
    out.push("Résolues : aucune encore. Le code note chaque prédiction à son échéance (0 = parfait, 0,25 = pile ou face).");
  } else {
    out.push(`Résolues : ${summary.scored} notée(s), score moyen ${summary.meanBrier === null ? "—" : summary.meanBrier.toFixed(3).replace(".", ",")} (0 = parfait, 0,25 = pile ou face). Dernières :`);
    for (const p of resolved) out.push(`- ${describeResolutionFr(p)}`);
  }

  out.push("", "🧠 Apprentissage");
  const hypotheses = listHypotheses(db);
  const v = verdictCounts(db);
  out.push(
    `Intuitions : ${hypotheses.length}` +
      (v.tested ? ` — historique : ${v.supported} confirmées, ${v.refuted} contredites, ${v.inconclusive + v.insufficient} sans verdict` : "") +
      " (/intuitions)",
  );
  const observations = (db.prepare("SELECT COUNT(*) AS n FROM trader_observations WHERE published_at >= ?")
    .get(new Date(now.getTime() - 86_400_000).toISOString()) as { n: number }).n;
  const sources = listSources(db, "enabled").length;
  const proposed = listSources(db, "proposed").length;
  out.push(
    `Lu : ${plural(observations, "observation")} sur 24 h (/lecteurs) · ${plural(sources, "source active", "sources actives")}` +
      `${proposed ? `, ${proposed} à décider` : ""} (/sources) · ${plural(wakesDeliveredToday(db, now), "réveil")} sur ${cfg.curiosity.maxSelfWakesPerDay} aujourd'hui (/reveils)`,
  );
  const reflections = listReflections(db, 1000).length;
  out.push(
    `Écrit : identité v${currentIdentity(db, now).version}, ${plural(reflections, "note de journal", "notes de journal")}, ` +
      `${plural(activeLessons(db).length, "leçon")} (/identite /journal /lecons)`,
  );

  out.push("", "💶 Budget");
  if (budget) {
    out.push(
      `IA aujourd'hui : ${fmtUsdCents(budget.spentTodayCents)}${budget.dailyCapCents !== null ? ` sur ${fmtUsdCents(budget.dailyCapCents)}` : ""}` +
        ` · solde ${fmtUsdCents(budget.balanceCents)}${budget.daysLeft !== null ? ` (≈ ${Math.floor(budget.daysLeft)} jours au rythme actuel)` : ""}`,
    );
  } else {
    out.push("Budget : voir /technique");
  }
  out.push(`Sonni ${agentStateFr(db, tz, now)}.`);
  out.push("", "Détails : /bilan (calibration) · /technique (état du programme)");
  return out.join("\n");
}

// ─── Portfolio, for the owner ───────────────────────────────────

function signed(v: number): string {
  if (!Number.isFinite(v)) return "n.d.";
  return `${v >= 0 ? "+" : "−"}${fmtEur(Math.abs(v))}`;
}

function signedPct(v: number): string {
  if (!Number.isFinite(v)) return "n.d.";
  return `${v >= 0 ? "+" : "−"}${Math.abs(v).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} %`;
}

/** Order notes are written by code in English (the model reads them); the owner gets them in French. */
export function orderNoteFr(note: string | null): string {
  const known: Record<string, string> = {
    "no price stored within 24 h": "aucun prix reçu en 24 h",
    "limit not reached before the horizon": "limite jamais atteinte avant l'échéance",
    "cancelled by model": "annulé par Sonni",
    "cancelled by owner": "annulé par toi",
  };
  return note === null ? "" : rejectionNoteFr(note) ?? known[note] ?? note;
}

function orderLineFr(o: Order, tz: string): string {
  const what = o.side === "buy" ? `achat de ${fmtEur(o.amountEur ?? 0)} de ${o.asset}` : `vente de ${qtyText(o.quantity)} ${o.asset}`;
  const kind = o.kind === "limit" ? ` à ${fmtPrice(o.limitPrice!)} (limite)` : "";
  const who = o.origin === "stop" ? " [stop automatique]" : "";
  if (o.status === "pending") return `${what}${kind}${who}, en attente du prochain prix`;
  if (o.status === "filled") {
    return `${what}${who} : exécuté le ${fmtWhen(o.settledAt!, tz)} à ${fmtPrice(o.fillPrice!)} (${qtyText(o.fillQuantity)} ${o.asset}, frais ${fmtEur(o.feeEur!)})`;
  }
  const status = o.status === "cancelled" ? "annulé" : o.status === "expired" ? "expiré" : "refusé";
  return `${what}${who} : ${status}${o.note ? ` (${orderNoteFr(o.note)})` : ""}`;
}

/** The short portfolio block of /statut, or the full /portefeuille view. */
export function portfolioLinesFr(db: DB, cfg: TraderConfig, now: Date, short: boolean): string[] {
  const tz = cfg.timeZone;
  const v = valuation(db);
  const lines: string[] = [];
  if (v.contributedEur === 0) {
    lines.push(`Pas encore ouvert : ${fmtEur(cfg.portfolio.startEur)} de capital virtuel au premier relevé de prix, puis ${fmtEur(cfg.portfolio.monthlyEur)} par mois.`);
    return lines;
  }
  const suspended = suspensionFr(v);
  if (suspended) {
    // Step 0.3: a corrupt stored position makes the total unknown; no partial sum is shown as the value.
    lines.push(`⚠️ Valeur non fiable, total inconnu : ${suspended}`);
    lines.push(`Liquidités ${fmtEur(v.cashEur)} · ${fmtEur(v.contributedEur)} versés`);
    for (const p of v.invalid) lines.push(`${p.asset} : chiffres invalides (${POSITION_PROBLEM_FR[p.problem]}), non évaluée ; ni vendue ni stoppée par le code`);
  } else {
    lines.push(`Valeur ${fmtEur(v.equityEur)} (${signed(v.pnlEur)}, ${signedPct(v.pnlPct)} sur ${fmtEur(v.contributedEur)} versés) · liquidités ${fmtEur(v.cashEur)}`);
  }
  if (v.positions.length === 0 && v.invalid.length === 0) lines.push("Aucune position : tout en liquide.");
  for (const p of v.positions) {
    lines.push(`${p.asset} : ${p.quantity} (${fmtEur(p.valueEur)}, ${signed(p.pnlEur)} frais d'achat déduits) acheté ${fmtPrice(p.avgCost)}` +
      `${p.invalidation !== null ? `, stop ${fmtPrice(p.invalidation)}` : ""}${p.horizonUntil ? `, revoir ${fmtWhen(p.horizonUntil, tz)}` : ""}` +
      (short ? "" : `
  Raison : ${p.thesis}`));
  }
  const pending = pendingOrders(db);
  for (const o of pending) lines.push(`En attente : ${orderLineFr(o, tz)}`);
  if (short) return lines;
  const perf = performance(db, cfg, 0, now);
  lines.push("", "Résultats (calculés par le code) :");
  lines.push(`- ${plural(perf.tradesClosed, "opération close", "opérations closes")}` +
    (perf.winRate !== null ? `, ${Math.round(perf.winRate * 100)} % gagnantes, ${signedPct(perf.avgTradePct!)} en moyenne (après tous les frais)` : "") +
    ` · frais payés ${fmtEur(perf.feesEur)}${perf.stops ? ` · ${plural(perf.stops, "stop déclenché", "stops déclenchés")}` : ""}`);
  if (!perf.complete) lines.push("- valeur et variations : inconnues tant que les chiffres invalides ne sont pas réparés");
  if (perf.change7dPct !== null) {
    lines.push(`- 7 jours ${signedPct(perf.change7dPct)}${perf.change30dPct !== null ? ` · 30 jours ${signedPct(perf.change30dPct)}` : ""}` +
      `${perf.maxDrawdownPct !== null ? ` · pire recul ${signedPct(-perf.maxDrawdownPct)}` : ""}${perf.firstDay ? ` (depuis le ${fmtDay(perf.firstDay)})` : ""}`);
  }
  const recent = recentOrders(db, 8).filter((o) => o.status !== "pending");
  if (recent.length) {
    lines.push("", "Derniers ordres :");
    for (const o of recent) lines.push(`- ${orderLineFr(o, tz)}`);
  }
  const trades = listTrades(db, 5);
  if (trades.length) {
    lines.push("", "Dernières opérations closes (résultat après tous les frais) :");
    for (const t of trades) {
      lines.push(`- ${t.asset} : ${signed(t.pnlEur)} (${signedPct(t.pnlPct)}), acheté ${fmtPrice(t.entryPrice)} vendu ${fmtPrice(t.exitPrice)} le ${fmtWhen(t.closedAt, tz)}` +
        `${t.closeReason === "stop" ? ", par le stop" : ""} — ${t.thesis.slice(0, 140)}`);
    }
  }
  const traps = listTraps(db);
  if (traps.length) {
    lines.push("", "Pièges qu'il a nommés :");
    for (const t of traps) lines.push(`- « ${t.name} » (${plural(t.hits, "fois")}) : ${t.description}`);
  }
  return lines;
}

export function formatPortfolioFr(db: DB, baseCfg: TraderConfig, now: Date = new Date()): string {
  const cfg = activeConfig(db, baseCfg);
  return [`💼 Portefeuille virtuel de Sonni — ${fmtDayLong(now, cfg.timeZone)}`, ...portfolioLinesFr(db, cfg, now, false),
    "", `Règles : au comptant seulement, au plus ${cfg.portfolio.maxPositionPct} % du portefeuille par actif, frais Kraken ${String(cfg.portfolio.takerFeePct).replace(".", ",")} % (marché) / ${String(cfg.portfolio.makerFeePct).replace(".", ",")} % (limite), exécution au prix suivant. Résumé du jour : /journee.`].join("\n");
}

// ─── /intuitions ────────────────────────────────────────────────

export function formatHypotheses(db: DB, limit = 40): string {
  const hypotheses = listHypotheses(db);
  if (hypotheses.length === 0) return "Aucune intuition. Ajoute-en avec /idee <texte>.";
  const tests = new Map(hypotheses.map((h) => [h.id, latestHistoricalTest(db, h.id)]));
  const v = verdictCounts(db);
  const untranslated = hypotheses.filter((h) => !h.statementFr).length;
  const lines = [
    `Intuitions de Sonni (${hypotheses.length}${v.tested ? ` ; historique : ${v.supported} confirmées, ${v.refuted} contredites, ${v.inconclusive + v.insufficient} sans verdict` : ""}), les plus étayées d'abord :`,
  ];
  for (const h of rankHypotheses(hypotheses, tests).slice(0, limit)) {
    lines.push(
      `- [${STATUS_FR[h.status]}, ${ORIGIN_FR[h.origin] ?? h.origin}] ${displayStatement(h)} — ${h.supports} pour, ` +
        `${h.contradicts} contre, confiance ${Math.round(h.confidence * 100)} %${historyFr(tests.get(h.id))}`,
    );
  }
  if (hypotheses.length > limit) lines.push(`(${hypotheses.length - limit} autres, les moins étayées)`);
  if (untranslated) lines.push(`(${untranslated} encore en anglais : une IA lectrice les traduit dès qu'elle est disponible)`);
  return lines.join("\n");
}

export function formatAgenda(db: DB, now: Date = new Date()): string {
  const events = upcomingEvents(db, now, 30);
  if (events.length === 0) {
    return "Aucun événement connu pour les 30 prochains jours. Les dates de la Fed se mettent à jour chaque jour ; " +
      "pour l'inflation et l'emploi américains, ajoute une clé FRED (voir le guide).";
  }
  return ["Événements des 30 prochains jours :", ...events.map((e) => `- ${fmtDay(e.day)} : ${EVENT_LABEL_FR[e.type]}`)].join("\n");
}

const KIND_FR: Record<string, string> = { postmortem: "post-mortem", session: "séance", daily: "quotidienne", weekly: "hebdomadaire", trade: "opération" };

export function formatIdentityFr(db: DB): string {
  const current = currentIdentity(db);
  const history = identityHistory(db, 6).slice(1);
  const who = current.source === "seed" ? "le code (version de départ)" : current.source === "model" ? "Sonni" : "toi";
  const lines = [`Identité de Sonni — version ${current.version}, écrite par ${who} le ${fmtDay(current.recordedAt.slice(0, 10))} :`, "", current.content];
  if (history.length) {
    lines.push("", "Versions précédentes :");
    for (const v of history) lines.push(`- v${v.version} (${fmtDay(v.recordedAt.slice(0, 10))}, ${v.source === "model" ? "Sonni" : v.source === "owner" ? "toi" : "code"}) : ${v.reason}`);
  }
  return lines.join("\n");
}

export function formatJournalFr(db: DB, limit = 5, tz = "Europe/Paris"): string {
  const reflections = listReflections(db, limit);
  if (reflections.length === 0) return "Journal vide : Sonni écrit un post-mortem après chaque prédiction résolue et une note après ses séances.";
  return [`Journal de Sonni (${reflections.length} dernière(s) réflexion(s)) :`, ...reflections.map((r) =>
    `\n— ${fmtWhen(r.recordedAt, tz)}, ${KIND_FR[r.kind] ?? r.kind} —\n${r.content}`)].join("\n");
}

export function formatLessonsFr(db: DB): string {
  const lessons = listLessons(db, true);
  const active = lessons.filter((l) => l.status === "active");
  const retired = lessons.filter((l) => l.status === "retired");
  if (lessons.length === 0) return "Aucune leçon encore. Sonni en ajoute quand plusieurs post-mortems et son bilan vont dans le même sens.";
  const lines = [`Leçons actives (${active.length}) — /veto <id> [raison] pour en retirer une :`];
  if (active.length === 0) lines.push("- aucune");
  // Step 4 (2026-10-08): how each lesson fared when Sonni applied it, and the market it was learned in.
  const evidence = lessonEvidence(db);
  for (const l of active) {
    const learned = regimeAt(db, "BTC", l.recordedAt.slice(0, 10));
    lines.push(`- ${l.id} (${fmtDay(l.recordedAt.slice(0, 10))}) : ${l.text}`);
    lines.push(`  ${describeEvidenceFr(evidence.get(l.id))}${learned ? ` ; marché du BTC quand il l'a apprise : ${describeRegimeFr(learned)}` : ""}`);
  }
  if (retired.length) {
    lines.push("", `Retirées (${retired.length}) :`);
    for (const l of retired.slice(-5)) lines.push(`- ${l.text} — retirée par ${l.retiredBy === "owner" ? "toi" : "Sonni"} : ${l.retireReason}`);
  }
  return lines.join("\n");
}
