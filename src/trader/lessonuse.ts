/**
 * Lessons with evidence counted by code (plan of 2026-10-08 step 4).
 *
 * ACE (ICLR 2026, docs/RESEARCH.md 5.1): lessons kept as items with
 * helpful/harmful counters and changed in small steps beat lessons
 * rewritten as a whole, which collapsed; without reliable feedback they
 * polluted the context. So Sonni cites the lessons it applies when it
 * records a prediction or a decision (lesson_ids), and code scores each
 * use once the outcome is known: a prediction helped when its Brier score
 * beat code's reference (snapshot.ts), a decision helped when it was on the
 * right side of the next 7 days (decisions.ts). A lesson used at least 6
 * times that hurt twice as often as it helped is flagged "evidence
 * against" in Sonni's prompt and in /lecons; retiring it stays Sonni's or
 * the owner's call (the store keeps who retired a lesson).
 */

import type Database from "better-sqlite3";
import { decisionOutcome, listDecisions } from "./decisions.js";
import { getPrediction } from "./predictions.js";
import { getPredictionSnapshot } from "./snapshot.js";

type DB = Database.Database;

export const MAX_LESSONS_PER_USE = 5;
export const AGAINST_MIN_SCORED = 6;
export const UNTESTED_BELOW = 3;

export interface LessonEvidence {
  uses: number;
  helped: number;
  hurt: number;
  pending: number;
}

/** Records which active lessons a prediction or decision applied; returns the ids kept. */
export function recordLessonUses(db: DB, lessonIds: unknown, kind: "prediction" | "decision", subjectId: string, now: Date = new Date()): string[] {
  const ids = [...new Set((Array.isArray(lessonIds) ? lessonIds : []).map((x) => String(x).trim()).filter(Boolean))].slice(0, MAX_LESSONS_PER_USE);
  const kept: string[] = [];
  const insert = db.prepare("INSERT OR IGNORE INTO trader_lesson_uses (lesson_id, subject_kind, subject_id, at) VALUES (?, ?, ?, ?)");
  for (const id of ids) {
    if (!db.prepare("SELECT 1 FROM trader_lessons WHERE id = ? AND status = 'active'").get(id)) continue;
    insert.run(id, kind, subjectId, now.toISOString());
    kept.push(id);
  }
  return kept;
}

function scoreUse(db: DB, kind: string, subjectId: string): "helped" | "hurt" | "pending" {
  if (kind === "prediction") {
    const p = getPrediction(db, subjectId);
    const s = getPredictionSnapshot(db, subjectId);
    if (!p || p.brier === null || p.outcome === null || !s) return "pending";
    const ref = (s.refProbability - p.outcome) ** 2;
    return p.brier < ref ? "helped" : p.brier > ref ? "hurt" : "pending";
  }
  const d = listDecisions(db).find((x) => x.id === subjectId);
  const o = d ? decisionOutcome(db, d, 168) : null;
  return o ? (o.good ? "helped" : "hurt") : "pending";
}

export function lessonEvidence(db: DB): Map<string, LessonEvidence> {
  const out = new Map<string, LessonEvidence>();
  const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'trader_lesson_uses'").get();
  if (!hasTable) return out;
  for (const u of db.prepare("SELECT lesson_id, subject_kind, subject_id FROM trader_lesson_uses").all() as { lesson_id: string; subject_kind: string; subject_id: string }[]) {
    const e = out.get(u.lesson_id) ?? { uses: 0, helped: 0, hurt: 0, pending: 0 };
    e.uses++;
    e[scoreUse(db, u.subject_kind, u.subject_id)]++;
    out.set(u.lesson_id, e);
  }
  return out;
}

export type LessonFlag = "untested" | "against" | "supported" | "mixed";

export function lessonFlag(e: LessonEvidence | undefined): LessonFlag {
  const scored = e ? e.helped + e.hurt : 0;
  if (!e || scored < UNTESTED_BELOW) return "untested";
  if (scored >= AGAINST_MIN_SCORED && e.hurt >= 2 * e.helped) return "against";
  return e.helped > e.hurt ? "supported" : "mixed";
}

/** For the model: "(used 7: helped 5, hurt 2)" with the flag that matters. */
export function describeEvidence(e: LessonEvidence | undefined): string {
  const flag = lessonFlag(e);
  const counts = e ? `used ${e.uses}: helped ${e.helped}, hurt ${e.hurt}${e.pending ? `, ${e.pending} pending` : ""}` : "not used yet";
  return flag === "against"
    ? `(${counts}; EVIDENCE AGAINST: retire it with retire_lesson, or say in your next reflection why it still holds)`
    : `(${counts}${flag === "untested" ? "; untested" : ""})`;
}

export function describeEvidenceFr(e: LessonEvidence | undefined): string {
  const flag = lessonFlag(e);
  if (!e) return "jamais appliquée encore";
  const base = `appliquée ${e.uses} fois : a aidé ${e.helped}, a nui ${e.hurt}${e.pending ? `, ${e.pending} en attente` : ""}`;
  return flag === "against" ? `${base} ⚠ les faits la contredisent` : flag === "untested" ? `${base} (pas encore assez de cas)` : base;
}
