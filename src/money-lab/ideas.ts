/**
 * Money Lab idea pipeline
 *
 * The agent must think before it builds. Every business idea is recorded
 * with evidence, competitors and a score per criterion (each with its
 * reason), challenged by a stronger model acting as a sceptical investor,
 * answered, and left to mature for a day. Only an idea that passes every
 * gate can become an experiment past the "exploring" stage; the runtime
 * enforces it in record_experiment.
 */

import type Database from "better-sqlite3";
import { getKV, setKV, listExperiments } from "./journal.js";

export const IDEA_CRITERIA = {
  demand: { weight: 2, help: "proof people need it: searches, forum questions, complaints, people already paying" },
  competition_gap: { weight: 1.5, help: "room left: existing solutions are weak, dated, overpriced or miss a segment (10 = wide open)" },
  originality: { weight: 1, help: "a distinct angle, niche, format or audience, not one more copy of a common tool" },
  marketing_ease: { weight: 1.5, help: "how easily you can reach users yourself, without ad money or spam (long-tail SEO, communities, directories)" },
  build_ease: { weight: 1, help: "how fast you can ship a version worth using (10 = a day)" },
  running_cost: { weight: 0.5, help: "how cheap it is to run (10 = free)" },
  revenue_potential: { weight: 1.5, help: "a credible path to money: who pays, how, how much" },
  server_edge: { weight: 1, help: "uses your own server (APIs, data collection, processing, automation) for something a static copy cannot do" },
  speed_to_signal: { weight: 1, help: "how fast you will know whether it works (10 = within days)" },
} as const;
export type IdeaCriterion = keyof typeof IDEA_CRITERIA;
export const CRITERIA = Object.keys(IDEA_CRITERIA) as IdeaCriterion[];
const TOTAL_WEIGHT = CRITERIA.reduce((sum, c) => sum + IDEA_CRITERIA[c].weight, 0);

export const IDEA_GATES = {
  minScoredIdeas: 5,
  minEvidence: 3,
  minCompetitors: 2,
  minTotal: 60,
  topRank: 3,
  reflectionHours: 6,
  maxActiveExperiments: 3,
  maxChallenges: 3,
};

export type IdeaStatus = "candidate" | "approved" | "rejected" | "launched";
export type CriticVerdict = "GO" | "NO-GO" | "NEEDS MORE EVIDENCE";

export interface Idea {
  id: string;
  title: string;
  problem: string;
  audience: string;
  solution: string;
  revenueModel: string;
  channels: string;
  serverEdge: string;
  evidence: string[];
  competitors: string[];
  risks: string[];
  killCriteria: string;
  scores: Partial<Record<IdeaCriterion, { score: number; why: string }>>;
  total: number | null;
  status: IdeaStatus;
  critiques: Array<{ at: string; model: string; verdict: CriticVerdict | null; text: string }>;
  response: string;
  decisionNote: string;
  experimentId: string | null;
  createdAt: string;
  updatedAt: string;
}

const IDEAS_KEY = "money_lab.ideas";
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ACTIVE_STATUSES = new Set(["building", "observing", "waiting_for_owner"]);

export function listIdeas(db: Database.Database): Idea[] {
  try {
    const ideas = JSON.parse(getKV(db, IDEAS_KEY) ?? "[]");
    return Array.isArray(ideas) ? (ideas as Idea[]) : [];
  } catch {
    return [];
  }
}

const MAX_OPEN_IDEAS = 40;
const MAX_STORED_IDEAS = 120;

function save(db: Database.Database, ideas: Idea[]): void {
  // Keep every open or launched idea; drop the oldest rejected ones beyond the cap.
  let kept = ideas;
  while (kept.length > MAX_STORED_IDEAS) {
    const oldestRejected = kept.findIndex((i) => i.status === "rejected");
    if (oldestRejected < 0) break;
    kept = kept.filter((_, index) => index !== oldestRejected);
  }
  setKV(db, IDEAS_KEY, JSON.stringify(kept));
}

export function getIdea(db: Database.Database, id: string): Idea | undefined {
  return listIdeas(db).find((i) => i.id === id);
}

