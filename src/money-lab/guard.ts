/**
 * Money Lab guards
 *
 * The agent is free to use every tool except replication. The rule here
 * only enforces what makes that ban hold and keeps the experiment
 * measurable:
 * - deny replication/orchestration and runtime-code self-modification
 *   tools, plus any tool the owner lists in deniedTools;
 * - deny every tool while the owner has paused the run;
 * - protect the runtime configuration, wallet, state database,
 *   constitution and installed runtime code (editing them could remove
 *   the ban or corrupt the accounting) and the Conway API key.
 * An optional process-wide x402 payment gate applies when the owner sets
 * payments to "disabled".
 *
 * These checks are in-process. The shell tool runs arbitrary commands,
 * so path checks are a heuristic that catches direct edits, not a
 * sandbox boundary.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import type { PolicyRule, PolicyRequest, PolicyRuleResult } from "../types.js";
import { setX402PaymentGuard } from "../conway/x402.js";
import { moneyLabDeniedTools, MONEY_LAB_ALWAYS_DENIED_TOOLS, MONEY_LAB_PAYMENT_TOOLS } from "./profile.js";
import { getPauseState } from "./journal.js";

export const PAYMENTS_DISABLED_REASON =
  "credit purchases and x402 payments are disabled by the owner (moneyLab.payments = \"disabled\")";

/** Install the process-wide payment gate (only when payments are disabled). */
export function installMoneyLabPaymentGuard(): void {
  setX402PaymentGuard(() => PAYMENTS_DISABLED_REASON);
}

/**
 * Protected entries of ~/.automaton. Everything else there (WORKLOG.md,
 * notes, workspace/, skills/, heartbeat.yml) is the agent's to use.
 */
const PROTECTED_RUNTIME_ENTRIES = [
  "automaton.json",
  "wallet.json",
  "config.json",
  "state.db",
  "constitution.md",
  "backups",
  "gsc-key.json",
];

/** Root of the installed runtime code (src/ or dist/ parent). */
export const RUNTIME_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const PROTECTED_SHELL_PATTERNS: RegExp[] = [
  /\bautomaton\.json\b/,
  /\bwallet\.json\b/,
  /\bstate\.db\b/,
  /\bgsc-key\.json\b/,
  /\.automaton\/(config\.json|constitution\.md)/,
  /\b(CONWAY_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|TELEGRAM_BOT_TOKEN|STRIPE_API_KEY|BLUESKY_APP_PASSWORD)\b/,
  // The parent process environment holds the secrets the shell does not get.
  /\/proc\/[^\s]*\/environ\b/,
];

function runtimeDir(): string {
  return path.join(process.env.HOME || os.homedir(), ".automaton");
}

function expand(filePath: string): string {
  const expanded = filePath.startsWith("~")
    ? path.join(process.env.HOME || os.homedir(), filePath.slice(1))
    : filePath;
  return path.resolve(expanded);
}

/** True for protected runtime entries, anything inside them, or the runtime code. */
export function isRuntimePath(filePath: string): boolean {
  const resolved = expand(filePath);
  if (resolved === RUNTIME_ROOT || resolved.startsWith(RUNTIME_ROOT + path.sep)) return true;
  const dir = runtimeDir();
  if (!resolved.startsWith(dir + path.sep)) return false;
  const first = resolved.slice(dir.length + 1).split(path.sep)[0];
  return PROTECTED_RUNTIME_ENTRIES.some((entry) => first === entry || first.startsWith(`${entry}-`));
}

/** Harmless system files under /proc the agent may read (load, memory, CPU). */
const READABLE_PROC_FILES = new Set(["/proc/meminfo", "/proc/cpuinfo", "/proc/loadavg", "/proc/uptime", "/proc/version"]);
/** Runtime entries the agent may read; the others hold keys, the wallet or the accounting. */
const READABLE_RUNTIME_ENTRIES = new Set(["constitution.md"]);

/**
 * Why read_file must not read a path, or null. read_file runs inside the
 * runtime process, so /proc/self/environ would return every API key the
 * runtime holds. Symbolic links are resolved first.
 */
export function readBlockReason(filePath: string): string | null {
  let resolved = expand(filePath);
  try {
    resolved = fs.realpathSync(resolved);
  } catch {
    // missing file: check the path as given
  }
  if ((resolved === "/proc" || resolved.startsWith("/proc/")) && !READABLE_PROC_FILES.has(resolved)) {
    return "process information under /proc is not readable (it holds the runtime's keys)";
  }
  if (resolved.startsWith("/etc/money-lab")) return "the service environment file holds the owner's keys";
  const dir = runtimeDir();
  if (resolved.startsWith(dir + path.sep) && isRuntimePath(resolved)) {
    const first = resolved.slice(dir.length + 1).split(path.sep)[0];
    if (!READABLE_RUNTIME_ENTRIES.has(first)) return "runtime keys, wallet, configuration and state are not readable";
  }
  return null;
}

