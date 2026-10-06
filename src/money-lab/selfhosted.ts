/**
 * Self-hosted runtime (no Conway Cloud).
 *
 * Conway Cloud stopped accepting accounts, so Money Lab can run on an
 * ordinary server (VPS): commands and files are local, inference goes to
 * Anthropic directly, and the "credits" the survival logic reads are the
 * bot's own balance computed from the journal:
 *
 *   owner funding + confirmed revenue (net) - refunds - fees
 *   - consumed costs (inference, hosting, external services)
 *   - agent payments - accrued hosting of declared resources
 *
 * Revenue only counts once confirmed (Stripe sync or the owner), so the
 * bot cannot survive on claims. A negative balance is the "dead" tier.
 */

import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import type Database from "better-sqlite3";
import type { ConwayClient, ExecResult, ModelEntry } from "../types.js";
import type { MoneyLabConfig } from "./profile.js";
import { getKV, setKV, summarizeFinances } from "./journal.js";

const KV_STARTED = "money_lab.started_at";

/** Record when the run started (once); used to accrue hosting costs. */
export function markRunStarted(db: Database.Database, now: Date = new Date()): string {
  const existing = getKV(db, KV_STARTED);
  if (existing) return existing;
  const at = now.toISOString();
  setKV(db, KV_STARTED, at);
  return at;
}

/** Hosting accrued since the run started from declared daily costs (unknown = not counted). */
export function accruedHostingCents(db: Database.Database, lab: MoneyLabConfig, now: Date = new Date()): number {
  const started = getKV(db, KV_STARTED);
  if (!started) return 0;
  const days = Math.max(0, (now.getTime() - Date.parse(started)) / 86_400_000);
  const perDay = lab.resources.reduce((sum, r) => sum + (r.expectedDailyCostCents ?? 0), 0);
  return Math.ceil(perDay * days);
}

/** All agent payments ever recorded (spend_tracking, excluding inference). */
function agentPaymentsCents(db: Database.Database): number {
  const row = db.prepare(
    "SELECT COALESCE(SUM(amount_cents), 0) AS total FROM spend_tracking WHERE category != 'inference'",
  ).get() as { total: number };
  return row.total;
}

export interface SurvivalBalance {
  balanceCents: number;
  fundingCents: number;
  confirmedRevenueCents: number;
  spentCents: number;
  /** Average spend per day over the last 7 days (inference + payments). */
  burnPerDayCents: number;
  /** Days left at the current burn rate; null when nothing is being spent. */
  daysLeft: number | null;
}

export function survivalBalance(db: Database.Database, lab: MoneyLabConfig, now: Date = new Date()): SurvivalBalance {
  const f = summarizeFinances(db);
  const hosting = accruedHostingCents(db, lab, now);
  const payments = agentPaymentsCents(db);
  const spent = f.inferenceConsumedCents + f.hostingCents + f.externalServicesCents + f.feesCents
    + f.refundsCents + payments + hosting;
  const balance = f.ownerFundingCents + f.confirmedRevenueCents - spent;

  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString().replace("T", " ").slice(0, 19);
  const recentInference = (db.prepare(
    "SELECT COALESCE(SUM(cost_cents), 0) AS total FROM inference_costs WHERE created_at >= ?",
  ).get(since) as { total: number }).total;
  const recentPayments = (db.prepare(
    "SELECT COALESCE(SUM(amount_cents), 0) AS total FROM spend_tracking WHERE category != 'inference' AND created_at >= ?",
  ).get(since) as { total: number }).total;
  const started = getKV(db, KV_STARTED);
  const window = started ? Math.min(7, Math.max(1 / 24, (now.getTime() - Date.parse(started)) / 86_400_000)) : 7;
  const hostingPerDay = lab.resources.reduce((sum, r) => sum + (r.expectedDailyCostCents ?? 0), 0);
  // The first days may predate the daily cap; spending above it cannot
  // happen again, so it does not count toward the future burn rate.
  const inferencePerDay = Math.min(recentInference / window, lab.inference.dailyCents ?? Infinity);
  const burn = Math.ceil(inferencePerDay + recentPayments / window + hostingPerDay);

  return {
    balanceCents: balance,
    fundingCents: f.ownerFundingCents,
    confirmedRevenueCents: f.confirmedRevenueCents,
    spentCents: spent,
    burnPerDayCents: burn,
    daysLeft: burn > 0 ? Math.max(0, balance) / burn : null,
  };
}

/** Conway-only operations are unavailable on a self-hosted server. */
export const SELF_HOSTED_UNAVAILABLE_TOOLS: ReadonlySet<string> = new Set([
  "topup_credits",
  "transfer_credits",
  "create_sandbox",
  "delete_sandbox",
  "list_sandboxes",
  "search_domains",
  "register_domain",
  "manage_dns",
  "check_credits",
  // No proxy on a VPS: these only returned a misleading localhost URL.
  "expose_port",
  "remove_port",
]);

