# Memory design

Memory is the core of the project. The agent is a language model whose weights never change: it
learns only through what it writes down, what code measures, and what it reads back before acting.
This document defines what is remembered, who may write it, how it is consolidated and how it is
retrieved. Status: proposed specification (2026-10-06), not implemented.

## 1. Goals

1. Accumulate a broker's working knowledge: traps, intuitions, how prices react to recurring events,
   and the cycles those reactions form.
2. Make Claude's existing knowledge useful without trusting it blindly: it becomes hypotheses that
   live data confirms or refutes.
3. Keep the record honest: no rewriting of past predictions, no self-graded success.
4. Fit a bounded context: each decision receives a compact, relevant memory pack, not the whole history.

## 2. Writers and trust

| Writer | May write | May not write |
| --- | --- | --- |
| Code (collectors, resolver, statistics) | Prices, event outcomes, measured reactions, prediction and trade resolutions, hypothesis confidence | Free-text judgement |
| Digest model (Haiku 4.5) | Observations extracted from news, scheduled events | Hypotheses, rules, anything about its own sources' reliability |
| Decision model (Sonnet 5.5) | Predictions, virtual orders, theses, links to hypotheses and traps | Resolutions, confidence values, retired rules |
| Consolidation and review (Sonnet 5.5 daily, Opus 5.5 weekly) | Post-mortems, hypotheses, traps, patterns, lessons, dossier notes, status proposals | Past predictions, past trades, measured numbers |
| Owner (Telegram) | Notes, ideas, corrections, rule vetoes | Nothing is off-limits to the owner |

Web pages and news are untrusted data: they can only produce observations. A hypothesis or rule never
comes directly from a page; it must be supported by measured evidence.

## 3. Stores

All stores live in SQLite (`state.db`), with full-text search (FTS5) on text columns. Readable
Markdown notebooks are exported from them for the owner (section 8).

### 3.1 Episodic: what happened

| Store | Key fields | Notes |
| --- | --- | --- |
| `observations` | observed_at, published_at, source, url, assets, kind, summary, trust | From news, filings, social, owner notes. `published_at` is mandatory: decisions only see observations published before the decision time. |
| `events` | type, assets, scheduled_at, occurred_at, expected, actual, surprise, source | Typed: central bank decision, inflation print, jobs report, earnings, token unlock, halving, listing, regulation, hack, index rebalance… |
| `reactions` | event_id, asset, window, return_pct, volume_ratio, computed_at | Computed by code only, at fixed windows (−24 h, +1 h, +24 h, +7 d). |
| `predictions` | made_at, asset, statement, condition, horizon_until, probability, hypothesis_ids, rationale | Append-only. Resolved by code: resolved_at, outcome, Brier score. |
| `trades` | opened_at, asset, qty, fill_price, fees, thesis, conviction, probability, invalidation, horizon, hypothesis_ids | Append-only entry; exit, P&L and post-mortem are appended as separate rows. |

### 3.2 Semantic: what it believes