/**
 * Amount (USD cents) a payment tool call may move. x402 amounts are only
 * known after the 402 response, so the per-payment cap is the bound.
 */
export function paymentAmountCents(
  name: string,
  args: Record<string, unknown>,
  x402MaxCents: number,
): number | null {
  if (name === "topup_credits") return Math.round(Number(args.amount_usd) * 100);
  if (name === "transfer_credits") return Number(args.amount_cents);
  if (name === "x402_fetch") return x402MaxCents;
  return null;
}

/** Agent payments recorded today (UTC) in spend_tracking, excluding inference. */
export function paymentsSpentTodayCents(db: Parameters<typeof getPauseState>[0]): number {
  const day = new Date().toISOString().slice(0, 10);
  const row = db.prepare(
    "SELECT COALESCE(SUM(amount_cents), 0) AS total FROM spend_tracking WHERE window_day = ? AND category != 'inference'",
  ).get(day) as { total: number };
  return row.total;
}

function deny(reasonCode: string, humanMessage: string): PolicyRuleResult {
  return { rule: "money_lab.first_run", action: "deny", reasonCode, humanMessage };
}

export function createMoneyLabRules(): PolicyRule[] {
  return [
    {
      id: "money_lab.first_run",
      description: "Money Lab: no replication, owner pause, runtime and key protection",
      priority: 1,
      appliesTo: { by: "all" },
      evaluate(request: PolicyRequest): PolicyRuleResult | null {
        const lab = request.context.config.moneyLab;
        if (!lab?.enabled) return null;
        const name = request.tool.name;

        const paused = getPauseState(request.context.db.raw);
        if (paused) {
          return deny("MONEY_LAB_PAUSED", `Money Lab is paused (${paused.reason}); no tool may run`);
        }

        if (moneyLabDeniedTools(lab).has(name)) {
          return deny(
            "MONEY_LAB_TOOL_DISABLED",
            MONEY_LAB_ALWAYS_DENIED_TOOLS.has(name)
              ? `${name} is disabled: replication (and changes that could re-enable it) is not allowed.`
              : `${name} is disabled by the owner. Use request_help if the experiment needs it.`,
          );
        }

        if (MONEY_LAB_PAYMENT_TOOLS.has(name)) {
          const x402Max = request.context.config.treasuryPolicy?.maxX402PaymentCents ?? 100;
          const amount = paymentAmountCents(name, request.args, x402Max);
          const { perPaymentCents, dailyCents } = lab.paymentLimits;
          if (amount === null || !Number.isFinite(amount) || amount <= 0) {
            return deny("MONEY_LAB_PAYMENT_AMOUNT", "Payment amount is missing or invalid");
          }
          if (perPaymentCents !== null && amount > perPaymentCents) {
            return deny(
              "MONEY_LAB_PAYMENT_CAP",
              `Payment of ${amount}c exceeds the owner's per-payment cap of ${perPaymentCents}c`,
            );
          }
          if (dailyCents !== null) {
            const spent = paymentsSpentTodayCents(request.context.db.raw);
            if (spent + amount > dailyCents) {
              return deny(
                "MONEY_LAB_PAYMENT_DAILY_CAP",
                `Payments today ${spent}c + ${amount}c would exceed the owner's daily cap of ${dailyCents}c`,
              );
            }
          }
        }

        if (name === "read_file") {
          const reason = readBlockReason(String(request.args.path ?? ""));
          if (reason) return deny("MONEY_LAB_PROTECTED_READ", `Reading this file is disabled: ${reason}`);
        }

        if (name === "write_file" && isRuntimePath(String(request.args.path ?? ""))) {
          return deny("MONEY_LAB_RUNTIME_PATH", "Writing runtime configuration, wallet, state or runtime code is disabled");
        }

        if (name === "exec" || name === "schedule_job") {
          const command = String(request.args.command ?? "");
          if (command.includes(RUNTIME_ROOT) || PROTECTED_SHELL_PATTERNS.some((p) => p.test(command))) {
            return deny(
              "MONEY_LAB_PROTECTED_COMMAND",
              "Shell commands touching runtime configuration, wallet, state, runtime code or the API key are disabled",
            );
          }
        }

        return null;
      },
    },
  ];
}

/**
 * Reason the next paid inference call must not run, or null.
 * Checked by the agent loop before every routed inference call.
 */
export function paidCallBlockReason(db: Parameters<typeof getPauseState>[0]): string | null {
  const paused = getPauseState(db);
  return paused ? `paused: ${paused.reason}` : null;
}
