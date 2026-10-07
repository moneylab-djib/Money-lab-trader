# Memory design

Memory is the core of the project. The agent is a language model whose weights never change: it
learns only through what it writes down, what code measures, and what it reads back before acting.
This document defines what is remembered, who may write it, how it is consolidated and how it is
retrieved. Status (2026-10-07): implemented so far are prices, daily history, the event calendar, headlines,
reactions to past events computed on the fly from daily candles, hypotheses (owner,
prior and observation origins) with optional test rules evaluated by code on history, predictions
limited to "price above/below a threshold at a horizon", forward evidence, computed confidence, the
intake of Claude's prior knowledge, a memory pack, and, since step 3 ("Sonni alive"), the model's own
identity (versioned), journal (append-only reflections), lessons with evidence and owner veto, the
self-report computed by code, watches and self-wakes, observations extracted by free reader models,
numbers polled from data sources, and the asset universe log (src/trader/). Virtual orders, traps,
patterns and dossiers are still the proposed design.

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
| Reader models (free, OpenAI-compatible: Gemini, Groq...; implemented) | Observations extracted from headlines and pages, validated field by field by code | Hypotheses, lessons, anything about its own reliability; they never decide |
| Decision model (Sonnet 5.5) | Predictions, virtual orders, theses, links to hypotheses and traps; its identity (new versions), journal entries, lessons with evidence, watches, asset and source choices with reasons | Resolutions, confidence values, scores, the self-report, retired rules of the owner |
| Consolidation and review (Sonnet 5.5 daily, Opus 5.5 weekly) | Post-mortems, hypotheses, traps, patterns, lessons, dossier notes, status proposals | Past predictions, past trades, measured numbers |
| Owner (Telegram) | Notes, ideas, corrections, lesson vetoes (/veto), source approvals (/source ok|non), identity corrections | Nothing is off-limits to the owner |

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
| `trader_headlines` (implemented) | url, title, domain, published_at, digested_at | Headlines about crypto and the Fed from GDELT and from five keyless RSS feeds (Cointelegraph, The Block, Decrypt filtered by keywords, the Fed's press releases, a Google News search; fixed in src/trader/news.ts, items of the last 48 h, 40 per feed), hourly (5, 10, 20 then 30 minutes after a failed or rate-limited fetch; the schedule is kept in KV so a restart does not call GDELT again at once), kept 30 days. Untrusted data. `digested_at` is set by code only once a reader has answered for the batch, so a failed or capped reader leaves the headline for the next digest. |
| `trader_historical_tests` (implemented) | hypothesis_id, tested_at, data_from, data_to, cases, hits, rate, base_rate, z, verdict | Append-only; written by code only (section 4). |
| `trader_observations` (implemented) | observed_at, published_at, source (reader:<id> or page), url, assets, kind, sentiment, summary, event_date, trust | Extracted by a free reader model from headlines (hourly digest) or from a page the model asked to read; every field validated and clipped by code, prompt-boundary patterns rejected; always `untrusted`; append-only. |
| `trader_reflections` (implemented) | kind (postmortem, session, daily, weekly), subject_id, content, recorded_at | The model's journal, in French, append-only. A post-mortem needs a scored prediction and exists once per prediction. |
| `trader_wakes` (implemented) | source, key, reason, at, delivered | Code-only log of curiosity triggers (section 5), delivered as a wake or only noted; append-only. |
| `trader_metrics` (implemented) | source_id, metric, ts, value | Numbers polled by code from the enabled data sources (90-day retention). |
| `trader_reader_calls` (implemented) | reader_id, at, purpose, ok, ms, status, error | Every reader call, for the daily caps and /lecteurs; keys never appear; error texts are written by code (never a provider's body); append-only. |
| `trader_page_reads` (implemented) | url, at, ok, outcome | Every `read_page` attempt, refused or failed ones included, so the daily cap (`readPagesPerDay`, 20) counts attempts, not only pages that produced an observation; append-only. |
| `predictions` | made_at, asset, statement, condition, horizon_until, probability, hypothesis_ids, rationale | Append-only. Resolved by code: resolved_at, outcome, Brier score. |
| `trades` | opened_at, asset, qty, fill_price, fees, thesis, conviction, probability, invalidation, horizon, hypothesis_ids | Append-only entry; exit, P&L and post-mortem are appended as separate rows. |

### 3.2 Semantic: what it believes

| Store | Key fields | Notes |
| --- | --- | --- |
| `hypotheses` (intuitions) | statement, statement_fr, origin, conditions, test_rule, status, confidence, valid_from, valid_to, recorded_at, supersedes | origin: `prior` (Claude's knowledge), `observation`, `owner`, `review`. status: untested → testing → supported / refuted → retired. `statement_fr` is what the owner reads: the owner's own text, or a free reader's translation of the model's statement (set once by code after the usual checks); the model keeps reasoning on `statement`, which it now writes in French too. |
| `hypothesis_evidence` | hypothesis_id, kind (support / contradict), ref, source (`historical` / `forward`), weight | Each piece points to a reaction, prediction or trade. |
| `traps` | name, description, warning_signs, occurrences, cost_so_far | Named mistakes, for example "buying a rumour already priced in". |
| `trap_occurrences` | trap_id, trade_id or prediction_id, note | Written at post-mortem time. |
| `patterns` (cycles) | name, event_type, sequence, stats, n, last_seen | Recurring event → reaction sequences; `stats` and `n` are computed by code from `reactions`. |
| `dossiers` | asset, notes, catalysts, calendar | One per followed asset. |
| `trader_universe` (implemented) | asset, kraken_pair, action (follow / unfollow), reason, recorded_at | The watch list the agent chooses (decision 0003): a Kraken EUR pair checked against the public pair list, every change with a reason, append-only; the followed set is the config plus this log replayed. The owner's configuration keeps authority: at startup code compares the configured assets with the previous start (KV `sonni.config_assets`) and logs a follow for an added asset, a follow with the new pair when the owner corrects the pair of an asset an older follow entry carries, and an unfollow for a removed one; a removed asset with open predictions stays followed until they resolve (retried at the next start), and the last followed asset is never dropped. |
| `trader_identity` (implemented) | version, content, reason, source (seed / model / owner), recorded_at | The model's self-description, in French, seeded by code; a new version per revision (at most one model revision per day, anchor words kept), never edited. |
| `trader_sources` + `trader_source_log` (implemented) | id, label, url, metrics (JSON paths), every_minutes, key_env, origin (catalog / model), status (enabled / disabled / proposed / rejected), reason, failures | Data sources polled by code (src/trader/catalog.ts). The model enables, disables or proposes one with a reason; the owner approves or rejects proposals (the proposal shows the exact URL); every action is logged append-only. At startup a catalog row whose label, URL, metrics, cadence or key changed in the code is updated in place, keeping its status and reason and resetting its failure count. Requests use HTTPS, refuse redirects and keep only the declared numeric paths; 20 failures in a row disable a source and the owner is told. |
| `trader_watches` (implemented) | kind (price / move / time), asset, direction, value, window_hours, due_at, note, expires_at, fired_at, cancelled_at | Conditions the model asks code to watch; fire once; the condition cannot be edited. |

Semantic and procedural records are bi-temporal, an idea taken from Graphiti (docs/RESEARCH.md):
`valid_from` / `valid_to` say when the belief held in the market, `recorded_at` when the agent wrote it.
A superseded belief is closed with `valid_to`, never deleted, so the agent can see how its views changed.

### 3.3 Procedural: how it works

| Store | Key fields | Notes |
| --- | --- | --- |
| `trader_lessons` (implemented) | text, evidence (prediction and hypothesis ids), status (active / retired), recorded_at, retired_at, retired_by (model / owner), retire_reason | Active lessons are in the cached part of every system prompt. A lesson needs at least one existing piece of evidence, at most 3 per day and 40 active; retired once, never deleted; the owner vetoes with /veto. |

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
| Ingest | Hourly | Code (calendars, headlines) and free reader models (digest) | Calendars, GDELT and RSS headlines, pages the model asks to read | events, headlines, observations |
| Measure | Every few minutes | Code | Prices, events | reactions, pattern stats |
| Decide | ~3 sessions/day + triggers | Sonnet 5.5 | Memory pack (section 6) | predictions, virtual orders, theses |
| Resolve | Continuous | Code | Prices, horizons | outcomes, Brier scores, P&L, hypothesis evidence |
| Consolidate | Daily | Sonnet 5.5 | The day's resolutions and observations | post-mortems, trap occurrences, new hypotheses, dossier notes |
| Review | Weekly | Opus 5.5 | The week, hypothesis table, traps, rules | merged and retired hypotheses, lessons, new patterns to test, the owner's report |

Triggers for an extra decision session (implemented in step 3, src/trader/curiosity.ts, evaluated by
code every minute): a followed asset moves `moveAlertPct` (3 %) or more within an hour; an event day
(from 07:00 UTC) and the morning after it (from 06:00 UTC); predictions resolved since the last such
wake (at most every 6 h); a watch the model set (a price level, a move over a window, a date to
revisit a question). Every trigger is logged; a wake is delivered only while the agent sleeps,
unpaused and not on a budget cap, at most `maxSelfWakesPerDay` (6) per UTC day and
`minMinutesBetweenWakes` (30) apart. The reflection step runs on the first wake after a prediction is
scored (post-mortem per prediction, lessons, optional identity revision), the self-report being
computed by code first; the weekly review on Opus adds a weekly reflection and the owner's report.
"Scored since the last reflection" is measured against KV `sonni.reflection_upto`, the latest
resolution time covered by the last completed reflection turn (set after the paid turn, never by the
model), so a prediction scored during a reflection turn is not skipped.
Readers (free models) digest the undigested headlines into observations on every five-minute pass
(up to 3 batches of 40 per pass, newest first, nothing when no headline waits), whether or not the
last GDELT fetch succeeded;
sources are polled on their own cadence; none of this uses paid inference.

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

Implemented pack (step 3, src/trader/pack.ts), within 9,000 characters, in order: what happened
since the previous session (triggers, resolutions, new headlines and observations, computed by code);
prices and changes; open predictions (15); recent resolutions (6), with the ids still waiting for a
post-mortem; open watches; the self-report (calibration, Brier by asset, horizon and direction,
counts, spend); upcoming events (14 days); ranked hypotheses (12, statements shortened); indicators
from the enabled sources with 24 h and 7 d references; past reactions to events; observations of the
last 24 h per asset with code-averaged sentiment, dated items and the pages the model read; the last
two reflections (shortened); raw headlines (12). Code fills sections in that order and, when the
budget runs out, cuts the section with a note naming how many lines were not shown, or lists the
omitted sections; nothing is silently dropped. The model reads any group in full with
`sonni_memory {"section": ...}` (hypotheses, predictions, observations, headlines, reflections,
watches, sources, events); a detail view does not move the "since the previous session" reference.
The identity text and the active lessons are not in the pack: they sit in the cached part of the
system prompt. `recall` searches the identity versions, reflections, lessons and hypotheses by terms
(no FTS5 index yet).

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
  `/veto <règle>` retires a lesson. Step 4 A: `/statut` is four short blocks in French and in the
  owner's time zone (`trader.timeZone`, default Europe/Paris) without identifiers, `/technique` keeps
  the runtime's technical state, and the daily message is Sonni's own morning report (yesterday,
  today, real alerts only; src/trader/report.ts). Implemented in step 3: `/identite` (and `/identite <texte>`, the
  owner's own version, recorded with source `owner`), `/journal`, `/lecons`, `/veto <id>`, `/bilan`,
  `/reveils`, `/lecteurs`, `/sources`, `/source ok|non <id>`, `/actifs`.

## 9. Open questions

- Pack token budget and ordering: tune after two weeks of measured sessions.
- Confidence thresholds (8 instances, 0.65 / 0.35): proposal, to confirm with the owner.
- Whether daily consolidation needs Opus or Sonnet is enough: decide on measured quality.