/** Weighted score out of 100, or null until every criterion is scored. */
export function ideaTotal(scores: Idea["scores"]): number | null {
  if (!CRITERIA.every((c) => scores[c])) return null;
  const sum = CRITERIA.reduce((acc, c) => acc + scores[c]!.score * IDEA_CRITERIA[c].weight, 0);
  return Math.round((sum / (10 * TOTAL_WEIGHT)) * 100);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function list(value: unknown): string[] | undefined {
  if (typeof value === "string") return value.trim() ? [value.trim()] : undefined;
  return Array.isArray(value) ? value.map((v) => String(v).trim()).filter(Boolean) : undefined;
}

/** Creates or updates an idea; lists are appended, scores replaced per criterion. */
export function upsertIdea(db: Database.Database, input: Record<string, unknown>, now = new Date()): Idea | string {
  const id = String(input.id ?? "");
  if (!ID.test(id)) return "id must be 1-40 lowercase letters, digits or dashes (e.g. quote-generator-plumbers).";
  const ideas = listIdeas(db);
  let idea = ideas.find((i) => i.id === id);
  if (idea && idea.status !== "candidate") return `Idea "${id}" is ${idea.status}; it can no longer be edited.`;
  if (!idea) {
    if (!text(input.title) || !text(input.problem)) return "A new idea needs at least a title and the problem it solves.";
    const open = ideas.filter((i) => i.status === "candidate" || i.status === "approved").length;
    if (open >= MAX_OPEN_IDEAS) return `The pipeline holds ${MAX_OPEN_IDEAS} open ideas; reject the weakest first.`;
    idea = {
      id, title: "", problem: "", audience: "", solution: "", revenueModel: "", channels: "", serverEdge: "",
      evidence: [], competitors: [], risks: [], killCriteria: "", scores: {}, total: null, status: "candidate",
      critiques: [], response: "", decisionNote: "", experimentId: null,
      createdAt: now.toISOString(), updatedAt: now.toISOString(),
    };
    ideas.push(idea);
  }
  const fields: Array<[keyof Idea, string]> = [
    ["title", "title"], ["problem", "problem"], ["audience", "audience"], ["solution", "solution"],
    ["revenueModel", "revenue_model"], ["channels", "channels"], ["serverEdge", "server_edge"],
    ["killCriteria", "kill_criteria"], ["response", "response_to_critic"],
  ];
  for (const [field, arg] of fields) {
    const value = text(input[arg]);
    if (value !== undefined) (idea as any)[field] = value;
  }
  for (const [field, arg] of [["evidence", "evidence"], ["competitors", "competitors"], ["risks", "risks"]] as const) {
    for (const item of list(input[arg]) ?? []) if (!idea[field].includes(item)) idea[field].push(item);
  }
  if (input.scores !== undefined) {
    if (!input.scores || typeof input.scores !== "object" || Array.isArray(input.scores)) return "scores must be an object.";
    for (const [criterion, raw] of Object.entries(input.scores as Record<string, any>)) {
      if (!(criterion in IDEA_CRITERIA)) return `Unknown criterion "${criterion}". Use: ${CRITERIA.join(", ")}.`;
      const score = Number(raw?.score);
      const why = String(raw?.why ?? "").trim();
      if (!Number.isInteger(score) || score < 0 || score > 10) return `${criterion}.score must be an integer 0-10.`;
      if (why.length < 15) return `${criterion}.why must explain the score with facts (15+ characters).`;
      idea.scores[criterion as IdeaCriterion] = { score, why };
    }
  }
  idea.total = ideaTotal(idea.scores);
  idea.updatedAt = now.toISOString();
  save(db, ideas);
  return idea;
}

/** Ideas ranked by total (scored first). */
export function rankedIdeas(db: Database.Database): Idea[] {
  return listIdeas(db)
    .filter((i) => i.status !== "rejected")
    .sort((a, b) => (b.total ?? -1) - (a.total ?? -1));
}

export function activeExperimentCount(db: Database.Database): number {
  return listExperiments(db).filter((e) => ACTIVE_STATUSES.has(e.status)).length;
}

/** Every gate an idea must pass before it is approved; empty when it passes. */
export function approvalBlockers(db: Database.Database, idea: Idea, now = new Date()): string[] {
  const g = IDEA_GATES;
  const blockers: string[] = [];
  const missing = CRITERIA.filter((c) => !idea.scores[c]);
  if (missing.length) blockers.push(`score every criterion (missing: ${missing.join(", ")})`);
  if (idea.total !== null && idea.total < g.minTotal) blockers.push(`total ${idea.total}/100 is below ${g.minTotal}`);
  if (idea.evidence.length < g.minEvidence) blockers.push(`at least ${g.minEvidence} evidence sources (have ${idea.evidence.length})`);
  if (idea.competitors.length < g.minCompetitors) blockers.push(`at least ${g.minCompetitors} competitors or alternatives studied (have ${idea.competitors.length})`);
  if (!idea.solution || !idea.audience || !idea.revenueModel || !idea.channels) blockers.push("describe audience, solution, revenue_model and channels");
  if (!idea.killCriteria) blockers.push("set kill_criteria: the numbers that will make you stop");
  const scored = listIdeas(db).filter((i) => i.total !== null).length;
  if (scored < g.minScoredIdeas) blockers.push(`compare at least ${g.minScoredIdeas} fully scored ideas (have ${scored})`);
  const rank = rankedIdeas(db).filter((i) => i.total !== null && i.status !== "launched").findIndex((i) => i.id === idea.id);
  if (idea.total !== null && (rank < 0 || rank >= g.topRank)) blockers.push(`be in the top ${g.topRank} of your scored ideas (rank ${rank + 1})`);
  const critique = idea.critiques.at(-1);
  if (!critique) blockers.push("get a critique with action challenge");
  else if (critique.verdict === "NO-GO") blockers.push("the latest critique says NO-GO: improve the idea and challenge it again, or reject it");
  if (critique && !idea.response) blockers.push("answer the critique with response_to_critic");
  const ageHours = (now.getTime() - Date.parse(idea.createdAt)) / 3_600_000;
  if (ageHours < g.reflectionHours) blockers.push(`let it mature: ${Math.ceil(g.reflectionHours - ageHours)} h left before approval`);
  if (activeExperimentCount(db) >= g.maxActiveExperiments) blockers.push(`at most ${g.maxActiveExperiments} active experiments: finish or pause one first`);
  return blockers;
}

export function decideIdea(
  db: Database.Database,
  id: string,
  decision: "approve" | "reject",
  note: string,
  now = new Date(),
): string {
  const ideas = listIdeas(db);
  const idea = ideas.find((i) => i.id === id);
  if (!idea) return `No idea "${id}".`;
  const changeOfMind = decision === "reject" && idea.status === "approved";
  if (idea.status !== "candidate" && !changeOfMind) return `Idea "${id}" is already ${idea.status}.`;
  if (!note.trim()) return "Give the reason for your decision in note.";
  if (decision === "approve") {
    const blockers = approvalBlockers(db, idea, now);
    if (blockers.length) return `Not approved yet. Still needed:\n- ${blockers.join("\n- ")}`;
  }
  idea.status = decision === "approve" ? "approved" : "rejected";
  idea.decisionNote = note.trim();
  idea.updatedAt = now.toISOString();
  save(db, ideas);
  return decision === "approve"
    ? `Idea "${id}" approved (${idea.total}/100). Create its experiment with record_experiment (idea_id "${id}", status building).`
    : `Idea "${id}" rejected. The reason stays in your pipeline so you do not reconsider it blindly.`;
}

export function recordCritique(db: Database.Database, id: string, critique: Idea["critiques"][number]): void {
  const ideas = listIdeas(db);
  const idea = ideas.find((i) => i.id === id);
  if (!idea) return;
  idea.critiques.push(critique);
  idea.response = "";
  save(db, ideas);
}

/** Experiments created before the pipeline existed keep their history. */
export const IDEA_GATE_SINCE = "2026-10-06T00:00:00.000Z";

/**
 * Gate for record_experiment: an experiment becomes active (building,
 * observing, waiting_for_owner) only through an approved idea, and at most
 * maxActiveExperiments are active. Returns an error message, or null.
 */
export function experimentLaunchBlocker(
  db: Database.Database,
  input: { status: string; ideaId?: string },
  existing: { id: string; status: string; createdAt: string; metrics: Record<string, unknown> } | undefined,
): string | null {
  if (!ACTIVE_STATUSES.has(input.status)) return null;
  if (existing && ACTIVE_STATUSES.has(existing.status)) return null;
  if (activeExperimentCount(db) >= IDEA_GATES.maxActiveExperiments) {
    return `At most ${IDEA_GATES.maxActiveExperiments} active experiments: finish or pause one first.`;
  }
  if (existing) {
    // Launched through an approved idea (the idea records this experiment),
    // or created before the pipeline existed.
    const linked = typeof existing.metrics.idea_id === "string" && getIdea(db, existing.metrics.idea_id)?.experimentId === existing.id;
    if (linked || Date.parse(existing.createdAt) < Date.parse(IDEA_GATE_SINCE)) return null;
  }
  if (!input.ideaId) {
    return "An experiment becomes active only through an approved idea: research, score and challenge it with the " +
      "idea tool, approve it, then pass idea_id. Keep status exploring meanwhile.";
  }
  const idea = getIdea(db, input.ideaId);
  if (!idea) return `No idea "${input.ideaId}".`;
  if (idea.status !== "approved") return `Idea "${input.ideaId}" is ${idea.status}, not approved.`;
  return null;
}

export function markIdeaLaunched(db: Database.Database, id: string, experimentId: string): void {
  const ideas = listIdeas(db);
  const idea = ideas.find((i) => i.id === id);
  if (!idea) return;
  idea.status = "launched";
  idea.experimentId = experimentId;
  save(db, ideas);
}

export function ideaDossier(idea: Idea): string {
  const scores = CRITERIA.map((c) => {
    const s = idea.scores[c];
    return `- ${c}: ${s ? `${s.score}/10 — ${s.why}` : "not scored"}`;
  });
  return [
    `Idea: ${idea.title} (${idea.id})`,
    `Problem: ${idea.problem}`,
    `Audience: ${idea.audience || "?"}`,
    `Solution: ${idea.solution || "?"}`,
    `Revenue model: ${idea.revenueModel || "?"}`,
    `Channels: ${idea.channels || "?"}`,
    `Use of own server: ${idea.serverEdge || "?"}`,
    `Evidence:\n${idea.evidence.map((e) => `- ${e}`).join("\n") || "- none"}`,
    `Competitors and alternatives:\n${idea.competitors.map((e) => `- ${e}`).join("\n") || "- none"}`,
    `Known risks:\n${idea.risks.map((e) => `- ${e}`).join("\n") || "- none"}`,
    `Kill criteria: ${idea.killCriteria || "?"}`,
    `Self-assessed scores (total ${idea.total ?? "incomplete"}/100):\n${scores.join("\n")}`,
    idea.critiques.length ? `Previous critique: ${idea.critiques.at(-1)!.text.slice(0, 1500)}\nAnswer: ${idea.response || "none"}` : "",
  ].filter(Boolean).join("\n");
}

/** True while fewer ideas are fully scored than an approval requires. */
export function discoveryIncomplete(db: Database.Database): { scored: number; needed: number } | null {
  const scored = listIdeas(db).filter((i) => i.total !== null).length;
  return scored < IDEA_GATES.minScoredIdeas ? { scored, needed: IDEA_GATES.minScoredIdeas } : null;
}

/** Pipeline summary for the prompt. */
export function describePipeline(db: Database.Database): string {
  const ideas = listIdeas(db);
  if (ideas.length === 0) return "empty: no idea researched yet";
  const count = (s: IdeaStatus) => ideas.filter((i) => i.status === s).length;
  const top = rankedIdeas(db)
    .filter((i) => i.status === "candidate" || i.status === "approved")
    .slice(0, 5)
    .map((i) => `${i.id} ${i.total ?? "?"}/100 [${i.status}${i.critiques.at(-1)?.verdict ? `, critic ${i.critiques.at(-1)!.verdict}` : ""}]`);
  return `${count("candidate")} candidates, ${count("approved")} approved, ${count("launched")} launched, ${count("rejected")} rejected; ` +
    `top: ${top.join(", ") || "none"}`;
}
