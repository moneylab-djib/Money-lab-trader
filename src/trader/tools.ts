/**
 * Sonni agent tools: sonni_memory (read) and record_prediction (append).
 *
 * The model reads its memory pack and records predictions. It cannot
 * edit or delete a prediction, resolve one, or set a hypothesis's
 * confidence: those are code (resolver) or owner (/idee) actions.
 */

import type { AutomatonTool } from "../types.js";
import { buildMemoryPack } from "./pack.js";
import { recordPrediction, MAX_HORIZON_HOURS, MIN_HORIZON_HOURS } from "./predictions.js";

export function createTraderTools(): AutomatonTool[] {
  return [
    {
      name: "sonni_memory",
      description:
        "Read your memory pack: latest prices and changes computed by code, your hypotheses with their computed " +
        "confidence, open predictions, and recent resolutions with Brier scores. Read it before every decision.",
      category: "memory",
      riskLevel: "safe",
      parameters: { type: "object", properties: {}, required: [] },
      execute: async (_args, ctx) => {
        const cfg = ctx.config.trader;
        if (!cfg) return "Sonni is not configured on this runtime.";
        return buildMemoryPack(ctx.db.raw, cfg);
      },
    },
    {
      name: "record_prediction",
      description:
        "Record a prediction BEFORE its outcome is known. It states one event that the linked hypothesis implies: " +
        "the asset's price will be above or below a threshold (EUR) at the horizon, with your probability (0 to 1) " +
        "that the event happens. Predictions can never be edited or deleted. At the horizon, code reads the price, " +
        "scores you (Brier) and adds support (event happened) or contradiction (it did not) to the hypothesis. " +
        "Refused when the latest price is stale.",
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          asset: { type: "string", description: "Followed asset symbol, e.g. BTC" },
          direction: { type: "string", enum: ["above", "below"] },
          threshold: { type: "number", description: "Price threshold in EUR" },
          horizon_hours: {
            type: "number",
            description: `Hours from now until the price is checked (${MIN_HORIZON_HOURS} to ${MAX_HORIZON_HOURS})`,
          },
          probability: { type: "number", description: "Your probability that the event happens, 0 to 1" },
          hypothesis_id: { type: "string", description: "Hypothesis this prediction tests (id from sonni_memory)" },
          statement: { type: "string", description: "The prediction in one sentence" },
          rationale: { type: "string", description: "Why: the evidence and reasoning behind your probability" },
        },
        required: ["asset", "direction", "threshold", "horizon_hours", "probability", "hypothesis_id", "statement", "rationale"],
      },
      execute: async (args, ctx) => {
        const cfg = ctx.config.trader;
        if (!cfg) return "Sonni is not configured on this runtime.";
        const result = recordPrediction(ctx.db.raw, cfg, {
          asset: String(args.asset ?? ""),
          direction: String(args.direction ?? ""),
          threshold: Number(args.threshold),
          horizonHours: Number(args.horizon_hours),
          probability: Number(args.probability),
          hypothesisId: String(args.hypothesis_id ?? ""),
          statement: String(args.statement ?? ""),
          rationale: String(args.rationale ?? ""),
        });
        if (!result.ok) return `Prediction refused: ${result.error}`;
        const p = result.prediction;
        return `Prediction ${p.id} recorded: ${p.asset} ${p.direction} ${p.threshold} EUR at ${p.horizonUntil}, ` +
          `p=${p.probability} (reference price ${p.referencePrice} EUR at ${p.referenceTs}).`;
      },
    },
  ];
}
