/**
 * Money Lab A/B tests
 *
 * The agent shows two versions of a page element at random (per page view,
 * nothing stored in the visitor's browser), counts views and goal actions
 * per version as GoatCounter events, and records the counts here. The
 * verdict uses a two-proportion z-test so that the agent does not declare a
 * winner on noise.
 */

import type Database from "better-sqlite3";
import { getKV, setKV } from "./journal.js";

const TESTS_KEY = "money_lab.ab_tests";
const NAME = /^[a-z0-9][a-z0-9-]{0,29}$/;
export const MIN_VIEWS_PER_VARIANT = 100;
const MAX_VIEWS_PER_VARIANT = 5000;
const SIGNIFICANCE = 0.05;

export interface VariantCounts {
  views: number;
  goals: number;
}

export interface AbTest {
  name: string;
  page: string;
  hypothesis: string;
  goal: string;
  status: "running" | "finished";
  startedAt: string;
  a?: VariantCounts;
  b?: VariantCounts;
  verdict?: string;
  updatedAt?: string;
  winner?: string;
  note?: string;
}

export function listAbTests(db: Database.Database): AbTest[] {
  try {
    const tests = JSON.parse(getKV(db, TESTS_KEY) ?? "[]");
    return Array.isArray(tests) ? (tests as AbTest[]) : [];
  } catch {
    return [];
  }
}

function save(db: Database.Database, tests: AbTest[]): void {
  setKV(db, TESTS_KEY, JSON.stringify(tests));
}

/** Standard normal cumulative distribution (Abramowitz-Stegun 7.1.26). */
function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

export interface Verdict {
  rateA: number;
  rateB: number;
  pValue: number | null;
  decision: "too_early" | "a_wins" | "b_wins" | "keep_running" | "no_difference";
  text: string;
}

export function abVerdict(a: VariantCounts, b: VariantCounts): Verdict {
  const rateA = a.views > 0 ? a.goals / a.views : 0;
  const rateB = b.views > 0 ? b.goals / b.views : 0;
  const pct = (r: number) => `${(r * 100).toFixed(1)}%`;
  const rates = `A ${a.goals}/${a.views} (${pct(rateA)}), B ${b.goals}/${b.views} (${pct(rateB)})`;
  if (a.views < MIN_VIEWS_PER_VARIANT || b.views < MIN_VIEWS_PER_VARIANT) {
    return { rateA, rateB, pValue: null, decision: "too_early",
      text: `${rates}. Too early: wait for at least ${MIN_VIEWS_PER_VARIANT} views per variant.` };
  }
  const pooled = (a.goals + b.goals) / (a.views + b.views);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / a.views + 1 / b.views));
  const z = se > 0 ? (rateB - rateA) / se : 0;
  const pValue = 2 * (1 - normalCdf(Math.abs(z)));
  const p = `p = ${pValue.toFixed(3)}`;
  if (pValue < SIGNIFICANCE) {
    const winner = rateB > rateA ? "B" : "A";
    const lift = Math.min(rateA, rateB) > 0 ? ` (${Math.round((Math.max(rateA, rateB) / Math.min(rateA, rateB) - 1) * 100)}% better)` : "";
    return { rateA, rateB, pValue, decision: winner === "B" ? "b_wins" : "a_wins",
      text: `${rates}, ${p}. ${winner} wins${lift}: keep ${winner} and stop the test.` };
  }
  if (a.views >= MAX_VIEWS_PER_VARIANT && b.views >= MAX_VIEWS_PER_VARIANT) {
    return { rateA, rateB, pValue, decision: "no_difference",
      text: `${rates}, ${p}. No meaningful difference after ${MAX_VIEWS_PER_VARIANT} views each: keep the simpler variant and test something bolder.` };
  }
  return { rateA, rateB, pValue, decision: "keep_running",
    text: `${rates}, ${p}. Not significant yet: keep running, do not change the page meanwhile.` };
}

export function startAbTest(
  db: Database.Database,
  input: Record<string, unknown>,
  now = new Date(),
): AbTest | string {
  const name = String(input.name ?? "");
  if (!NAME.test(name)) return "name must be 1-30 lowercase letters, digits or dashes (e.g. cta-title).";
  const tests = listAbTests(db);
  if (tests.some((t) => t.name === name)) return `A test named "${name}" already exists.`;
  if (tests.filter((t) => t.status === "running").length >= 5) return "At most 5 running tests; finish one first.";
  const test: AbTest = {
    name,
    page: String(input.page ?? ""),
    hypothesis: String(input.hypothesis ?? ""),
    goal: String(input.goal ?? ""),
    status: "running",
    startedAt: now.toISOString(),
  };
  save(db, [...tests, test]);
  return test;
}

/** Client-side code the agent adds to the page (cookieless, per page view). */
export function abSnippet(name: string): string {
  return `<script>
  // A/B test "${name}": one variant per page view, nothing stored in the browser.
  var abv = Math.random() < 0.5 ? "a" : "b";
  document.documentElement.setAttribute("data-ab-${name}", abv);
  // CSS: html[data-ab-${name}="a"] .ab-${name}-b, html[data-ab-${name}="b"] .ab-${name}-a { display: none; }
  function abCount(kind) {
    if (window.goatcounter && window.goatcounter.count) {
      window.goatcounter.count({ path: "ab-${name}-" + abv + "-" + kind, title: "A/B ${name}", event: true });
    }
  }
  window.addEventListener("load", function () { abCount("view"); });
  // On the goal action, e.g. button.addEventListener("click", function () { abCount("goal"); });
</script>`;
}

export function recordAbCounts(
  db: Database.Database,
  name: string,
  a: VariantCounts,
  b: VariantCounts,
  now = new Date(),
): string {
  const tests = listAbTests(db);
  const test = tests.find((t) => t.name === name);
  if (!test) return `No test named "${name}".`;
  for (const v of [a, b]) {
    if (!Number.isInteger(v.views) || !Number.isInteger(v.goals) || v.views < 0 || v.goals < 0 || v.goals > v.views) {
      return "Counts must be integers with 0 <= goals <= views.";
    }
  }
  const verdict = abVerdict(a, b);
  Object.assign(test, { a, b, verdict: verdict.text, updatedAt: now.toISOString() });
  save(db, tests);
  return `Test "${name}": ${verdict.text}`;
}

export function finishAbTest(db: Database.Database, name: string, winner: string, note: string): string {
  const tests = listAbTests(db);
  const test = tests.find((t) => t.name === name);
  if (!test) return `No test named "${name}".`;
  Object.assign(test, { status: "finished", winner, note });
  save(db, tests);
  return `Test "${name}" finished (kept ${winner}). Remove the test code from the page and record the result with record_experiment.`;
}

export function describeAbTests(db: Database.Database): string {
  const tests = listAbTests(db);
  if (tests.length === 0) return "No A/B tests yet.";
  return tests.map((t) =>
    `${t.name} [${t.status}] on ${t.page}: ${t.hypothesis}; goal: ${t.goal}; ` +
    (t.status === "finished" ? `kept ${t.winner}${t.note ? ` (${t.note})` : ""}` : (t.verdict ?? "no counts yet"))).join("\n");
}