function unavailable(name: string): never {
  throw new Error(`${name} is not available on the self-hosted runtime (no Conway Cloud)`);
}

/**
 * Wrap a local-mode Conway client (empty sandbox id): exec/files/ports run
 * on this server, the balance comes from the journal, Conway calls fail.
 */
export function createSelfHostedClient(
  local: ConwayClient,
  balanceCents: () => number,
  options: { exec?: (command: string, timeout?: number) => Promise<ExecResult> } = {},
): ConwayClient {
  const client: ConwayClient = {
    exec: options.exec ?? ((command, timeout) => local.exec(command, timeout)),
    writeFile: (p, content) => local.writeFile(p, content),
    readFile: (p) => local.readFile(p),
    exposePort: async () => unavailable("exposePort"),
    removePort: async () => unavailable("removePort"),
    // Upstream uses -1 as the "balance API unreachable" sentinel; a real
    // balance of exactly -1 cent is reported as -2 so it still reads as dead.
    getCreditsBalance: async () => {
      const balance = balanceCents();
      return balance === -1 ? -2 : balance;
    },
    getCreditsPricing: async () => [],
    listModels: async () => [],
    createSandbox: async () => unavailable("createSandbox"),
    deleteSandbox: async () => unavailable("deleteSandbox"),
    listSandboxes: async () => unavailable("listSandboxes"),
    transferCredits: async () => unavailable("transferCredits"),
    registerAutomaton: async () => unavailable("registerAutomaton"),
    searchDomains: async () => unavailable("searchDomains"),
    registerDomain: async () => unavailable("registerDomain"),
    listDnsRecords: async () => unavailable("listDnsRecords"),
    addDnsRecord: async () => unavailable("addDnsRecord"),
    deleteDnsRecord: async () => unavailable("deleteDnsRecord"),
    createScopedClient: () => unavailable("createScopedClient"),
  };
  return client;
}

/**
 * Claude models for the registry. costPer1k* is in hundredths of a cent
 * per 1 000 tokens: $2/M = 0.2 c/1k = 20. Prices: Anthropic first-party
 * API, list cached 2026-09-25 (re-check before launch).
 */
export const ANTHROPIC_MODELS = [
  { modelId: "claude-sonnet-5-5", displayName: "Claude Sonnet 5.5", costPer1kInput: 20, costPer1kOutput: 100 },
  { modelId: "claude-opus-5-5", displayName: "Claude Opus 5.5", costPer1kInput: 40, costPer1kOutput: 200 },
  { modelId: "claude-haiku-4-5", displayName: "Claude Haiku 4.5", costPer1kInput: 10, costPer1kOutput: 50 },
] as const;

/** Register the Claude models (provider "anthropic") in the model registry. */
export function seedAnthropicModels(registry: { upsert(entry: ModelEntry): void }): void {
  const now = new Date().toISOString();
  for (const m of ANTHROPIC_MODELS) {
    registry.upsert({
      modelId: m.modelId,
      provider: "anthropic",
      displayName: m.displayName,
      tierMinimum: "critical",
      costPer1kInput: m.costPer1kInput,
      costPer1kOutput: m.costPer1kOutput,
      maxTokens: 64_000,
      contextWindow: m.modelId === "claude-haiku-4-5" ? 200_000 : 1_000_000,
      supportsTools: true,
      supportsVision: true,
      parameterStyle: "max_tokens",
      enabled: true,
      lastSeen: now,
      createdAt: now,
      updatedAt: now,
    });
  }
}

/** Environment variables a child shell must never inherit. */
export const SECRET_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "CONWAY_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "STRIPE_API_KEY",
  "BLUESKY_APP_PASSWORD",
] as const;

/**
 * True when other processes of the same user cannot read this process's
 * environment: the kernel makes /proc/<pid> root-owned for a process that is
 * not dumpable (one that switched users, see src/launch.ts).
 */
export function environmentProtected(): boolean {
  try {
    return fs.statSync("/proc/self/environ").uid !== process.getuid?.();
  } catch {
    return true;
  }
}

/** Secret variable names: the fixed list plus the owner's configured key variables. */
const secretNames = new Set<string>(SECRET_ENV_VARS);
/** Secrets moved out of process.env by sealSecrets(). */
const sealed = new Map<string, string>();

/** Treat more variables as secrets (the owner may name the Telegram or Stripe variable). */
export function registerSecretEnvNames(names: Array<string | null | undefined>): void {
  for (const name of names) if (name) secretNames.add(name);
}

/**
 * Move the secrets out of process.env. Every process the runtime starts
 * afterwards (git, curl, which, browsers, the agent's shell) inherits none
 * of them, even for the instant it runs; the runtime reads them back with
 * withSecrets().
 */
