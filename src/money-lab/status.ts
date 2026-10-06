/**
 * Money Lab status / daily summary.
 *
 * Operator-facing output is in French (project rule); code stays English.
 * Reads local state only: no network call, no inference.
 */

import type Database from "better-sqlite3";
import type { AutomatonConfig } from "../types.js";
import { inferenceGetDailyCost, inferenceGetHourlyCost } from "../state/database.js";
import { paymentsSpentTodayCents } from "./guard.js";
import { survivalBalance } from "./selfhosted.js";
import {
  getKV,
  getPauseState,
  getNoProgressCycles,
  listExperiments,
  listHelpRequests,
  summarizeFinances,
} from "./journal.js";
import { getBudgetPlan, getFocus, weeklySpend } from "./allocation.js";

const CATEGORY_FR: Record<string, string> = {
  research: "recherche", build: "construction", marketing: "marketing", learning: "apprentissage",
  operations: "fonctionnement", unassigned: "non classé",
};

function usd(cents: number | null): string {
  if (cents === null) return "inconnu";
  const sign = cents < 0 ? "-" : "";
  return `${sign}${(Math.abs(cents) / 100).toFixed(2)} USD`;
}

export function formatStatus(
  db: Database.Database,
  config: Pick<AutomatonConfig, "moneyLab" | "name" | "sandboxId">,
  title = "ÉTAT MONEY LAB",
): string {
  const lab = config.moneyLab;
  const out: string[] = [`=== ${title} — ${config.name} ===`];
  if (!lab) {
    out.push("Profil Money Lab absent : cette instance tourne en mode Automaton standard.");
    return out.join("\n");
  }

  const paused = getPauseState(db);
  out.push(
    paused
      ? `Pause : OUI depuis ${paused.at} (${paused.by === "operator" ? "opérateur" : "runtime"}) — ${paused.reason}`
      : "Pause : non",
  );
  const kv = (key: string) => getKV(db, key);
  out.push(`État de l'agent : ${kv("agent_state") ?? "inconnu"}`);
  const sleepUntil = kv("sleep_until");
  if (sleepUntil) out.push(`Sommeil jusqu'à : ${sleepUntil}${kv("sleep_reason") ? ` — ${kv("sleep_reason")}` : ""}`);
  out.push(`Cycles sans progrès : ${getNoProgressCycles(db)} / ${lab.noProgressCycles ?? "désactivé"}`);

  const limit = (v: number | null) => (v === null ? "aucune limite" : usd(v));
  if (lab.runtime === "self-hosted") {
    const s = survivalBalance(db, lab);
    out.push("", "Survie :");
    out.push(`  Solde : ${usd(s.balanceCents)} (fonds ${usd(s.fundingCents)} + revenus confirmés ${usd(s.confirmedRevenueCents)} - dépensé ${usd(s.spentCents)})`);
    out.push(`  Consommation : ~${usd(s.burnPerDayCents)}/jour — ${s.daysLeft === null ? "aucune dépense récente" : `≈ ${s.daysLeft.toFixed(1)} jours restants`}`);
    if (s.balanceCents < 0) out.push("  ÉTAT : MORT (plus de fonds). /fonds ou un revenu confirmé le ranime.");
  }
  out.push("", "Inférence (UTC) :");
  out.push(`  Aujourd'hui : ${usd(inferenceGetDailyCost(db))} / ${limit(lab.inference.dailyCents)}`);
  out.push(`  Heure en cours : ${usd(inferenceGetHourlyCost(db))} / ${limit(lab.inference.hourlyCents)}`);
  out.push(`  Plafond par appel : ${limit(lab.inference.perCallCents)} — modèle ${lab.inference.model ?? "choisi par le runtime"}`);
  {
    const plan = getBudgetPlan(db);
    const spend = weeklySpend(db);
    out.push("", "Répartition du budget (semaine en cours) :");
    out.push(`  Plan : ${plan ? Object.entries(plan).map(([c, p]) => `${CATEGORY_FR[c] ?? c} ${p} %`).join(", ") : "pas encore défini"}`);
    out.push(`  Dépensé : ${Object.keys(spend).length ? Object.entries(spend).map(([c, v]) => `${CATEGORY_FR[c] ?? c} ${usd(v)}`).join(", ") : "rien"} — activité actuelle : ${CATEGORY_FR[getFocus(db)] ?? getFocus(db)}`);
  }
  out.push("", `Paiements par l'agent (achats de crédits, x402, transferts) : ${lab.payments === "allowed" ? "AUTORISÉS" : "désactivés"}`);
  if (lab.payments === "allowed") {
    out.push(`  Payé aujourd'hui : ${usd(paymentsSpentTodayCents(db))} / ${limit(lab.paymentLimits.dailyCents)} — par paiement : ${limit(lab.paymentLimits.perPaymentCents)}`);
  }
  out.push(`Réplication : interdite${lab.deniedTools.length ? ` — autres outils refusés : ${lab.deniedTools.join(", ")}` : ""}`);

  if (lab.runtime === "self-hosted") {
    out.push("", "Ressources (facturées MÊME EN PAUSE — à arrêter séparément, voir le guide) :");
  } else {
    out.push("", "Ressources Conway (facturées MÊME EN PAUSE — à arrêter séparément, voir la checklist) :");
    out.push(`  Sandbox configurée : ${config.sandboxId || "aucune"}`);
  }
  if (lab.resources.length === 0) out.push("  Aucune ressource déclarée dans le profil.");
  for (const r of lab.resources) {
    out.push(`  - ${r.id} [${r.kind}] ${r.description} — coût estimé/jour : ${usd(r.expectedDailyCostCents)}`);
  }

  const experiments = listExperiments(db);
  out.push("", `Expériences (${experiments.length}) :`);
  if (experiments.length === 0) out.push("  Aucune.");
  for (const e of experiments) {
    out.push(`  - ${e.id} [${e.status}] ${e.hypothesis}`);
    if (e.artifactRef) out.push(`      artefact : ${e.artifactRef}`);
    if (e.reviewDate) out.push(`      revue prévue : ${e.reviewDate}`);
    if (Object.keys(e.metrics).length) out.push(`      métriques (déclarées par l'agent) : ${JSON.stringify(e.metrics)}`);
  }

  const help = listHelpRequests(db, "open");
  out.push("", `Demandes d'aide ouvertes (${help.length}) :`);
  if (help.length === 0) out.push("  Aucune.");
  for (const h of help) {
    out.push(`  - ${h.id}${h.experimentId ? ` (expérience ${h.experimentId})` : ""}`);
    out.push(`      raison : ${h.reason}`);
    out.push(`      action demandée : ${h.humanAction}`);
    if (h.link) out.push(`      lien : ${h.link}`);
    out.push(`      coût prévu : ${usd(h.expectedCostCents)}`);
    if (h.permissionsRequested.length) out.push(`      permissions : ${h.permissionsRequested.join(", ")}`);
    out.push(`      reprise quand : ${h.resumeCondition}`);
  }

  const f = summarizeFinances(db);
  out.push("", "Finances (USD, montants opérateur/fournisseur ; l'agent n'écrit pas ce registre) :");
  out.push(`  Financement propriétaire : ${usd(f.ownerFundingCents)} (n'est pas un revenu)`);
  out.push(`  Achats de crédits : ${usd(f.creditPurchasesCents)} (valeur prépayée, pas une dépense)`);
  out.push(`  Inférence consommée : ${usd(f.inferenceConsumedCents)}`);
  out.push(`  Hébergement : ${usd(f.hostingCents)} — services externes : ${usd(f.externalServicesCents)}`);
  out.push(`  Frais : ${usd(f.feesCents)} — remboursements : ${usd(f.refundsCents)}`);
  out.push(`  Revenu estimé (non encaissé) : ${usd(f.estimatedRevenueCents)}`);
  out.push(`  Revenu confirmé par le fournisseur : ${usd(f.confirmedRevenueCents)}`);
  out.push(`  Argent effectivement reçu : ${usd(f.cashReceivedCents)}`);
  out.push(`  Résultat (revenu confirmé - frais - remboursements - coûts consommés) : ${usd(f.profitCents)}`);
  if (f.unknownAmountEntries > 0) {
    out.push(`  ATTENTION : ${f.unknownAmountEntries} écriture(s) au montant inconnu — résultat incomplet.`);
  }

  out.push("", "Rappel : limites appliquées dans le processus, pas une isolation inviolable. Expérience supervisée.");
  return out.join("\n");
}
