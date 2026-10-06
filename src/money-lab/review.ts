/**
 * Money Lab weekly review and lessons
 *
 * Every REVIEW_INTERVAL the runtime wakes the agent for a review it cannot
 * skip: measure each experiment, decide continue/improve/pivot/kill, update
 * ~/LESSONS.md and report to the owner. LESSONS.md is read back into the
 * prompt on every turn, so what the agent learns survives its context window.
 */

import fs from "fs";
import path from "path";
import type Database from "better-sqlite3";
import { getKV, setKV } from "./journal.js";

export const REVIEW_KEY = "money_lab.last_review_at";
export const REVIEW_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
export const LESSONS_FILE = "LESSONS.md";
const LESSONS_MAX_CHARS = 4000;
/** The weekly review's first turns, where the strategic decisions are made, use the stronger model. */
export const REVIEW_MODEL = "claude-opus-5-5";
export const REVIEW_MODEL_TURNS = 4;

export const REVIEW_INSTRUCTIONS = `WEEKLY REVIEW (required in this wake cycle, before anything else):
1. Gather this week's evidence for every experiment: visits and referrers from your analytics, owner
   reports (Search Console, comments), revenue, and what each experiment cost you.
2. For each experiment, state the stage it reached (traffic, usage, revenue) against its criteria.
3. Score each active experiment with the idea criteria as if it were a new idea (idea tool, update): is it
   original, reachable, and still worth your money against the best ideas in your pipeline? Decide for each
   one: continue, improve, pivot or kill. Record the decision with record_experiment.
   Spend part of the week on discovery: add and score new ideas, so the pipeline always holds better options.
4. Rewrite ~/LESSONS.md (under 60 lines): what worked, what failed and why, what to try next. Keep only
   lessons that change future decisions.
5. Compare your budget plan with this week's actual spend per category; adjust the plan with
   set_budget_focus. Note what you added to ~/library and your skills.
6. Plan next week: the single most valuable action per experiment, its cost, and your runway.
7. Send the owner a short report in French with message_owner: results, decisions, budget split,
   plan, money left.`;

/** Starts the weekly clock on the first run, so the first review comes a week later. */
export function ensureReviewClock(db: Database.Database, now = new Date()): void {
  if (!getKV(db, REVIEW_KEY)) setKV(db, REVIEW_KEY, now.toISOString());
}

export function isReviewDue(db: Database.Database, now = new Date()): boolean {
  const last = getKV(db, REVIEW_KEY);
  if (!last) return false;
  return now.getTime() - new Date(last).getTime() >= REVIEW_INTERVAL_MS;
}

export function markReviewed(db: Database.Database, now = new Date()): void {
  setKV(db, REVIEW_KEY, now.toISOString());
}

/** The agent's own lessons, as written in ~/LESSONS.md (truncated). */
export function loadLessons(home = process.env.HOME || "/root"): string | null {
  const file = path.join(home, LESSONS_FILE);
  try {
    const text = fs.readFileSync(file, "utf-8").trim();
    if (!text) return null;
    return text.length > LESSONS_MAX_CHARS ? `${text.slice(0, LESSONS_MAX_CHARS)}\n[... truncated]` : text;
  } catch {
    return null;
  }
}