export function sealSecrets(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of secretNames) {
    const value = env[name];
    if (value === undefined) continue;
    sealed.set(name, value);
    delete env[name];
  }
}

/** The environment with the sealed secrets, for the runtime's own reads. */
export function withSecrets(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(sealed), ...env };
}

/** Copy of the environment without secrets, for the agent's shell. */
export function scrubbedEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...env };
  for (const key of secretNames) delete copy[key];
  return copy;
}


const MAX_OUTPUT = 1024 * 1024;

/**
 * Run a shell command without blocking the process (upstream local mode uses
 * execSync, which froze Telegram, the heartbeat and /pause for as long as a
 * command ran). The call returns when the shell exits: background jobs that
 * keep its output open (a server started with "&") no longer hold it until
 * the timeout; their later output is read and discarded so they never get
 * SIGPIPE. On timeout the whole process group is killed.
 */
/** Longest a single command may run (a forgotten "sleep 1d" must not hold the bot). */
export const MAX_COMMAND_MS = 30 * 60_000;

export function runLocalCommand(
  command: string,
  requestedTimeout: unknown = 30_000,
  env: NodeJS.ProcessEnv = scrubbedEnv(),
): Promise<ExecResult> {
  // The model may send the timeout as text or a huge number.
  const requested = Number(requestedTimeout);
  const timeoutMs = Number.isFinite(requested) && requested > 0 ? Math.min(Math.max(requested, 1_000), MAX_COMMAND_MS) : 30_000;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const child = spawn("/bin/sh", ["-c", command], {
      cwd: env.HOME || "/root",
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (d) => { if (!settled && stdout.length < MAX_OUTPUT) stdout += d; });
    child.stderr.on("data", (d) => { if (!settled && stderr.length < MAX_OUTPUT) stderr += d; });

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      child.unref();
      resolve({
        stdout: stdout.slice(0, MAX_OUTPUT),
        stderr: (timedOut ? `${stderr}\n[timeout after ${timeoutMs} ms: command killed]` : stderr).slice(0, MAX_OUTPUT),
        exitCode,
      });
    };
    let grace: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ }
      grace = setTimeout(() => finish(124), 1_000);
    }, timeoutMs);

    child.on("error", (err) => {
      stderr += err.message;
      finish(127);
    });
    child.on("exit", (code) => {
      const exitCode = timedOut ? 124 : (code ?? 1);
      // Output written just before exit may still be in the pipe: wait for
      // "close", but not for background jobs that keep the pipe open.
      child.on("close", () => finish(exitCode));
      grace = setTimeout(() => finish(exitCode), 300);
    });
  });
}

/** Script the agent may write to restart its services after a runtime restart. */
export const AUTOSTART_SCRIPT = "autostart.sh";

/** Run ~/autostart.sh in the background when it exists (servers die with the runtime). */
export async function runAutostart(env: NodeJS.ProcessEnv = scrubbedEnv()): Promise<ExecResult | null> {
  const home = env.HOME || "/root";
  const script = path.join(home, AUTOSTART_SCRIPT);
  if (!fs.existsSync(script)) return null;
  return runLocalCommand(`sh ${JSON.stringify(script)} >> ${JSON.stringify(path.join(home, "autostart.log"))} 2>&1`, 120_000, env);
}

// ─── Capabilities the owner can grant on the server ─────────────

/**
 * Credentials the agent may use itself (unlike SECRET_ENV_VARS). Each is
 * scoped by the owner: a GitHub token limited to the bot's own organization,
 * a read-only analytics token.
 */
export const BOT_CREDENTIAL_VARS = ["GH_TOKEN", "GOATCOUNTER_TOKEN"] as const;

const BROWSER_NAMES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];

/** Headless browser for screenshots: MONEY_LAB_BROWSER, else the first one on PATH. */
export function findBrowser(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.MONEY_LAB_BROWSER && fs.existsSync(env.MONEY_LAB_BROWSER)) return env.MONEY_LAB_BROWSER;
  for (const dir of (env.PATH || "").split(":").filter(Boolean)) {
    for (const name of BROWSER_NAMES) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export interface SelfHostedCapabilities {
  githubOrg: string | null;
  analyticsSite: string | null;
  browser: string | null;
}

export function selfHostedCapabilities(env: NodeJS.ProcessEnv = process.env): SelfHostedCapabilities {
  return {
    githubOrg: env.GH_TOKEN && env.GITHUB_ORG ? env.GITHUB_ORG : null,
    analyticsSite: env.GOATCOUNTER_TOKEN && env.GOATCOUNTER_SITE ? env.GOATCOUNTER_SITE : null,
    browser: findBrowser(env),
  };
}

/** Single-quote a value for /bin/sh. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
