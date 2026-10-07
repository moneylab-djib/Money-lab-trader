/**
 * Money Lab idea critic
 *
 * Sends an idea's dossier to a stronger model (Opus 5.5) acting as a
 * sceptical investor. It answers with a verdict (GO, NO-GO, NEEDS MORE
 * EVIDENCE), the weakest points and what evidence is missing. The call goes
 * through the inference router: budgets apply and the cost is recorded.
 */

import type Database from "better-sqlite3";
import type { DelegateRouter } from "./delegate.js";
import { IDEA_GATES, type CriticVerdict, getIdea, ideaDossier, recordCritique } from "./ideas.js";
import { REVIEW_MODEL } from "./review.js";

const CRITIC_SYSTEM = `You are a sceptical, experienced investor reviewing a business idea proposed by an autonomous AI
agent. The agent has a tiny budget (a few dollars a day), no money for ads, cannot create accounts on its
own, and must earn real revenue to survive. It runs on its own Linux server and publishes static sites.
Your job is to stop it from wasting weeks on ideas that cannot work, and to push it toward original,
reachable niches. Be concrete and blunt. Check: is the demand proven or assumed? Do strong free
competitors already own the search results? Is the angle really different? Can it get its first
users without spam or paid ads? Is the revenue path realistic at this scale? Are the self-assessed
scores inflated?

Answer in under 450 words, in this exact structure:
Verdict: GO | NO-GO | NEEDS MORE EVIDENCE
Weakest points: (3-5 bullets)
Evidence missing: (bullets: what to check and how)
Scores you would give: (criterion: score, one line each, only where you disagree by 2 or more)
Better angle: (one or two sharper variants, or "none")
Kill criteria to use: (numbers and deadline)`;

export function parseVerdict(text: string): CriticVerdict | null {
  const match = /Verdict\**\s*:\s*\**\s*(NO-GO|NEEDS MORE EVIDENCE|GO)\b/i.exec(text);
  return match ? (match[1].toUpperCase() as CriticVerdict) : null;
}

export async function challengeIdea(
  db: Database.Database,
  id: string,
  options: { router: DelegateRouter; chat: (messages: any[], options: any) => Promise<any>; sessionId: string; now?: Date },
): Promise<{ text: string; costCents: number }> {
  const idea = getIdea(db, id);
  if (!idea) return { text: `No idea "${id}".`, costCents: 0 };
  if (idea.status !== "candidate") return { text: `Idea "${id}" is already ${idea.status}.`, costCents: 0 };
  if (idea.critiques.length >= IDEA_GATES.maxChallenges) {
    return { text: `Idea "${id}" was challenged ${idea.critiques.length} times already: decide now (approve or reject).`, costCents: 0 };
  }
  const last = idea.critiques.at(-1);
  if (last && Date.parse(idea.updatedAt) <= Date.parse(last.at)) {
    return { text: `Nothing changed since the last critique of "${id}": improve the idea or answer it first.`, costCents: 0 };
  }
  const result = await options.router.route(
    {
      messages: [
        { role: "system", content: CRITIC_SYSTEM },
        { role: "user", content: ideaDossier(idea) },
      ],
      taskType: "planning",
      tier: "normal",
      sessionId: options.sessionId,
      // The agent reads at most 10,000 characters of a tool result.
      maxTokens: 2000,
      model: REVIEW_MODEL,
    },
    options.chat,
  );
  if (!["stop", "length", "end_turn"].includes(result.finishReason) || !result.content.trim()) {
    // A timeout, a refusal or a budget block is not a critique.
    return { text: `Critique not run (${result.finishReason}): ${result.content.slice(0, 200)}`, costCents: result.costCents };
  }
  const verdict = parseVerdict(result.content);
  if (!verdict) {
    return {
      text: `${result.content.trim()}\n[critic: ${result.model}, ${result.costCents}c] The verdict line is missing, so this ` +
        "critique is not counted: challenge again.",
      costCents: result.costCents,
    };
  }
  recordCritique(db, id, {
    at: (options.now ?? new Date()).toISOString(),
    model: result.model,
    verdict,
    text: result.content.trim(),
  });
  return {
    text: `${result.content.trim()}\n[critic: ${result.model}, ${result.costCents}c] ` +
      "Answer it with the idea tool (update, response_to_critic), fix the dossier, or reject the idea.",
    costCents: result.costCents,
  };
}
