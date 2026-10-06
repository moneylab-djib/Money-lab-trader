/**
 * Money Lab budget allocation
 *
 * The agent splits its spending between purposes (research, build,
 * marketing, learning, operations) with a percentage plan, declares what it
 * is currently working on, and the runtime attributes every paid turn to that
 * focus. Plan and actual spend per week are shown in the prompt and status,
 * and revisited at the weekly review.
 */

import type Database from "better-sqlite3";
import { getKV, setKV } from "./journal.js";

export const BUDGET_CATEGORIES = ["research", "build", "marketing", "learning", "operations"] as const;
export type BudgetCategory = (typeof BUDGET_CATEGORIES)[number];
export type BudgetPlan = Partial<Record<BudgetCategory, number>>;

const PLAN_KEY = "money_lab.budget_plan";
const FOCUS_KEY = "money_lab.focus";
const SPEND_PREFIX = "money_lab.spend.";

export function isBudgetCategory(value: unknown): value is BudgetCategory {
  return typeof value === "string" && (BUDGET_CATEGORIES as readonly string[]).includes(value);
}

/** Monday (UTC) of the week containing `now`, as YYYY-MM-DD. */
export function weekKey(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

export function getBudgetPlan(db: Database.Database): BudgetPlan | null {
  const raw = getKV(db, PLAN_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BudgetPlan;
  } catch {
    return null;
  }
}

/** Validates percentages (integers 0-100, total at most 100) and stores the plan. */
export function setBudgetPlan(db: Database.Database, plan: Record<string, unknown>): string | null {
  const clean: BudgetPlan = {};
  let total = 0;
  for (const [key, value] of Object.entries(plan)) {
    if (!isBudgetCategory(key)) return `Unknown category "${key}". Use: ${BUDGET_CATEGORIES.join(", ")}.`;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) {
      return `"${key}" must be an integer percentage between 0 and 100.`;
    }
    clean[key] = value;
    total += value;
  }
  if (total > 100) return `The plan totals ${total}%: it must not exceed 100%.`;
  setKV(db, PLAN_KEY, JSON.stringify(clean));
  return null;
}

export function getFocus(db: Database.Database): BudgetCategory | "unassigned" {
  const focus = getKV(db, FOCUS_KEY);
  return isBudgetCategory(focus) ? focus : "unassigned";
}

export function setFocus(db: Database.Database, focus: BudgetCategory): void {
  setKV(db, FOCUS_KEY, focus);
}

export function weeklySpend(db: Database.Database, now = new Date()): Record<string, number> {
  const raw = getKV(db, `${SPEND_PREFIX}${weekKey(now)}`);
  try {
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/** Attributes a paid turn to the current focus. */
export function recordFocusSpend(db: Database.Database, cents: number, now = new Date()): void {
  if (!(cents > 0)) return;
  const spend = weeklySpend(db, now);
  const focus = getFocus(db);
  spend[focus] = (spend[focus] ?? 0) + cents;
  setKV(db, `${SPEND_PREFIX}${weekKey(now)}`, JSON.stringify(spend));
}

/** One-line summary of plan, focus and this week's spend per category. */
export function allocationSummary(db: Database.Database, now = new Date()): string {
  const plan = getBudgetPlan(db);
  const spend = weeklySpend(db, now);
  const total = Object.values(spend).reduce((a, b) => a + b, 0);
  const planText = plan
    ? BUDGET_CATEGORIES.filter((c) => plan[c] !== undefined).map((c) => `${c} ${plan[c]}%`).join(", ")
    : "none";
  const spendText = total > 0
    ? Object.entries(spend).map(([c, v]) => `${c} $${(v / 100).toFixed(2)} (${Math.round((v / total) * 100)}%)`).join(", ")
    : "nothing yet";
  return `plan: ${planText}; current focus: ${getFocus(db)}; spent this week: ${spendText}`;
}
