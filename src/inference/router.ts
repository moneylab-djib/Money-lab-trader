/**
 * Inference Router
 *
 * Routes inference requests through the model registry using
 * tier-based selection, budget enforcement, and provider-specific
 * message transformation.
 */

import type BetterSqlite3 from "better-sqlite3";
import { ulid } from "ulid";
import type {
  InferenceRequest,
  InferenceResult,
  ModelEntry,
  SurvivalTier,
  InferenceTaskType,
  ModelProvider,
  ChatMessage,
  ModelPreference,
} from "../types.js";
import { ModelRegistry } from "./registry.js";
import { InferenceBudgetTracker } from "./budget.js";
import { DEFAULT_ROUTING_MATRIX, TASK_TIMEOUTS } from "./types.js";

type Database = BetterSqlite3.Database;

export class InferenceRouter {
  private db: Database;
  private registry: ModelRegistry;
  private budget: InferenceBudgetTracker;

  constructor(db: Database, registry: ModelRegistry, budget: InferenceBudgetTracker) {
    this.db = db;
    this.registry = registry;
    this.budget = budget;
  }

  /**
   * Route an inference request: select model, check budget,
   * transform messages, call inference, record cost.
   */
  async route(
    request: InferenceRequest,
    inferenceChat: (messages: any[], options: any) => Promise<any>,
  ): Promise<InferenceResult> {
    const { messages, taskType, tier, sessionId, turnId, tools } = request;

    // 1. Select model: a requested model (e.g. a stronger one for a review)
    // when it is enabled, else the routing matrix.
    const normalModel = this.selectModel(tier, taskType);
    let model = this.preferredModel(request) ?? normalModel;
    if (!model) {
      return {
        content: "",
        model: "none",
        provider: "other",
        inputTokens: 0,
        outputTokens: 0,
        costCents: 0,
        latencyMs: 0,
        finishReason: "error",
        toolCalls: undefined,
      };
    }

    // 2. Estimate cost and check budget. Under strict accounting the tool
    // schemas, which are sent with every call, count toward the input.
    const strict = this.budget.config.strictCostAccounting === true;
    const toolChars = strict && tools ? JSON.stringify(tools).length : 0;
    const estimatedTokens =
      messages.reduce((sum, m) => sum + (m.content?.length || 0) / 4, 0) + toolChars / 4;
    const estimate = (entry: ModelEntry) => Math.ceil(
      (estimatedTokens / 1000) * entry.costPer1kInput / 100 +
      (request.maxTokens || 1000) / 1000 * entry.costPer1kOutput / 100,
    );
    let estimatedCostCents = estimate(model);

    let budgetCheck = this.budget.checkBudget(estimatedCostCents, model.modelId);
    // A requested model that does not fit a budget (per call, hour, day)
    // falls back to the normal model instead of blocking the call.
    if (!budgetCheck.allowed && normalModel && model.modelId !== normalModel.modelId) {
      const normalEstimate = estimate(normalModel);
      const normalCheck = this.budget.checkBudget(normalEstimate, normalModel.modelId);
      if (normalCheck.allowed) {
        model = normalModel;
        estimatedCostCents = normalEstimate;
        budgetCheck = normalCheck;
      }
    }
    if (!budgetCheck.allowed) {
      return {
        content: `Budget exceeded: ${budgetCheck.reason}`,
        model: model.modelId,
        provider: model.provider,
        inputTokens: 0,
        outputTokens: 0,
        costCents: 0,
        latencyMs: 0,
        finishReason: "budget_exceeded",
        budgetLimit: budgetCheck.limit,
      };
    }

    // 3. Check session budget
    if (request.sessionId && this.budget.config.sessionBudgetCents > 0) {
      const sessionCost = this.budget.getSessionCost(request.sessionId);
      if (sessionCost + estimatedCostCents > this.budget.config.sessionBudgetCents) {
        return {
          content: `Session budget exceeded: ${sessionCost}c spent + ${estimatedCostCents}c estimated > ${this.budget.config.sessionBudgetCents}c limit`,
          model: model.modelId,
          provider: model.provider,
          inputTokens: 0,
          outputTokens: 0,
          costCents: 0,
          latencyMs: 0,
          finishReason: "budget_exceeded",
          budgetLimit: "session",
        };
      }
    }

    // 4. Transform messages for provider
    const transformedMessages = this.transformMessagesForProvider(messages, model.provider);

    // 5. Build inference options
    const preference = this.getPreference(tier, taskType);
    const maxTokens = request.maxTokens || preference?.maxTokens || model.maxTokens;
    // A bounded long answer (Money Lab passes maxTokens) needs time to be
    // generated: at least 25 ms per output token (40 tokens/s). Aborting it
    // still bills the call and, under strict accounting, pauses the bot.
    const timeout = Math.max(TASK_TIMEOUTS[taskType] || 120_000, (request.maxTokens ?? 0) * 25);

    const inferenceOptions: any = {
      model: model.modelId,
      maxTokens,
      tools: tools,
    };

    // 6. Call inference with timeout
    const startTime = Date.now();
    let response: any;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        inferenceOptions.signal = controller.signal;
        response = await inferenceChat(transformedMessages, inferenceOptions);
      } finally {
        clearTimeout(timer);
      }
    } catch (error: any) {
      const latencyMs = Date.now() - startTime;
      // If fallback is enabled, try next candidate
      if (error.name === "AbortError") {
        // The request was sent and may have been billed. Strict accounting
        // records the estimate instead of treating the call as free.
        if (strict) {
          this.budget.recordCost({
            sessionId, turnId: turnId || null, model: model.modelId, provider: model.provider,
            inputTokens: 0, outputTokens: 0, costCents: estimatedCostCents, latencyMs,
            tier, taskType, cacheHit: false,
          });
        }
        return {
          content: `Inference timeout after ${timeout}ms`,
          model: model.modelId,
          provider: model.provider,
          inputTokens: 0,
          outputTokens: 0,
          costCents: strict ? estimatedCostCents : 0,
          latencyMs,
          finishReason: "timeout",
          ...(strict ? { costEstimated: true } : {}),
        };
      }
      throw error;
    }
    const latencyMs = Date.now() - startTime;

    // 7. Calculate actual cost. Under strict accounting, missing usage is
    // not free: clients fill absent usage with zeros, and a real completion
    // always has prompt tokens, so zero prompt tokens means unknown usage.
    const costEstimated = strict && !(response.usage?.promptTokens > 0);
    const inputTokens = response.usage?.promptTokens || 0;
    const outputTokens = response.usage?.completionTokens || 0;
    // Prompt-cache pricing (Anthropic): writes 1.25x, reads at most 0.1x of
    // the input price. Providers without a cache report neither field.
    const cacheRead = response.usage?.cacheReadTokens || 0;
    const cacheWrite = response.usage?.cacheWriteTokens || 0;
    const billedInputTokens = Math.max(0, inputTokens - cacheRead - cacheWrite)
      + cacheWrite * 1.25 + cacheRead * 0.1;
    const actualCostCents = costEstimated
      ? estimatedCostCents
      : Math.ceil(
        (billedInputTokens / 1000) * model.costPer1kInput / 100 +
        (outputTokens / 1000) * model.costPer1kOutput / 100 +
        (response.usage?.serverToolCents || 0),
      );

    // 8. Record cost
    this.budget.recordCost({
      sessionId,
      turnId: turnId || null,
      model: model.modelId,
      provider: model.provider,
      inputTokens,
      outputTokens,
      costCents: actualCostCents,
      latencyMs,
      tier,
      taskType,
      cacheHit: cacheRead > 0,
    });

    // 9. Build result
    return {
      content: response.message?.content || "",
      model: model.modelId,
      provider: model.provider,
      inputTokens,
      outputTokens,
      costCents: actualCostCents,
      latencyMs,
      toolCalls: response.toolCalls,
      finishReason: response.finishReason || "stop",
      ...(costEstimated ? { costEstimated: true } : {}),
    };
  }

  private preferredModel(request: InferenceRequest): ModelEntry | null {
    if (!request.model) return null;
    const entry = this.registry.get(request.model);
    return entry && entry.enabled ? entry : null;
  }

  /**
   * Select the best model for a given tier and task type.
   *
   * Priority:
   *   1. First routing-matrix candidate present in the registry
   *   2. User-configured model(s) from ModelStrategyConfig
   *      (free/Ollama models are allowed at any tier, including dead)
   */
  selectModel(tier: SurvivalTier, taskType: InferenceTaskType): ModelEntry | null {
    const TIER_ORDER: Record<string, number> = {
      dead: 0, critical: 1, low_compute: 2, normal: 3, high: 4,
    };

    const tierRank = TIER_ORDER[tier] ?? 0;

    // 0. A pinned model replaces matrix and fallback selection entirely.
    const pinned = this.budget.config.pinnedModel;
    if (pinned) {
      const entry = this.registry.get(pinned);
      return entry && entry.enabled ? entry : null;
    }

    // 1. Try routing-matrix candidates
    const preference = this.getPreference(tier, taskType);
    if (preference && preference.candidates.length > 0) {
      for (const candidateId of preference.candidates) {
        const entry = this.registry.get(candidateId);
        if (entry && entry.enabled) {
          return entry;
        }
      }
    }

    // 2. Fall back to user-configured models.
    //    This handles local/Ollama setups where routing-matrix models are absent.
    const strategy = this.budget.config;
    const fallbackIds: (string | undefined)[] =
      tier === "critical" || tier === "dead"
        ? [strategy.criticalModel, strategy.inferenceModel, strategy.lowComputeModel]
        : [strategy.inferenceModel, strategy.lowComputeModel, strategy.criticalModel];

    for (const modelId of fallbackIds) {
      if (!modelId) continue;
      const entry = this.registry.get(modelId);
      if (!entry || !entry.enabled) continue;
      const isFree = entry.costPer1kInput === 0 && entry.costPer1kOutput === 0;
      const tierOk = tierRank >= (TIER_ORDER[entry.tierMinimum] ?? 0);
      if (isFree || tierOk) {
        return entry;
      }
    }

    return null;
  }

  /**
   * Transform messages for a specific provider.
   * Handles Anthropic's alternating-role requirement.
   */
  transformMessagesForProvider(messages: ChatMessage[], provider: ModelProvider): ChatMessage[] {
    if (messages.length === 0) {
      throw new Error("Cannot route inference with empty message array");
    }

    if (provider === "anthropic") {
      return this.fixAnthropicMessages(messages);
    }

    // For OpenAI/Conway, merge consecutive same-role messages
    return this.mergeConsecutiveSameRole(messages);
  }

  /**
   * Fix messages for Anthropic's API requirements:
   * 1. Extract system messages
   * 2. Merge consecutive same-role user/assistant messages
   * 3. Keep tool messages; the Anthropic client groups them into
   *    tool_result blocks
   */
  private fixAnthropicMessages(messages: ChatMessage[]): ChatMessage[] {
    const result: ChatMessage[] = [];

    for (const msg of messages) {
      // System messages are handled separately by the Anthropic client
      if (msg.role === "system") {
        result.push(msg);
        continue;
      }

      // Tool messages stay as they are: the Anthropic client turns them into
      // tool_result blocks right after the matching tool_use. Flattening them
      // into user text made the API reject every request with tool history.
      if (msg.role === "tool") {
        result.push({ ...msg });
        continue;
      }

      // For user/assistant: merge with previous if same role
      const last = result[result.length - 1];
      if (last && last.role === msg.role) {
        last.content = (last.content || "") + "\n" + (msg.content || "");
        if (msg.tool_calls) {
          last.tool_calls = [...(last.tool_calls || []), ...msg.tool_calls];
        }
        continue;
      }

      result.push({ ...msg });
    }

    return result;
  }

  /**
   * Merge consecutive messages with the same role.
   */
  private mergeConsecutiveSameRole(messages: ChatMessage[]): ChatMessage[] {
    const result: ChatMessage[] = [];

    for (const msg of messages) {
      const last = result[result.length - 1];
      if (last && last.role === msg.role && msg.role !== "system" && msg.role !== "tool") {
        last.content = (last.content || "") + "\n" + (msg.content || "");
        if (msg.tool_calls) {
          last.tool_calls = [...(last.tool_calls || []), ...msg.tool_calls];
        }
        continue;
      }
      result.push({ ...msg });
    }

    return result;
  }

  private getPreference(tier: SurvivalTier, taskType: InferenceTaskType): ModelPreference | undefined {
    return DEFAULT_ROUTING_MATRIX[tier]?.[taskType];
  }
}
