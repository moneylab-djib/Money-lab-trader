/**
 * Sonni operator status, in French (project rule). Local state only: no
 * network call, no inference.
 */

import type Database from "better-sqlite3";
import type { TraderConfig } from "./config.js";
import { listHypotheses, type HypothesisStatus } from "./hypotheses.js";
import { latestHistoricalTest, verdictCounts, type HistoricalTest } from "./historical.js";
import { rankHypotheses } from "./pack.js";
import { EVENT_LABEL_FR, upcomingEvents } from "./events.js";
import { brierSummary, listOpenPredictions, listResolvedPredictions } from "./predictions.js";
import { ageMinutes, latestPrice } from "./prices.js";
import { wakesDeliveredToday } from "./curiosity.js";
import { listSources } from "./sources.js";
import { activeLessons, currentIdentity, identityHistory, listLessons, listReflections } from "./soul.js";
import { activeConfig } from "./universe.js";

type DB = Database.Database;

const STATUS_FR: Record<HypothesisStatus, string> = {
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

function historyFr(t: HistoricalTest | undefined): string {
  if (!t) return "";
  if (t.cases === 0) return " — historique : aucun cas";
  const base = t.baseCases === null ? "50 %" : `${Math.round((t.baseRate ?? 0) * 100)} % d'habitude`;
  return ` — historique : ${Math.round((t.rate ?? 0) * 100)} % des ${t.cases} cas contre ${base}, ${VERDICT_FR[t.verdict]}`;
}

function eur(value: number): string {
  return `${value.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

function when(iso: string): string {
  return iso.replace("T", " ").replace(/:\d\dZ$/, " UTC");
}

function sens(direction: string): string {
  return direction === "above" ? "au-dessus de" : "en dessous de";
}

export function formatSonniStatus(db: DB, baseCfg: TraderConfig, now: Date = new Date()): string {
  const cfg = activeConfig(db, baseCfg);
  const out: string[] = ["=== SONNI — portefeuille virtuel, phase d'entraînement ==="];

  out.push("", "Prix (Kraken) :");
  for (const asset of cfg.assets) {
    const last = latestPrice(db, asset.symbol);
    if (!last) {
      out.push(`- ${asset.symbol} : aucun prix encore`);
      continue;
    }
    const age = Math.round(ageMinutes(last, now));
    const stale = age > cfg.staleMinutes ? " — PÉRIMÉ, pas de prédiction possible" : "";
    out.push(`- ${asset.symbol} : ${eur(last.price)} (il y a ${age} min)${stale}`);
  }

  const next = upcomingEvents(db, now, 30)[0];
  out.push("", next ? `Prochain événement : ${EVENT_LABEL_FR[next.type]} le ${next.day} (/agenda pour la liste)` : "Prochain événement : aucun connu");

  const observations = (db.prepare("SELECT COUNT(*) AS n FROM trader_observations WHERE published_at >= ?")
    .get(new Date(now.getTime() - 86_400_000).toISOString()) as { n: number }).n;
  const sources = listSources(db, "enabled").length;
  const proposed = listSources(db, "proposed").length;
  out.push(
    `Vie de Sonni : ${wakesDeliveredToday(db, now)} réveil(s) sur ${cfg.curiosity.maxSelfWakesPerDay} aujourd'hui (/reveils), ` +
      `${observations} observation(s) sur 24 h (/lecteurs), ${sources} source(s) active(s)${proposed ? `, ${proposed} proposée(s) à décider` : ""} (/sources), ` +
      `identité v${currentIdentity(db, now).version}, ${activeLessons(db).length} leçon(s) (/identite, /journal, /lecons).`,
  );

  const open = listOpenPredictions(db);
  out.push("", `Prédictions ouvertes (${open.length}) :`);
  if (open.length === 0) out.push("- aucune");
  for (const p of open.slice(0, 10)) {
    out.push(`- ${p.asset} ${sens(p.direction)} ${eur(p.threshold)} le ${when(p.horizonUntil)}, probabilité ${Math.round(p.probability * 100)} % (${p.id})`);
  }
  if (open.length > 10) out.push(`(${open.length - 10} autres non affichées)`);

  const resolved = listResolvedPredictions(db, 10);
  const summary = brierSummary(db);
  out.push(
    "",
    `Prédictions résolues — score de Brier moyen : ${summary.meanBrier === null ? "pas encore" : summary.meanBrier.toFixed(3)} ` +
      `sur ${summary.scored} (0 = parfait, 0,25 = toujours 50 %) :`,
  );
  if (resolved.length === 0) out.push("- aucune");
  for (const p of resolved) {
    out.push(
      p.voidReason
        ? `- ${p.asset} ${sens(p.direction)} ${eur(p.threshold)} : annulée, pas de prix à l'échéance (${p.id})`
        : `- ${p.asset} ${sens(p.direction)} ${eur(p.threshold)} : ${p.outcome === 1 ? "VRAI" : "FAUX"} ` +
          `(prix ${eur(p.resolutionPrice!)}), probabilité ${Math.round(p.probability * 100)} %, Brier ${p.brier!.toFixed(3)} (${p.id})`,
    );
  }

  const hypotheses = listHypotheses(db);
  const tests = new Map(hypotheses.map((h) => [h.id, latestHistoricalTest(db, h.id)]));
  const v = verdictCounts(db);
  out.push("", `Intuitions (${hypotheses.length}${v.tested ? ` ; historique : ${v.supported} confirmées, ${v.refuted} contredites, ${v.inconclusive + v.insufficient} sans verdict` : ""}) :`);
  if (hypotheses.length === 0) out.push("- aucune : ajoute-en avec /idee <texte>");
  for (const h of rankHypotheses(hypotheses, tests).slice(0, 10)) {
    out.push(
      `- [${STATUS_FR[h.status]}] ${h.statement.slice(0, 160)} — ${h.supports} pour, ${h.contradicts} contre, ` +
        `confiance ${Math.round(h.confidence * 100)} %${historyFr(tests.get(h.id))} (${h.id})`,
    );
  }
  if (hypotheses.length > 10) out.push(`(${hypotheses.length - 10} autres : /intuitions pour la liste)`);
  return out.join("\n");
}

