/**
 * Money Lab first-run tests.
 *
 * Fully mocked: global fetch is replaced by a spy that fails the test if
 * any HTTP request is attempted, and USDC balance reads are mocked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

vi.mock("../../conway/x402.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../conway/x402.js")>();
  return { ...actual, getUsdcBalance: vi.fn(async () => 0), x402Fetch: vi.fn(actual.x402Fetch) };
});

import { createDatabase } from "../../state/database.js";
import { runAgentLoop } from "../../agent/loop.js";
import { createBuiltinTools, executeTool } from "../../agent/tools.js";
import { PolicyEngine } from "../../agent/policy-engine.js";
import { SpendTracker } from "../../agent/spend-tracker.js";
import { createDefaultRules } from "../../agent/policy-rules/index.js";
import { ModelRegistry } from "../../inference/registry.js";
import { InferenceBudgetTracker } from "../../inference/budget.js";
import { InferenceRouter } from "../../inference/router.js";
import { x402Fetch, setX402PaymentGuard } from "../../conway/x402.js";
import { topupCredits, topupForSandbox } from "../../conway/topup.js";
import { BUILTIN_TASKS } from "../../heartbeat/tasks.js";
import { DEFAULT_MODEL_STRATEGY_CONFIG } from "../../types.js";
import type { AutomatonConfig, AutomatonDatabase, ToolContext } from "../../types.js";
import {
  applyMoneyLabProfile,
  parseMoneyLabConfig,
  MoneyLabConfigError,
  MONEY_LAB_ALWAYS_DENIED_TOOLS,
  moneyLabDeniedTools,
  automaticTopupsAllowed,
} from "../../money-lab/profile.js";
import { installMoneyLabPaymentGuard, paymentsSpentTodayCents, RUNTIME_ROOT } from "../../money-lab/guard.js";
import {
  ensureMoneyLabSchema,
  upsertExperiment,
  createHelpRequest,
  getHelpRequest,
  resolveHelpRequest,
  addLedgerEntry,
  summarizeFinances,
  pause,
  resume,
  getPauseState,
  getExperiment,
  journalFingerprint,
  getNoProgressCycles,
  listRecentlyClosedHelp,
} from "../../money-lab/journal.js";
import { afterWakeCycle, isOperatorWake } from "../../money-lab/cycle.js";
import { createMoneyLabTools } from "../../money-lab/tools.js";
import { buildMoneyLabPromptBlock } from "../../money-lab/prompt.js";
import { runMoneyLabCommand } from "../../money-lab/cli.js";
import { formatStatus } from "../../money-lab/status.js";
import {
  MockConwayClient,
  MockInferenceClient,
  createTestConfig,
  createTestIdentity,
  noToolResponse,
  toolCallResponse,
} from "../mocks.js";

const SANDBOX = "test-sandbox-id";

function rawProfile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    profile: "first-run",
    runtime: "conway",
    telegram: null,
    stripe: null,
    inference: { model: "gpt-5-mini", effort: null, perCallCents: 5, hourlyCents: 10, dailyCents: 30, maxOutputTokens: 1024 },
    payments: "disabled",
    paymentLimits: { perPaymentCents: null, dailyCents: null },
    deniedTools: [],
    maxTurnsPerCycle: 8,
    noProgressCycles: 3,
    noProgressSleepMinutes: 360,
    resources: [
      { id: SANDBOX, kind: "sandbox", description: "Existing Conway sandbox", expectedDailyCostCents: null },
    ],
    funding: { currency: "USD", provisionedCents: 1500, heldBackCents: 500 },
    ...overrides,
  };
}

function labConfig(overrides: Record<string, unknown> = {}): AutomatonConfig {
  return applyMoneyLabProfile(
    createTestConfig({ moneyLab: rawProfile(overrides) as any, logLevel: "error" }),
  );
}

let tmpDirs: string[] = [];
function dbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "money-lab-test-"));
  tmpDirs.push(dir);
  return path.join(dir, "state.db");
}

function openDb(file = dbPath()): AutomatonDatabase {
  const db = createDatabase(file);
  ensureMoneyLabSchema(db.raw);
  return db;
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn(async () => {
    throw new Error("Network access attempted in a mocked Money Lab test");
  });
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  setX402PaymentGuard(null);
  vi.unstubAllGlobals();
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

// ─── Profile ────────────────────────────────────────────────────

describe("Money Lab profile", () => {
  it("returns null when the block is absent (upstream behaviour unchanged)", () => {
    expect(parseMoneyLabConfig(undefined)).toBeNull();
    const config = createTestConfig();
    expect(applyMoneyLabProfile(config)).toBe(config);
  });

  it("rejects unknown keys, missing keys and zero limits", () => {
    expect(() => parseMoneyLabConfig(rawProfile({ extra: 1 }))).toThrow(MoneyLabConfigError);
    const missing = rawProfile();
    delete missing.funding;
    expect(() => parseMoneyLabConfig(missing)).toThrow(/clé manquante moneyLab.funding/);
    expect(() =>
      parseMoneyLabConfig(
        rawProfile({ inference: { model: "gpt-5-mini", effort: null, perCallCents: 0, hourlyCents: 10, dailyCents: 30, maxOutputTokens: 1024 } }),
        SANDBOX,
      ),
    ).toThrow(/perCallCents/);
    expect(() => parseMoneyLabConfig(rawProfile({ enabled: false }))).toThrow(/enabled/);
  });

  it("rejects inconsistent limits and a foreign publish sandbox", () => {
    expect(() =>
      parseMoneyLabConfig(
        rawProfile({ inference: { model: "m", effort: null, perCallCents: 20, hourlyCents: 10, dailyCents: 30, maxOutputTokens: 1024 } }),
        SANDBOX,
      ),
    ).toThrow(/perCallCents <= hourlyCents/);
    expect(() => parseMoneyLabConfig(rawProfile({ paymentLimits: { perPaymentCents: 2000, dailyCents: 1000 } })))
      .toThrow(/perPaymentCents <= dailyCents/);
    expect(() => parseMoneyLabConfig(rawProfile({ payments: "sometimes" }))).toThrow(/payments/);
  });

  it("ships a valid example configuration", () => {
    const example = JSON.parse(
      fs.readFileSync(path.join(RUNTIME_ROOT, "money-lab", "automaton.money-lab.example.json"), "utf-8"),
    );
    const lab = parseMoneyLabConfig(example.moneyLab)!;
    expect(lab.runtime).toBe("self-hosted");
    expect(lab.inference.model).toBe("claude-sonnet-5-5");
    expect(lab.inference.dailyCents).not.toBeNull();
    expect(lab.telegram?.botTokenEnv).toBe("TELEGRAM_BOT_TOKEN");
  });

  it("accepts null as 'no limit' without imposing defaults", () => {
    const free = applyMoneyLabProfile(createTestConfig({
      moneyLab: rawProfile({
        inference: { model: null, effort: null, perCallCents: null, hourlyCents: null, dailyCents: 300, maxOutputTokens: null },
        maxTurnsPerCycle: null,
        noProgressCycles: null,
      }) as any,
      maxTurnsPerCycle: 25,
      maxTokensPerTurn: 4096,
    }));
    expect(free.modelStrategy?.pinnedModel).toBeUndefined();
    expect(free.modelStrategy?.perCallCeilingCents).toBe(0);
    expect(free.modelStrategy?.hourlyBudgetCents).toBe(0);
    expect(free.modelStrategy?.dailyBudgetCents).toBe(300);
    expect(free.maxTurnsPerCycle).toBe(25);
    expect(free.maxTokensPerTurn).toBe(4096);
    expect(free.maxChildren).toBe(0);
    expect(() => parseMoneyLabConfig(rawProfile({ noProgressSleepMinutes: 0 }))).toThrow(/noProgressSleepMinutes/);
  });

  it("applies strict runtime overrides and never loosens tighter settings", () => {
    const config = applyMoneyLabProfile(
      createTestConfig({
        moneyLab: rawProfile() as any,
        maxChildren: 3,
        modelStrategy: { ...DEFAULT_MODEL_STRATEGY_CONFIG, perCallCeilingCents: 2 },
      }),
    );
    expect(config.maxChildren).toBe(0);
    expect(config.maxTurnsPerCycle).toBe(8);
    expect(config.maxTokensPerTurn).toBe(1024);
    expect(config.modelStrategy?.pinnedModel).toBe("gpt-5-mini");
    expect(config.modelStrategy?.perCallCeilingCents).toBe(2);
    expect(config.modelStrategy?.hourlyBudgetCents).toBe(10);
    expect(config.modelStrategy?.dailyBudgetCents).toBe(30);
  });
});

// ─── Tool policy ────────────────────────────────────────────────

describe("Money Lab tool policy", () => {
  let db: AutomatonDatabase;
  let conway: MockConwayClient;
  let ctx: ToolContext;
  let engine: PolicyEngine;
  const tools = [...createBuiltinTools(SANDBOX), ...createMoneyLabTools()];

  beforeEach(() => {
    db = openDb();
    conway = new MockConwayClient();
    ctx = {
      identity: createTestIdentity(),
      config: labConfig(),
      db,
      conway,
      inference: new MockInferenceClient(),
    };
    engine = new PolicyEngine(db.raw, createDefaultRules());
  });
  afterEach(() => db.close());

  const turn = () => ({ inputSource: "agent" as const, turnToolCallCount: 0, sessionSpend: new SpendTracker(db.raw) });

  it("fails closed when the policy engine or turn context is missing", async () => {
    const noEngine = await executeTool("exec", { command: "echo hi" }, tools, ctx);
    expect(noEngine.error).toMatch(/MONEY_LAB_POLICY_MISSING/);
    const noTurn = await executeTool("exec", { command: "echo hi" }, tools, ctx, engine);
    expect(noTurn.error).toMatch(/MONEY_LAB_POLICY_MISSING/);
    expect(conway.execCalls).toHaveLength(0);
  });

  it("always denies replication and runtime code changes; everything else follows the owner", async () => {
    for (const name of [
      "spawn_child", "start_child", "fund_child", "message_child", "create_goal",
      "edit_own_file", "pull_upstream", "reset_to_upstream",
    ]) {
      expect(MONEY_LAB_ALWAYS_DENIED_TOOLS.has(name)).toBe(true);
      const result = await executeTool(name, {}, tools, ctx, engine, turn());
      expect(result.error, name).toMatch(/MONEY_LAB_TOOL_DISABLED/);
    }
    // payments: "disabled" in the fixture denies the payment tools
    for (const name of ["topup_credits", "transfer_credits", "x402_fetch"]) {
      const result = await executeTool(name, {}, tools, ctx, engine, turn());
      expect(result.error, name).toMatch(/MONEY_LAB_TOOL_DISABLED/);
    }
    // Capabilities that used to be restricted are now free (policy-wise).
    const denied = moneyLabDeniedTools(ctx.config.moneyLab!);
    for (const name of [
      "create_sandbox", "register_domain", "send_message", "git_push",
      "modify_heartbeat", "install_skill", "create_skill", "git_clone", "install_npm_package",
      "search_domains", "update_soul", "reflect_on_soul", "view_soul_history", "update_genesis_prompt",
    ]) {
      expect(denied.has(name), name).toBe(false);
    }
    // MCP servers are stubs that can break every request; switch_model is a
    // no-op under the owner's pinned model that persisted derived budgets.
    for (const name of ["install_mcp_server", "switch_model"]) expect(denied.has(name), name).toBe(true);
    // The owner can still deny extra tools.
    ctx.config = labConfig({ deniedTools: ["register_domain"] });
    const owner = await executeTool("register_domain", { domain: "x.com" }, tools, ctx, engine, turn());
    expect(owner.error).toMatch(/disabled by the owner/);
  });

  it("blocks shell and file access to runtime state, runtime code and the API key", async () => {
    for (const command of [
      "cat ~/.automaton/automaton.json",
      "sqlite3 ~/.automaton/state.db 'delete from kv'",
      "cat ~/.automaton/wallet.json",
      "echo $CONWAY_API_KEY",
      `sed -i s/x/y/ ${path.join(RUNTIME_ROOT, "dist", "index.js")}`,
    ]) {
      const result = await executeTool("exec", { command }, tools, ctx, engine, turn());
      expect(result.error, command).toMatch(/MONEY_LAB_PROTECTED_COMMAND/);
    }
    for (const p of [
      path.join(os.homedir(), ".automaton", "automaton.json"),
      path.join(os.homedir(), ".automaton", "constitution.md"),
      path.join(RUNTIME_ROOT, "src", "money-lab", "guard.ts"),
    ]) {
      const write = await executeTool("write_file", { path: p, content: "x" }, tools, ctx, engine, turn());
      expect(write.error, p).toBeDefined();
    }
    expect(conway.execCalls).toHaveLength(0);
  });

  it("keeps the agent's own working area in ~/.automaton usable", async () => {
    const home = os.homedir();
    for (const p of ["WORKLOG.md", "workspace/app/index.html", "skills/my-skill/SKILL.md", "heartbeat.yml"]) {
      const res = await executeTool("write_file", { path: path.join(home, ".automaton", p), content: "x" }, tools, ctx, engine, turn());
      expect(res.error, p).toBeUndefined();
    }
    const read = await executeTool("exec", { command: "cat ~/.automaton/WORKLOG.md && sqlite3 /root/app/data.db '.tables'" }, tools, ctx, engine, turn());
    expect(read.error).toBeUndefined();
    const wal = await executeTool("write_file", { path: path.join(home, ".automaton", "state.db-wal"), content: "x" }, tools, ctx, engine, turn());
    expect(wal.error).toBeDefined();
  });

  it("allows permitted work and denies every tool while paused", async () => {
    const ok = await executeTool("exec", { command: "ls /root/product" }, tools, ctx, engine, turn());
    expect(ok.error).toBeUndefined();
    expect(conway.execCalls).toHaveLength(1);

    pause(db.raw, "test", "operator");
    const denied = await executeTool("exec", { command: "ls" }, tools, ctx, engine, turn());
    expect(denied.error).toMatch(/MONEY_LAB_PAUSED/);
    expect(conway.execCalls).toHaveLength(1);
  });

  it("counts only x402 amounts actually signed toward the daily payment cap", async () => {
    ctx.config = labConfig({ payments: "allowed", paymentLimits: { perPaymentCents: 500, dailyCents: 1000 } });
    const { x402Fetch: mocked } = await import("../../conway/x402.js");
    vi.mocked(mocked).mockResolvedValueOnce({ success: true, response: "free page" });
    await executeTool("x402_fetch", { url: "https://api.conway.tech/free" }, tools, ctx, engine, turn());
    expect(paymentsSpentTodayCents(db.raw)).toBe(0);
    vi.mocked(mocked).mockResolvedValueOnce({ success: true, response: "paid", paidCents: 37.5 });
    const paid = await executeTool("x402_fetch", { url: "https://api.conway.tech/paid" }, tools, ctx, engine, turn());
    expect(paid.error).toBeUndefined();
    expect(paymentsSpentTodayCents(db.raw)).toBe(38);
  });

  it("allows payments within the owner's per-payment and daily price caps", async () => {
    ctx.config = labConfig({ payments: "allowed", paymentLimits: { perPaymentCents: 500, dailyCents: 1000 } });
    expect(ctx.config.treasuryPolicy?.maxX402PaymentCents).toBeLessThanOrEqual(500);
    expect(ctx.config.treasuryPolicy?.maxDailyTransferCents).toBe(1000);

    const tooBig = await executeTool("topup_credits", { amount_usd: 25 }, tools, ctx, engine, turn());
    expect(tooBig.error).toMatch(/MONEY_LAB_PAYMENT_CAP/);

    const spend = new SpendTracker(db.raw);
    spend.recordSpend({ toolName: "topup_credits", amountCents: 800, category: "other" });
    const overDaily = await executeTool("topup_credits", { amount_usd: 5 }, tools, ctx, engine, turn());
    expect(overDaily.error).toMatch(/MONEY_LAB_PAYMENT_DAILY_CAP/);

    // Policy lets a capped transfer through (the upstream treasury rules then apply as usual).
    const decision = engine.evaluate({
      tool: tools.find((t) => t.name === "transfer_credits")!, args: { to_address: "0xabc", amount_cents: 100 },
      context: ctx, turnContext: turn(),
    });
    expect(decision.rulesTriggered).not.toContain("money_lab.first_run");

    expect(automaticTopupsAllowed(ctx.config.moneyLab)).toBe(false);
    expect(automaticTopupsAllowed(labConfig({ payments: "allowed" }).moneyLab)).toBe(true);
    expect(automaticTopupsAllowed(labConfig().moneyLab)).toBe(false);
  });

  it("does not change upstream policy when the profile is absent", async () => {
    ctx.config = createTestConfig();
    const result = await executeTool("exec", { command: "echo hi" }, tools, ctx, engine, turn());
    expect(result.error).toBeUndefined();
  });
});

// ─── Payments and top-ups ───────────────────────────────────────

describe("Money Lab payment guard", () => {
  const account = { address: "0x1234567890abcdef1234567890abcdef12345678" } as any;

  it("blocks x402 and every top-up path before any network request", async () => {
    installMoneyLabPaymentGuard();
    const pay = await x402Fetch("https://api.conway.tech/pay/5/0xabc", account);
    expect(pay.success).toBe(false);
    expect(pay.error).toMatch(/blocked/);

    const topup = await topupCredits("https://api.conway.tech", account, 5);
    expect(topup.success).toBe(false);

    const sandboxError = Object.assign(new Error("INSUFFICIENT_CREDITS"), { status: 402 });
    const { getUsdcBalance } = await import("../../conway/x402.js");
    vi.mocked(getUsdcBalance).mockResolvedValueOnce(100);
    const sandboxTopup = await topupForSandbox({ apiUrl: "https://api.conway.tech", account, error: sandboxError });
    expect(sandboxTopup?.success).toBe(false);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("heartbeat USDC task neither buys credits nor wakes the agent", async () => {
    const db = openDb();
    const result = await BUILTIN_TASKS.check_usdc_balance(
      { usdcBalance: 100, creditBalance: 0, survivalTier: "critical" } as any,
      { db, config: labConfig(), identity: createTestIdentity() } as any,
    );
    expect(result.shouldWake).toBe(false);
    expect(db.getKV("last_auto_topup_attempt")).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    db.close();
  });
});

// ─── Inference limits and units ─────────────────────────────────

describe("Money Lab inference limits", () => {
  function router(db: AutomatonDatabase, config = labConfig()) {
    const registry = new ModelRegistry(db.raw);
    registry.initialize();
    const budget = new InferenceBudgetTracker(db.raw, config.modelStrategy!);
    return { router: new InferenceRouter(db.raw, registry, budget), budget };
  }

  const request = (maxTokens = 1024) => ({
    messages: [{ role: "user" as const, content: "hello" }],
    taskType: "agent_turn" as const,
    tier: "normal" as const,
    sessionId: "s1",
    maxTokens,
  });

  it("converts token usage to cents using the registry fixture (hundredths of a cent per 1k)", async () => {
    const db = openDb();
    const { router: r } = router(db);
    // gpt-5-mini: input $0.80/M (8), output $3.20/M (32).
    // 10k in = 0.8c, 1k out = 0.32c -> 1.12c, rounded up to 2c.
    const result = await r.route(request(), async () => ({
      message: { content: "ok" },
      usage: { promptTokens: 10_000, completionTokens: 1_000 },
      finishReason: "stop",
    }));
    expect(result.model).toBe("gpt-5-mini");
    expect(result.costCents).toBe(2);
    db.close();
  });

  it("bills prompt-cache reads at a tenth and writes at 1.25x of the input price", async () => {
    const db = openDb();
    const { router: r } = router(db);
    // 100k prompt tokens on gpt-5-mini would be 8c; 90k of them are cache reads:
    // 10k + 90k x 0.1 = 19k billed tokens = 1.52c, rounded up to 2c.
    const read = await r.route(request(), async () => ({
      message: { content: "ok" },
      usage: { promptTokens: 100_000, completionTokens: 0, cacheReadTokens: 90_000, cacheWriteTokens: 0 },
      finishReason: "stop",
    }));
    expect(read.costCents).toBe(2);
    // 80k written: 20k + 80k x 1.25 = 120k billed tokens = 9.6c -> 10c.
    const write = await r.route(request(), async () => ({
      message: { content: "ok" },
      usage: { promptTokens: 100_000, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 80_000 },
      finishReason: "stop",
    }));
    expect(write.costCents).toBe(10);
    db.close();
  });

  it("uses only the pinned model, ignoring the routing matrix", () => {
    const db = openDb();
    const { router: r } = router(db);
    expect(r.selectModel("high", "agent_turn")?.modelId).toBe("gpt-5-mini");
    db.close();
  });

  it("enforces the per-call ceiling against bounded output tokens", async () => {
    const db = openDb();
    const { router: r } = router(db);
    const chat = vi.fn();
    // 16k output tokens on gpt-5-mini = 5.12c > 5c ceiling.
    const result = await r.route(request(16_000), chat);
    expect(result.finishReason).toBe("budget_exceeded");
    expect(chat).not.toHaveBeenCalled();
    db.close();
  });

  it("enforces the daily limit from persisted costs, surviving a restart", async () => {
    const file = dbPath();
    let db = openDb(file);
    const config = labConfig({
      inference: { model: "gpt-5-mini", effort: null, perCallCents: 5, hourlyCents: 30, dailyCents: 30, maxOutputTokens: 1024 },
    });
    router(db, config).budget.recordCost({
      sessionId: "s1", turnId: null, model: "gpt-5-mini", provider: "openai", inputTokens: 0,
      outputTokens: 0, costCents: 30, latencyMs: 1, tier: "normal", taskType: "agent_turn", cacheHit: false,
    });
    db.close();

    db = openDb(file); // simulated restart
    const chat = vi.fn();
    const result = await router(db, config).router.route(request(), chat);
    expect(result.finishReason).toBe("budget_exceeded");
    expect(chat).not.toHaveBeenCalled();

    // The daily check alone (no hourly limit) also reads persisted costs.
    const dailyOnly = new InferenceBudgetTracker(db.raw, { ...DEFAULT_MODEL_STRATEGY_CONFIG, dailyBudgetCents: 30 });
    expect(dailyOnly.checkBudget(1, "gpt-5-mini")).toEqual({
      allowed: false,
      limit: "daily",
      reason: "Daily budget exhausted: 30c spent + 1c estimated > 30c limit",
    });
    // Upstream default (absent/0) keeps its "no limit" meaning.
    expect(new InferenceBudgetTracker(db.raw, DEFAULT_MODEL_STRATEGY_CONFIG).checkBudget(1, "m").allowed).toBe(true);
    db.close();
  });

  it("counts tool schemas in the estimate", async () => {
    const db = openDb();
    const { router: r } = router(db);
    const bigTools = [{ type: "function", function: { name: "x", description: "y".repeat(400_000), parameters: {} } }];
    const chat = vi.fn();
    const result = await r.route({ ...request(), tools: bigTools }, chat);
    expect(result.finishReason).toBe("budget_exceeded");
    expect(chat).not.toHaveBeenCalled();
    db.close();
  });

  it("records an estimate instead of zero when usage is missing or zeroed", async () => {
    const db = openDb();
    const { router: r, budget } = router(db);
    // The real client fills a missing usage block with zeros.
    const zeroed = await r.route(request(), async () => ({
      message: { content: "ok" }, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: "stop",
    }));
    expect(zeroed.costEstimated).toBe(true);
    expect(zeroed.costCents).toBeGreaterThan(0);
    const missing = await r.route(request(), async () => ({ message: { content: "ok" }, finishReason: "stop" }));
    expect(missing.costEstimated).toBe(true);
    expect(budget.getDailyCost()).toBe(zeroed.costCents + missing.costCents);
    db.close();
  });

  it("records the estimate for a timed-out call", async () => {
    const db = openDb();
    const { router: r, budget } = router(db);
    const result = await r.route(request(), async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    });
    expect(result.finishReason).toBe("timeout");
    expect(result.costEstimated).toBe(true);
    expect(budget.getDailyCost()).toBe(result.costCents);
    expect(result.costCents).toBeGreaterThan(0);
    db.close();
  });

  it("keeps upstream accounting unchanged without the profile", async () => {
    const db = openDb();
    const registry = new ModelRegistry(db.raw);
    registry.initialize();
    const budget = new InferenceBudgetTracker(db.raw, { ...DEFAULT_MODEL_STRATEGY_CONFIG, perCallCeilingCents: 2 });
    const r = new InferenceRouter(db.raw, registry, budget);
    const bigTools = [{ type: "function", function: { name: "x", description: "y".repeat(400_000), parameters: {} } }];
    const result = await r.route({ ...request(), tools: bigTools }, async () => ({
      message: { content: "ok" }, usage: { promptTokens: 0, completionTokens: 0 }, finishReason: "stop",
    }));
    expect(result.finishReason).toBe("stop");
    expect(result.costEstimated).toBeUndefined();
    expect(result.costCents).toBe(0);
    db.close();
  });
});

// ─── Agent loop ─────────────────────────────────────────────────

describe("Money Lab agent loop", () => {
  let db: AutomatonDatabase;
  beforeEach(() => {
    db = openDb();
  });
  afterEach(() => db.close());

  const run = (inference: MockInferenceClient, config = labConfig()) =>
    runAgentLoop({
      identity: createTestIdentity(),
      config,
      db,
      conway: new MockConwayClient(),
      inference,
      policyEngine: new PolicyEngine(db.raw, createDefaultRules()),
      spendTracker: new SpendTracker(db.raw),
    });

  it("makes no inference call while paused", async () => {
    pause(db.raw, "operator test", "operator");
    const inference = new MockInferenceClient([noToolResponse("should not run")]);
    await run(inference);
    expect(inference.calls).toHaveLength(0);
    expect(db.getAgentState()).toBe("sleeping");
  });

  it("offers every tool except replication, with bounded output tokens when set", async () => {
    const inference = new MockInferenceClient([noToolResponse("done")]);
    await run(inference, labConfig({ payments: "allowed" }));
    expect(inference.calls).toHaveLength(1);
    const offered = (inference.calls[0].options?.tools ?? []).map((t: any) => t.function.name);
    for (const name of ["request_help", "record_experiment", "create_sandbox", "register_domain", "topup_credits", "git_push"]) {
      expect(offered, name).toContain(name);
    }
    for (const name of MONEY_LAB_ALWAYS_DENIED_TOOLS) expect(offered).not.toContain(name);
    expect(inference.calls[0].options?.maxTokens).toBe(1024);
    expect(inference.calls[0].options?.model).toBe("gpt-5-mini");
  });

  it("sleeps without a paid turn when the budget is exhausted", async () => {
    new InferenceBudgetTracker(db.raw, labConfig().modelStrategy!).recordCost({
      sessionId: "x", turnId: null, model: "gpt-5-mini", provider: "openai", inputTokens: 0,
      outputTokens: 0, costCents: 30, latencyMs: 1, tier: "normal", taskType: "agent_turn", cacheHit: false,
    });
    const inference = new MockInferenceClient([noToolResponse("should not run")]);
    await run(inference);
    expect(inference.calls).toHaveLength(0);
    expect(db.getAgentState()).toBe("sleeping");
    expect(new Date(db.getKV("sleep_until")!).getTime()).toBeGreaterThan(Date.now());
    expect(formatStatus(db.raw, labConfig())).toMatch(/Sommeil jusqu'à .*plafond horaire atteint/);
  });

  it("pauses when the provider returns no usage (unknown cost)", async () => {
    const inference = new MockInferenceClient([
      { ...noToolResponse("x"), usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } },
    ]);
    await run(inference);
    expect(getPauseState(db.raw)?.reason).toMatch(/coût d'inférence inconnu/);
    expect(inference.calls).toHaveLength(1);
  });

  it("pauses instead of retrying forever when the per-call ceiling rejects the call", async () => {
    const config = labConfig({
      inference: { model: "gpt-5-mini", effort: null, perCallCents: 1, hourlyCents: 10, dailyCents: 30, maxOutputTokens: 8192 },
    });
    const inference = new MockInferenceClient([noToolResponse("should not run")]);
    await run(inference, config);
    expect(inference.calls).toHaveLength(0);
    expect(getPauseState(db.raw)?.reason).toMatch(/per_call/);
    expect(db.getKV("sleep_until")).toBeUndefined();
  });

  it("pauses without inference when the pinned model is unknown", async () => {
    const config = labConfig({
      inference: { model: "no-such-model", effort: null, perCallCents: 5, hourlyCents: 10, dailyCents: 30, maxOutputTokens: 1024 },
    });
    const inference = new MockInferenceClient([noToolResponse("should not run")]);
    await run(inference, config);
    expect(inference.calls).toHaveLength(0);
    expect(getPauseState(db.raw)?.reason).toMatch(/no-such-model/);
  });

  it("simulated first cycle: explore, keep a worklog, ask for help, sleep", async () => {
    const conway = new MockConwayClient();
    const inference = new MockInferenceClient([
      toolCallResponse([{ name: "record_experiment", arguments: {
        status: "exploring", hypothesis: "Free CSV cleanup page for small shops",
        evidence: ["https://example.org/forum-thread (2026-10-03)"], acquisition_channel: "relevant directories",
      } }]),
      toolCallResponse([{ name: "write_file", arguments: {
        path: path.join(os.homedir(), ".automaton", "WORKLOG.md"), content: "Exploring CSV cleanup",
      } }]),
      toolCallResponse([{ name: "transfer_credits", arguments: { to_address: "0xabc", amount_cents: 100 } }]),
      toolCallResponse([{ name: "request_help", arguments: {
        reason: "Need a directory listing account", human_action: "Create the listing account",
        resume_condition: "Owner confirms the account exists",
      } }]),
      toolCallResponse([{ name: "sleep", arguments: { duration_seconds: 3600, reason: "waiting for owner" } }]),
    ]);
    const turns: any[] = [];
    await runAgentLoop({
      identity: createTestIdentity(), config: labConfig(), db, conway, inference,
      policyEngine: new PolicyEngine(db.raw, createDefaultRules()), spendTracker: new SpendTracker(db.raw),
      onTurnComplete: (t) => turns.push(t),
    });

    const calls = turns.flatMap((t) => t.toolCalls);
    expect(calls.map((c: any) => c.name)).toEqual([
      "record_experiment", "write_file", "transfer_credits", "request_help", "sleep",
    ]);
    expect(calls[0].error).toBeUndefined();
    expect(calls[1].error).toBeUndefined();
    expect(conway.files[path.join(os.homedir(), ".automaton", "WORKLOG.md")]).toBe("Exploring CSV cleanup");
    expect(calls[2].error).toMatch(/Unknown tool: transfer_credits/); // hidden from the model entirely
    expect(calls[3].error).toBeUndefined();
    expect(db.getAgentState()).toBe("sleeping");
    expect(inference.calls).toHaveLength(5);
    expect(fetchSpy).not.toHaveBeenCalled();

    const status = formatStatus(db.raw, labConfig());
    expect(status).toMatch(/Free CSV cleanup page/);
    expect(status).toMatch(/Create the listing account/);
  });

  it("records experiments and help requests through agent tools", async () => {
    const inference = new MockInferenceClient([
      toolCallResponse([{ name: "record_experiment", arguments: { status: "exploring", hypothesis: "CSV cleanup for small shops" } }]),
      noToolResponse("done"),
    ]);
    await run(inference);
    const block = buildMoneyLabPromptBlock(db.raw, labConfig().moneyLab!);
    expect(block).toMatch(/CSV cleanup for small shops/);
  });
});

// ─── Journal: experiments, help, ledger, no-progress ───────────

describe("Money Lab journal", () => {
  it("allows several experiments in parallel", () => {
    const db = openDb();
    upsertExperiment(db.raw, { status: "building", hypothesis: "A" });
    const b = upsertExperiment(db.raw, { status: "exploring", hypothesis: "B" });
    expect(upsertExperiment(db.raw, { id: b.id, status: "building" }).status).toBe("building");
    db.close();
  });

  it("help requests survive restart; repeated and unrelated resolutions are harmless", () => {
    const file = dbPath();
    let db = openDb(file);
    const exp = upsertExperiment(db.raw, { status: "building", hypothesis: "H" });
    const help = createHelpRequest(db.raw, {
      experimentId: exp.id, reason: "Need an ad account", humanAction: "Create the account",
      resumeCondition: "Account verified", expectedCostCents: null,
    });
    expect(getExperiment(db.raw, exp.id)?.status).toBe("waiting_for_owner");
    db.close();

    db = openDb(file);
    expect(getHelpRequest(db.raw, help.id)?.status).toBe("open");

    expect(resolveHelpRequest(db.raw, "help_unknown", "resolved", "x").outcome).toBe("not_found");
    expect(getHelpRequest(db.raw, help.id)?.status).toBe("open");

    const wakeCount = () => (db.raw.prepare("SELECT COUNT(*) AS n FROM wake_events").get() as any).n;
    const before = wakeCount();
    expect(resolveHelpRequest(db.raw, help.id, "resolved", "done").outcome).toBe("updated");
    expect(resolveHelpRequest(db.raw, help.id, "rejected", "again").outcome).toBe("already_closed");
    expect(getHelpRequest(db.raw, help.id)?.status).toBe("resolved");
    expect(wakeCount()).toBe(before + 1);
    db.close();
  });

  it("lists closed help by resolution time and wakes only on operator events", () => {
    const db = openDb();
    const mk = () => createHelpRequest(db.raw, { experimentId: null, reason: "r", humanAction: "a", resumeCondition: "c" });
    const [oldest, a, b, c] = [mk(), mk(), mk(), mk()];
    for (const h of [a, b, c]) resolveHelpRequest(db.raw, h.id, "resolved", "x");
    db.raw.prepare("UPDATE money_lab_help_requests SET resolved_at = '2000-01-01T00:00:00.000Z'").run();
    resolveHelpRequest(db.raw, oldest.id, "resolved", "latest");
    expect(listRecentlyClosedHelp(db.raw, 3)[0].id).toBe(oldest.id);

    expect(isOperatorWake({ source: "money_lab_operator" })).toBe(true);
    expect(isOperatorWake({ source: "heartbeat" })).toBe(false);
    db.close();
  });

  it("agent tools cannot resolve help or write the ledger", () => {
    const names = createMoneyLabTools().map((t) => t.name);
    expect(names).toEqual(["record_experiment", "idea", "request_help", "message_owner", "view_page", "browse", "audit_page", "ab_test", "check_domain", "render_image", "post_social", "search_console", "delegate", "schedule_job", "recall", "set_budget_focus", "money_lab_status"]);
  });

  it("separates funding, purchases, usage, estimated revenue and cash", () => {
    const db = openDb();
    addLedgerEntry(db.raw, { kind: "owner_funding", amountCents: 2000, source: "operator", reference: "fund-1" });
    addLedgerEntry(db.raw, { kind: "credit_purchase", amountCents: 1500, source: "operator", reference: "buy-1" });
    addLedgerEntry(db.raw, { kind: "estimated_revenue", amountCents: 300, source: "provider_import", reference: "ads-est-1" });
    addLedgerEntry(db.raw, { kind: "confirmed_revenue", amountCents: 100, source: "provider_import", reference: "sale-1" });
    expect(addLedgerEntry(db.raw, { kind: "confirmed_revenue", amountCents: 100, source: "provider_import", reference: "sale-1" })).toBe(false);
    new InferenceBudgetTracker(db.raw, labConfig().modelStrategy!).recordCost({
      sessionId: "x", turnId: null, model: "gpt-5-mini", provider: "openai", inputTokens: 0,
      outputTokens: 0, costCents: 40, latencyMs: 1, tier: "normal", taskType: "agent_turn", cacheHit: false,
    });

    const f = summarizeFinances(db.raw);
    expect(f.confirmedRevenueCents).toBe(100);
    expect(f.cashReceivedCents).toBe(0);
    expect(f.estimatedRevenueCents).toBe(300);
    expect(f.inferenceConsumedCents).toBe(40);
    // Funding and the credit purchase are neither revenue nor expense.
    expect(f.profitCents).toBe(100 - 40);

    addLedgerEntry(db.raw, { kind: "hosting", amountCents: null, source: "operator", reference: "host-oct" });
    expect(summarizeFinances(db.raw).unknownAmountEntries).toBe(1);
    db.close();
  });

  it("sleeps after repeated no-progress cycles and keeps experiment context", () => {
    const db = openDb();
    const lab = labConfig().moneyLab!;
    const exp = upsertExperiment(db.raw, { status: "observing", hypothesis: "Kept context" });
    const t0 = Date.parse("2026-10-03T00:00:00Z");

    for (let i = 1; i <= 2; i++) {
      const outcome = afterWakeCycle(db.raw, lab, journalFingerprint(db.raw), t0);
      expect(outcome.longSleepUntil).toBeNull();
      expect(outcome.noProgressCycles).toBe(i);
    }
    const third = afterWakeCycle(db.raw, lab, journalFingerprint(db.raw), t0);
    expect(third.longSleepUntil).toBe(new Date(t0 + 360 * 60_000).toISOString());

    expect(db.getKV("sleep_reason")).toMatch(/sans progrès/);

    const beforeHelp = journalFingerprint(db.raw);
    const help = createHelpRequest(db.raw, { experimentId: null, reason: "r", humanAction: "a", resumeCondition: "c" });
    expect(journalFingerprint(db.raw)).toBe(beforeHelp);
    resolveHelpRequest(db.raw, help.id, "resolved", "ok");
    expect(journalFingerprint(db.raw)).not.toBe(beforeHelp);

    const before = journalFingerprint(db.raw);
    upsertExperiment(db.raw, { id: exp.id, status: "observing", metrics: { visits: 3 } });
    expect(afterWakeCycle(db.raw, lab, before, t0).progressed).toBe(true);
    expect(getNoProgressCycles(db.raw)).toBe(0);
    expect(buildMoneyLabPromptBlock(db.raw, lab)).toMatch(/Kept context/);
    db.close();
  });
});

// ─── Operator CLI ───────────────────────────────────────────────

describe("Money Lab operator CLI", () => {
  it("pauses, reports billing separately, and resumes", () => {
    const db = openDb();
    const config = labConfig();
    const out: string[] = [];
    const write = (t: string) => out.push(t);

    expect(runMoneyLabCommand(["pause", "fin", "du", "test"], db.raw, config, write)).toBe(0);
    expect(getPauseState(db.raw)?.by).toBe("operator");
    expect(out.join("\n")).toMatch(/n'arrête PAS la facturation/);

    out.length = 0;
    runMoneyLabCommand(["status"], db.raw, config, write);
    expect(out.join("\n")).toMatch(/Pause : OUI/);
    expect(out.join("\n")).toMatch(/facturées MÊME EN PAUSE/);

    runMoneyLabCommand(["resume"], db.raw, config, write);
    expect(getPauseState(db.raw)).toBeNull();
    expect(resume(db.raw)).toBe(false);
    db.close();
  });

  it("rejects malformed ledger input", () => {
    const db = openDb();
    const out: string[] = [];
    expect(runMoneyLabCommand(["ledger-add", "revenue", "10", "r1"], db.raw, labConfig(), (t) => out.push(t))).toBe(2);
    expect(runMoneyLabCommand(["ledger-add", "cash_received", "1.5", "r1"], db.raw, labConfig(), (t) => out.push(t))).toBe(2);
    expect(runMoneyLabCommand(["ledger-add", "cash_received", "150", "r1"], db.raw, labConfig(), (t) => out.push(t))).toBe(0);
    db.close();
  });
});
