/**
 * Sonni memory pack (docs/MEMORY.md section 6)
 *
 * Built by code before a decision, from the stores that exist in this
 * slice: indicators computed from stored prices (the model never reads
 * raw series), hypotheses with their computed confidence, open
 * predictions, and recent resolutions with their scores. Bounded lists
 * keep the pack small.
 */

import type Database from "better-sqlite3";
import type { TraderConfig } from "./config.js";
import { listHypotheses } from "./hypotheses.js";
import { brierSummary, listOpenPredictions, listResolvedPredictions } from "./predictions.js";
import { ageMinutes, isoSeconds, latestPrice, priceAtOrBefore } from "./prices.js";

type DB = Database.Database;

const MAX_HYPOTHESES = 20;
const MAX_OPEN = 20;
const MAX_RESOLVED = 10;

function pct(from: number, to: number): string {
  const change = ((to - from) / from) * 100;
  return `${change >= 0 ? "+" : ""}${change.toFixed(2)} %`;
}

function eur(value: number): string {
  return `${value.toFixed(2)} EUR`;
}

export function buildMemoryPack(db: DB, cfg: TraderConfig, now: Date = new Date()): string {
  const lines: string[] = [`MEMORY PACK — ${isoSeconds(now)}`];

  lines.push("", "Prices (Kraken, computed by code):");
  for (const asset of cfg.assets) {
    const last = latestPrice(db, asset.symbol);
    if (!last) {
      lines.push(`- ${asset.symbol}: no price yet`);
      continue;
    }
    const age = ageMinutes(last, now);
    const stale = age > cfg.staleMinutes ? ` STALE (limit ${cfg.staleMinutes} min): no prediction allowed` : "";
    const changes = [1, 24, 24 * 7].map((hours) => {
      const past = priceAtOrBefore(db, asset.symbol, isoSeconds(new Date(Date.parse(last.ts) - hours * 3_600_000)));
      return past ? `${hours === 168 ? "7 d" : `${hours} h`} ${pct(past.price, last.price)}` : null;
    }).filter(Boolean);
    lines.push(
      `- ${asset.symbol}: ${eur(last.price)} at ${last.ts} (${Math.round(age)} min old)${stale}` +
        (changes.length ? `; change ${changes.join(", ")}` : "; not enough history for changes yet"),
    );
  }

  const hypotheses = listHypotheses(db);
  lines.push("", `Hypotheses (${hypotheses.length}; confidence computed from resolved predictions):`);
  if (hypotheses.length === 0) lines.push("- none yet: the owner adds them with /idee");
  for (const h of hypotheses.slice(0, MAX_HYPOTHESES)) {
    lines.push(
      `- ${h.id} [${h.status}] ${h.statement.slice(0, 300)} ` +
        `(evidence ${h.supports} for / ${h.contradicts} against, confidence ${h.confidence.toFixed(2)})`,
    );
  }

  const open = listOpenPredictions(db);
  lines.push("", `Open predictions (${open.length}):`);
  if (open.length === 0) lines.push("- none");
  for (const p of open.slice(0, MAX_OPEN)) {
    lines.push(
      `- ${p.id}: ${p.asset} ${p.direction} ${eur(p.threshold)} at ${p.horizonUntil}, p=${p.probability} ` +
        `(made at ${eur(p.referencePrice)}, hypothesis ${p.hypothesisId})`,
    );
  }

  const resolved = listResolvedPredictions(db, MAX_RESOLVED);
  const summary = brierSummary(db);
  lines.push(
    "",
    `Recent resolutions (Brier score: 0 is perfect, 0.25 is a constant 50 %; ` +
      `mean ${summary.meanBrier === null ? "n/a" : summary.meanBrier.toFixed(3)} over ${summary.scored} scored):`,
  );
  if (resolved.length === 0) lines.push("- none yet");
  for (const p of resolved) {
    lines.push(
      p.voidReason
        ? `- ${p.id}: void (${p.voidReason})`
        : `- ${p.id}: ${p.asset} ${p.direction} ${eur(p.threshold)} -> ${eur(p.resolutionPrice!)}, ` +
          `${p.outcome === 1 ? "happened" : "did not happen"}, p=${p.probability}, Brier ${p.brier!.toFixed(3)}`,
    );
  }
  return lines.join("\n");
}
