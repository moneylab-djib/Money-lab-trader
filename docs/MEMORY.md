# Memory design

Memory is the core of the project. The agent is a language model whose weights never change: it
learns only through what it writes down, what code measures, and what it reads back before acting.
This document defines what is remembered, who may write it, how it is consolidated and how it is
retrieved. Status (2026-10-06): implemented so far are prices, daily history, the event calendar, headlines,
reactions to past events computed on the fly from daily candles, hypotheses (owner,
prior and observation origins) with optional test rules evaluated by code on history, predictions
limited to "price above/below a threshold at a horizon", forward evidence, computed confidence, the
intake of Claude's prior knowledge and a memory pack (src/trader/). Everything else here is still the
proposed design.

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
| `trader_candles` (implemented) | asset, day, open, high, low, close, volume | Kraken daily candles, about two years; the unfinished day is skipped. |
| `trader_events` (implemented) | type (fomc, cpi, jobs), day, source | Fed decisions from the public FOMC calendar; CPI and jobs dates from FRED with the owner's free key. Code only. |
| `trader_headlines` (implemented) | url, title, domain, published_at | GDELT headlines about crypto and the Fed, hourly, kept 30 days. Untrusted data; the first observations, before a Haiku digest exists. |
| `trader_historical_tests` (implemented) | hypothesis_id, tested_at, data_from, data_to, cases, hits, rate, base_rate, z, verdict | Append-only; written by code only (section 4). |
| `predictions` | made_at, asset, statement, condition, horizon_until, probability, hypothesis_ids, rationale | Append-only. Resolved by code: resolved_at, outcome, Brier score. |
| `trades` | opened_at, asset, qty, fill_price, fees, thesis, conviction, probability, invalidation, horizon, hypothesis_ids | Append-only entry; exit, P&L and post-mortem are appended as separate rows. |

### 3.2 Semantic: what it believes

| Store | Key fields | Notes |
| --- | --- | --- |
| `hypotheses` (intuitions) | statement, origin, conditions, test_rule, status, confidence, valid_from, valid_to, recorded_at, supersedes | origin: `prior` (Claude's knowledge), `observation`, `owner`, `review`. status: untested → testing → supported / refuted → retired. |
| `hypothesis_evidence` | hypothesis_id, kind (support / contradict), ref, source (`historical` / `forward`), weight | Each piece points to a reaction, prediction or trade. |
| `traps` | name, description, warning_signs, occurrences, cost_so_far | Named mistakes, for example "buying a rumour already priced in". |
| `trap_occurrences` | trap_id, trade_id or prediction_id, note | Written at post-mortem time. |
| `patterns` (cycles) | name, event_type, sequence, stats, n, last_seen | Recurring event → reaction sequences; `stats` and `n` are computed by code from `reactions`. |
| `dossiers` | asset, notes, catalysts, calendar | One per followed asset. |
| `universe` | asset, action (add / remove), reason, data_source, recorded_at | The watch list the agent chooses (decision 0003); every change has a reason, so its choices can be reviewed. |

Semantic and procedural records are bi-temporal, an idea taken from Graphiti (docs/RESEARCH.md):
`valid_from` / `valid_to` say when the belief held in the market, `recorded_at` when the agent wrote it.
A superseded belief is closed with `valid_to`, never deleted, so the agent can see how its views changed.

### 3.3 Procedural: how it works

| Store | Key fields | Notes |
| --- | --- | --- |
| `lessons` (rules) | text, scope, provenance refs, status, valid_from, valid_to, recorded_at, retired_at, reason | Active rules are read before every decision. Each rule cites the evidence that justifies it. The owner can veto a rule. |

## 4. Turning Claude's knowledge into tested hypotheses

Implemented in step 1 ("Sonni already knows things", src/trader/intake.ts, rules.ts, historical.ts).

1. **Intake.** Once about 200 days of daily history are stored for every followed asset, the next
   wake is an intake: Sonni turns what it already knows into hypotheses with `propose_hypothesis`
   (origin `prior`), up to 10 per turn, 40 to 80 in total. The first 8 turns run on Opus 5.5. The
   intake repeats on later wakes until 30 prior hypotheses exist, at most 3 attempts; an attempt counts
   only when a paid turn runs. Knowledge the rule language cannot express (central banks, regulation,
   halvings) is accepted without a rule and left to forward testing.
2. **Historical statistics (code only).** A hypothesis may carry a `test_rule` in a small JSON language
   (src/trader/rules.ts): up to three conditions on day t (return over N days, daily range, up or down
   streak, weekday, volume versus its 20-day average, an event day of given types with an offset) and
   one outcome from day t to t+N (return, size
   of the move, or return relative to another asset). Code evaluates it on the stored Kraken daily
   candles (720 days, about two years) and records cases, hits, rate, the base rate (the outcome's
   frequency on all days, or 50 % for a "most of the time" claim), a one-sided z score and a verdict:
   `supported` (at least 30 cases and z ≥ 2.33, about a 1 % chance by luck), `refuted` (z ≤ 0),
   `inconclusive`, or `insufficient` (fewer than 30 cases). Results are append-only, re-run when new
   days arrive, and shown at once to the model when it proposes the hypothesis. This is plain
   statistics on data, not the model predicting a past it remembers.
3. **Forward testing.** The model's own predictive skill is measured only on predictions made from now
   on, with information published before the prediction. Evidence is tagged `forward`.
4. **Confidence is computed, not claimed.** Code maintains a Beta(α, β) count per hypothesis from
   forward evidence only. Proposed thresholds: `supported` when at least 8 resolved instances and
   posterior mean ≥ 0.65; `refuted` at ≤ 0.35; otherwise `testing`. The historical verdict is kept
   beside it, not folded in: history says which beliefs held before, predictions measure Sonni.
5. **Data dredging.** Every proposed hypothesis is kept, refuted ones included, and the memory pack
   shows how many rules were tested, so a rule found by trying many variants is visible as such.

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

Two optional steps for high-conviction calls, enabled when the budget allows (docs/RESEARCH.md):
several independent forecasts whose median probability is recorded, and a short adversarial pass that
argues the other side before a virtual trade; its arguments are stored with the trade.

## 6. Retrieval: the memory pack

Before each decision, code assembles a pack deterministically within a token budget (proposed
12,000 tokens). Within each group below, items are ranked by a computed score combining relevance to
the context, importance (evidence count, money at stake) and exponential recency decay with a
half-life per store: lessons and traps decay slowly, observations quickly (idea from FinMem). Groups,
in this order:

1. Active lessons (all, they are short).
2. Indicators computed by code for the assets in scope (returns, volatility, drawdown, moving-average
   position, volume ratios). The model never receives raw candles.
3. Open positions and pending predictions.
4. Traps whose warning signs or assets match the current context.
5. Hypotheses in `testing` or `supported` that mention the assets or upcoming events.
6. The last N reactions to the same event types, with pattern statistics.
7. Observations from the last 24 h on the assets in scope.
8. The asset dossier, truncated.

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
