/**
 * Sonni operator status, in French (project rule). Local state only: no
 * network call, no inference.
 */

import type Database from "better-sqlite3";
import type { TraderConfig } from "./config.js";
import { listHypotheses, type HypothesisStatus } from "./hypotheses.js";
import { brierSummary, listOpenPredictions, listResolvedPredictions } from "./predictions.js";
import { ageMinutes, latestPrice } from "./prices.js";

type DB = Database.Database;

const STATUS_FR: Record<HypothesisStatus, string> = {
  untested: "non testée",
  testing: "en test",
  supported: "confirmée",
  refuted: "réfutée",
  retired: "retirée",
};

function eur(value: number): string {
  return `${value.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

function when(iso: string): string {
  return iso.replace("T", " ").replace(/:\d\dZ$/, " UTC");
}

function sens(direction: string): string {
  return direction === "above" ? "au-dessus de" : "en dessous de";
}

export function formatSonniStatus(db: DB, cfg: TraderConfig, now: Date = new Date()): string {
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
  out.push("", `Intuitions (${hypotheses.length}) :`);
  if (hypotheses.length === 0) out.push("- aucune : ajoute-en avec /idee <texte>");
  for (const h of hypotheses.slice(0, 10)) {
    out.push(
      `- [${STATUS_FR[h.status]}] ${h.statement.slice(0, 160)} — ${h.supports} pour, ${h.contradicts} contre, ` +
        `confiance ${Math.round(h.confidence * 100)} % (${h.id})`,
    );
  }
  if (hypotheses.length > 10) out.push(`(${hypotheses.length - 10} autres non affichées)`);
  return out.join("\n");
}

export function formatHypotheses(db: DB): string {
  const hypotheses = listHypotheses(db);
  if (hypotheses.length === 0) return "Aucune intuition. Ajoute-en avec /idee <texte>.";
  return hypotheses
    .map((h) => `- ${h.id} [${STATUS_FR[h.status]}] ${h.statement} — ${h.supports} pour, ${h.contradicts} contre, confiance ${Math.round(h.confidence * 100)} %`)
    .join("\n");
}