| Store | Key fields | Notes |
| --- | --- | --- |
| `hypotheses` (intuitions) | statement, origin, conditions, test_rule, status, confidence, supersedes | origin: `prior` (Claude's knowledge), `observation`, `owner`, `review`. status: untested → testing → supported / refuted → retired. |
| `hypothesis_evidence` | hypothesis_id, kind (support / contradict), ref, source (`historical` / `forward`), weight | Each piece points to a reaction, prediction or trade. |
| `traps` | name, description, warning_signs, occurrences, cost_so_far | Named mistakes, for example "buying a rumour already priced in". |
| `trap_occurrences` | trap_id, trade_id or prediction_id, note | Written at post-mortem time. |
| `patterns` (cycles) | name, event_type, sequence, stats, n, last_seen | Recurring event → reaction sequences; `stats` and `n` are computed by code from `reactions`. |
| `dossiers` | asset, notes, catalysts, calendar | One per followed asset. |

### 3.3 Procedural: how it works

| Store | Key fields | Notes |
| --- | --- | --- |
| `lessons` (rules) | text, scope, provenance refs, status, created_at, retired_at, reason | Active rules are read before every decision. Each rule cites the evidence that justifies it. The owner can veto a rule. |

## 4. Turning Claude's knowledge into tested hypotheses

1. **Intake.** Once the semantic stores exist (slice 5 in docs/PLAN.fr.md), the agent runs an intake
   session with Opus 5.5: it writes what it
   believes about markets as testable hypotheses, each with a `test_rule`, for example "BTC moves more
   than 2 % in the 24 h after a Fed decision more often than on other days". Target: 50 to 100
   hypotheses across event types. Status: `untested`.
2. **Historical statistics (code only).** Where a hypothesis is about reactions to dated events, code
   measures it on past price history (for instance every Fed decision since 2018). This is plain
   statistics on data, not the model predicting a past it remembers, so it is allowed. Evidence is
   tagged `historical`.
3. **Forward testing.** The model's own predictive skill is measured only on predictions made from now
   on, with information published before the prediction. Evidence is tagged `forward`.
4. **Confidence is computed, not claimed.** Code maintains a Beta(α, β) count per hypothesis from
   supporting and contradicting evidence. Proposed thresholds: `supported` when at least 8 resolved
   instances and posterior mean ≥ 0.65; `refuted` at ≤ 0.35; otherwise `testing`. The weekly review may
   propose a status change; code applies it only if the numbers agree.

## 5. Learning loop

| Step | Cadence | Who | Reads | Writes |
| --- | --- | --- | --- | --- |
| Ingest | Hourly | Haiku 4.5 | News, filings, calendars | observations, events |
| Measure | Every few minutes | Code | Prices, events | reactions, pattern stats |
| Decide | ~3 sessions/day + triggers | Sonnet 5.5 | Memory pack (section 6) | predictions, virtual orders, theses |
| Resolve | Continuous | Code | Prices, horizons | outcomes, Brier scores, P&L, hypothesis evidence |
| Consolidate | Daily | Sonnet 5.5 | The day's resolutions and observations | post-mortems, trap occurrences, new hypotheses, dossier notes |
| Review | Weekly | Opus 5.5 | The week, hypothesis table, traps, rules | merged and retired hypotheses, lessons, new patterns to test, the owner's report |

Triggers for an extra decision session: a followed asset moves more than a set threshold, or a
scheduled event resolves.

## 6. Retrieval: the memory pack

Before each decision, code assembles a pack deterministically within a token budget (proposed
12,000 tokens), in this order:

1. Active lessons (all, they are short).
2. Open positions and pending predictions.
3. Traps whose warning signs or assets match the current context.
4. Hypotheses in `testing` or `supported` that mention the assets or upcoming events.
5. The last N reactions to the same event types, with pattern statistics.
6. Observations from the last 24 h on the assets in scope.
7. The asset dossier, truncated.

The model can then search further with full-text recall (Money Lab's `recall` tool, extended to the
memory tables). No embeddings and no vector database: structured keys plus FTS5 are enough at this
scale and cost nothing per query.

## 7. Integrity

- Predictions and trades are append-only; the agent's tools can insert but not update or delete them.
- Each day, code computes a hash chain over new predictions and trades. The weekly report shows the
  latest hash, so a silent rewrite would be visible.
- Limitation, inherited from Money Lab: in-process protections can be bypassed through the shell tool.
  This is acceptable while no money is at stake; before any real-money phase the resolver and the
  records must move out of the agent's reach (separate Linux user or service).

## 8. Owner view and hygiene

- Weekly export to `~/carnet/` as Markdown: `pieges.md`, `intuitions.md`, `cycles.md`, `lecons.md`,
  `journal.md`, one file per asset. French headings, versioned with git.
- Size caps per store; duplicates merged at weekly review; hypotheses untouched for 90 days retired
  with a reason, never deleted.
- Owner commands (French): `/note <texte>` stores an observation with source `owner`; `/idee <texte>`
  creates a hypothesis with origin `owner`; `/memoire <sujet>` shows what it knows on a topic;
  `/veto <règle>` retires a lesson.

## 9. Open questions

- Pack token budget and ordering: tune after two weeks of measured sessions.
- Confidence thresholds (8 instances, 0.65 / 0.35): proposal, to confirm with the owner.
- Whether daily consolidation needs Opus or Sonnet is enough: decide on measured quality.