export function formatHypotheses(db: DB, limit = 40): string {
  const hypotheses = listHypotheses(db);
  if (hypotheses.length === 0) return "Aucune intuition. Ajoute-en avec /idee <texte>.";
  const tests = new Map(hypotheses.map((h) => [h.id, latestHistoricalTest(db, h.id)]));
  const ORIGIN_FR: Record<string, string> = { prior: "savoir de Sonni", observation: "Sonni", owner: "toi", review: "revue" };
  const lines = rankHypotheses(hypotheses, tests).slice(0, limit).map((h) =>
    `- ${h.id} [${STATUS_FR[h.status]}, ${ORIGIN_FR[h.origin] ?? h.origin}] ${h.statement} — ${h.supports} pour, ` +
      `${h.contradicts} contre, confiance ${Math.round(h.confidence * 100)} %${historyFr(tests.get(h.id))}`,
  );
  if (hypotheses.length > limit) lines.push(`(${hypotheses.length - limit} autres, les moins étayées)`);
  return lines.join("\n");
}

export function formatAgenda(db: DB, now: Date = new Date()): string {
  const events = upcomingEvents(db, now, 30);
  if (events.length === 0) {
    return "Aucun événement connu pour les 30 prochains jours. Les dates de la Fed se mettent à jour chaque jour ; " +
      "pour l'inflation et l'emploi américains, ajoute une clé FRED (voir le guide).";
  }
  return ["Événements des 30 prochains jours :", ...events.map((e) => `- ${e.day} : ${EVENT_LABEL_FR[e.type]}`)].join("\n");
}

const KIND_FR: Record<string, string> = { postmortem: "post-mortem", session: "séance", daily: "quotidienne", weekly: "hebdomadaire" };

export function formatIdentityFr(db: DB): string {
  const current = currentIdentity(db);
  const history = identityHistory(db, 6).slice(1);
  const who = current.source === "seed" ? "le code (version de départ)" : current.source === "model" ? "Sonni" : "toi";
  const lines = [`Identité de Sonni — version ${current.version}, écrite par ${who} le ${current.recordedAt.slice(0, 10)} :`, "", current.content];
  if (history.length) {
    lines.push("", "Versions précédentes :");
    for (const v of history) lines.push(`- v${v.version} (${v.recordedAt.slice(0, 10)}, ${v.source === "model" ? "Sonni" : v.source === "owner" ? "toi" : "code"}) : ${v.reason}`);
  }
  return lines.join("\n");
}

export function formatJournalFr(db: DB, limit = 5): string {
  const reflections = listReflections(db, limit);
  if (reflections.length === 0) return "Journal vide : Sonni écrit un post-mortem après chaque prédiction résolue et une note après ses séances.";
  return [`Journal de Sonni (${reflections.length} dernière(s) réflexion(s)) :`, ...reflections.map((r) =>
    `\n— ${r.recordedAt.slice(0, 16).replace("T", " ")} UTC, ${KIND_FR[r.kind] ?? r.kind}${r.subjectId ? ` (${r.subjectId})` : ""} —\n${r.content}`)].join("\n");
}

export function formatLessonsFr(db: DB): string {
  const lessons = listLessons(db, true);
  const active = lessons.filter((l) => l.status === "active");
  const retired = lessons.filter((l) => l.status === "retired");
  if (lessons.length === 0) return "Aucune leçon encore. Sonni en ajoute quand plusieurs post-mortems et son bilan vont dans le même sens.";
  const lines = [`Leçons actives (${active.length}) — /veto <id> [raison] pour en retirer une :`];
  if (active.length === 0) lines.push("- aucune");
  for (const l of active) lines.push(`- ${l.id} (${l.recordedAt.slice(0, 10)}) : ${l.text} [preuves : ${l.evidenceIds.join(", ")}]`);
  if (retired.length) {
    lines.push("", `Retirées (${retired.length}) :`);
    for (const l of retired.slice(-5)) lines.push(`- ${l.id} : ${l.text} — retirée par ${l.retiredBy === "owner" ? "toi" : "Sonni"} : ${l.retireReason}`);
  }
  return lines.join("\n");
}
