/**
 * Sonni agent tools: sonni_memory (read), record_prediction and propose_hypothesis (append).
 *
 * The model reads its memory pack, records predictions and proposes
 * hypotheses. It cannot edit or delete a prediction, resolve one, or set
 * a hypothesis's confidence or historical verdict: code computes those.
 */

import type { AutomatonTool } from "../types.js";
import { buildMemoryPack } from "./pack.js";
import { recordPrediction, MAX_HORIZON_HOURS, MIN_HORIZON_HOURS } from "./predictions.js";
import { addHypothesis, hypothesisCounts } from "./hypotheses.js";
import { describeTest, runHistoricalTest } from "./historical.js";
import { intakeOpen, MAX_MODEL_HYPOTHESES_PER_DAY, MAX_PRIOR_HYPOTHESES } from "./intake.js";
import { parseTestRule, RULE_LANGUAGE, type TestRule } from "./rules.js";

export function createTraderTools(): AutomatonTool[] {
  return [
    {
      name: "propose_hypothesis",
      description:
        "Add a hypothesis (an intuition about how markets behave) to your memory. It is kept for good, refuted or " +
        "not. When the rule language below can express it, give a test_rule: code tests it at once on the stored " +
        "daily history and returns the verdict (supported, refuted, inconclusive, insufficient). Your predictions " +
        "test every hypothesis going forward. Limits: " + MAX_PRIOR_HYPOTHESES + " during your intake, " +
        MAX_MODEL_HYPOTHESES_PER_DAY + " per day afterwards.\n" + RULE_LANGUAGE,
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          statement: { type: "string", description: "The hypothesis in one or two sentences" },
          test_rule: { type: "object", description: "Optional machine-checkable form (see the rule language)" },
        },
        required: ["statement"],
      },
      execute: async (args, ctx) => {
        const cfg = ctx.config.trader;
        if (!cfg) return "Sonni is not configured on this runtime.";
        const db = ctx.db.raw;
        const prior = intakeOpen(db);
        const counts = hypothesisCounts(db);
        if (prior && (counts.byOrigin.prior ?? 0) >= MAX_PRIOR_HYPOTHESES) {
          return `Refused: the intake already holds ${MAX_PRIOR_HYPOTHESES} hypotheses. Finish the intake.`;
        }
        if (!prior && counts.modelToday >= MAX_MODEL_HYPOTHESES_PER_DAY) {
          return `Refused: ${MAX_MODEL_HYPOTHESES_PER_DAY} hypotheses already added today. Test the ones you have.`;
        }
        let rule: TestRule | null = null;
        if (args.test_rule !== undefined && args.test_rule !== null) {
          try {
            // Some calls send the object as a JSON string.
            const raw = typeof args.test_rule === "string" ? JSON.parse(args.test_rule) : args.test_rule;
            rule = parseTestRule(raw, cfg.assets.map((a) => a.symbol));
          } catch (err: any) {
            return `Refused, invalid test_rule: ${err?.message ?? err}. Fix it or omit test_rule.`;
          }
        }
        let h;
        try {
          h = addHypothesis(db, { statement: String(args.statement ?? ""), origin: prior ? "prior" : "observation", testRule: rule });
        } catch (err: any) {
          return `Refused: ${err?.message ?? err}`;
        }
        const test = runHistoricalTest(db, h);
        return `Hypothesis ${h.id} recorded (${h.origin}). ` +
          (test ? describeTest(test) + "." : "No test_rule: your predictions will test it.");
      },
    },
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
