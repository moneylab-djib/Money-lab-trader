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
| `trader_reactions` (implemented, step C2) | type, day, asset, window (run_up / day / week / hour), return_pct, computed_at | Computed by code only, once per past event, asset and window: close two days before to the close before (run-up), close before to the close of the event day, close before to the first close a week later, and the first hour after the release (18:00 UTC for the Fed, 12:30 UTC for CPI and jobs; from 5-minute prices within 20 minutes). Measured after each daily history and calendar update. Append-only. |
| `trader_candles` (implemented) | asset, day, open, high, low, close, volume | Kraken daily candles, about two years; the unfinished day is skipped. |
| `trader_events` (implemented) | type (fomc, cpi, jobs), day, source | Fed decisions from the public FOMC calendar; CPI and jobs dates from FRED with the owner's free key. Code only. |
| `trader_headlines` (implemented) | url, title, domain, published_at, digested_at | Headlines about crypto and the Fed from GDELT and from five keyless RSS feeds (Cointelegraph, The Block, Decrypt filtered by keywords, the Fed's press releases, a Google News search; fixed in src/trader/news.ts, items of the last 48 h, 40 per feed), hourly (5, 10, 20 then 30 minutes after a failed or rate-limited fetch; the schedule is kept in KV so a restart does not call GDELT again at once), kept 30 days. Untrusted data. `digested_at` is set by code only once a reader has answered for the batch, so a failed or capped reader leaves the headline for the next digest. |
| `trader_historical_tests` (implemented) | hypothesis_id, tested_at, data_from, data_to, cases, hits, rate, base_rate, z, verdict | Append-only; written by code only (section 4). |
| `trader_observations` (implemented) | observed_at, published_at, source (reader:<id> or page), url, assets, kind, sentiment, summary, event_date, trust | Extracted by a free reader model from headlines (hourly digest) or from a page the model asked to read; every field validated and clipped by code, prompt-boundary patterns rejected; always `untrusted`; append-only. |
| `trader_reflections` (implemented) | kind (postmortem, trade, session, daily, weekly), subject_id, content, recorded_at | The model's journal, in French, append-only. A post-mortem needs a scored prediction and exists once per prediction; a `trade` reflection needs a closed trade and exists once per trade (databases from before step 4 B are rebuilt once to accept the kind). |
| `trader_ledger` (implemented, step 4 B) | at, kind (capital / contribution / buy / sell), asset, quantity, price, amount_eur, fee_eur, order_id | Every cash movement of the virtual portfolio, written by code only; cash is its sum. Append-only. |
| `trader_orders` (implemented, step 4 B) | placed_at, asset, side, kind (market / limit), amount_eur or quantity, limit_price, thesis, probability, invalidation, horizon_until, hypothesis_ids, origin (model / stop / owner), status (pending → filled / cancelled / expired), settled_at, fill_price, fill_quantity, fill_eur, fee_eur, slippage_eur, note | The model's orders, checked by code before they exist (src/trader/portfolio.ts) and settled once by code at a later price: a trigger refuses any second settlement or any change to the order's own fields. A stop is an order code places with origin `stop`. |
| `trader_trades` (implemented, step 4 B) | asset, opened_at, closed_at, quantity, entry_price, exit_price, fees_eur, pnl_eur, pnl_pct, open_order_id, close_order_id, close_reason (model / stop), thesis | One per sale, P&L after fees computed by code; append-only. The model writes one `trade` reflection per closed trade. |
| `trader_position_updates` (implemented, step 4 B) | asset, at, field (invalidation / horizon_until), old_value, new_value, reason, by (model / code) | Every change to a position's levels, with the model's reason or code's (a stop clears the level); append-only. |
| `trader_portfolio_days` (implemented, step 4 B) | day, at, cash_eur, positions_eur, equity_eur, contributed_eur | One equity snapshot per UTC day (first tick), for returns, drawdown and the evening summary's daily change; append-only. |
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
| `trader_traps` (implemented, step 4 B) | name, description, warning_signs, recorded_at | Named mistakes, for example "buying a rumour already priced in"; at most 40, one per name; the names are in every memory pack. Append-only. |
| `trader_trap_hits` (implemented, step 4 B) | trap_id, trade_id, note, recorded_at | A closed trade counted against a trap, once per pair, written by the model at post-mortem time (`note_trap hit`); append-only. |
| `trader_positions` (implemented, step 4 B) | asset, quantity, avg_cost, opened_at, open_order_id, invalidation, horizon_until, thesis, updated_at | The current holding per asset: quantity and average cost are changed only by code on fills; the model moves `invalidation` and `horizon_until` with a logged reason (`manage_position`). Not append-only: it is state, and the ledger, orders and trades are its record. |
| `trader_patterns` (cycles; implemented, step C2) | name, event_type, asset, window, direction (up / down / big_move), threshold_pct, note, recorded_at | A cycle the model names (`name_pattern`): a claim about one asset's reaction around one event type in one window. Its statistics are computed by code from `trader_reactions` each time they are shown: cases, hits, rate against all days of the same window, z score and verdict (supported at z ≥ 2.33, refuted at z ≤ 0, insufficient under 10 cases; events are rare, so fewer cases than the hypotheses' 30). At most 30, names unique, append-only. |
| `trader_dossiers` (implemented, step C1) | asset, version, content, reason, source (model / owner), recorded_at | One dossier per followed asset, in French: long-term thesis, catalysts, levels, what it learned. The model rewrites it with `update_dossier` (at most one revision per asset and UTC day, 40 to 1,500 characters, prompt-boundary patterns refused); the owner's `/dossier` reads it; every version is kept, append-only. The latest version per asset is in every memory pack (400 characters each; `sonni_memory {"section": "dossiers"}` for the full texts). |
| `trader_owner_notes` (implemented, step C1) | at, text, assets | The owner's notes (`/note <texte>`), the one trusted writer besides code: shown in the pack for 7 days as information to weigh, never as orders to trade; the followed symbols a note mentions are tagged. Append-only. |
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
| Resolve | Continuous (every price collection) | Code | Prices, horizons, pending orders, invalidation levels | outcomes, Brier scores, fills, stops, expiries, trades with P&L, daily snapshot, hypothesis evidence |
| Consolidate (implemented, step C3: src/trader/consolidation.ts) | Daily, one paid turn from `trader.consolidation` (19:30 in the owner's time zone) delivered as a wake while the agent sleeps unpaused and under its caps (a no-progress sleep does not hold it back); any wake after that time is the evening turn until it is done; 40c of the daily cap are reserved for it (2026-10-08); marked done only after a paid turn | Sonnet 5.5 | The day's resolutions, closed trades, observations and the owner's notes | post-mortems still due, trap hits, the dossiers that changed, one `daily` reflection shown in the owner's 20:00 summary |
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
prices and changes; the owner's notes of the last 7 days (trusted); the virtual portfolio (step 4 B: cash, positions with stop, horizon and thesis,
pending orders, the last 24 h of settled orders, closed trades waiting for a post-mortem, the names of
the traps); open predictions (15); recent resolutions (6), with the ids still waiting for a
post-mortem; open watches; the self-report (calibration, Brier by asset, horizon and direction,
counts, spend); upcoming events (14 days); ranked hypotheses (12, statements shortened); indicators
from the enabled sources with 24 h and 7 d references; past reactions to events; observations of the
last 24 h per asset with code-averaged sentiment, dated items and the pages the model read; the last
two reflections (shortened); raw headlines (12). Code fills sections in that order and, when the
budget runs out, cuts the section with a note naming how many lines were not shown, or lists the
omitted sections; nothing is silently dropped. The model reads any group in full with
`sonni_memory {"section": ...}` (dossiers, notes, portfolio with trades and traps, trades, traps,
hypotheses, predictions, observations, headlines, reflections, watches, sources, events); ranked
hypotheses are followed by the latest dossier per followed asset; the event cycles section (measured
windows per asset for the event types due within 7 days, then the named cycles with code's verdicts)
replaces the step 2 "event reactions" lines, and `sonni_memory {"section": "cycles"}` shows every type; a detail view does not move the "since the previous session" reference.
The identity text and the active lessons are not in the pack: they sit in the cached part of the
system prompt. `recall` searches the identity versions, reflections, lessons and hypotheses by terms
(no FTS5 index yet), and since step C1 the dossiers, traps, the owner's notes and the theses behind
orders; the owner searches the same stores with `/memoire <sujet>` (labels in French, no identifiers).

Conversation history (2026-10-08): besides the pack, each call carries the last turns of the
loop. Measured on the VPS on 2026-10-07, the 20 to 29 turns Money Lab keeps were about 70 % of every
call (38k to 49k tokens) and mostly repeated the pack. Sonni keeps 8 to 11 turns (window 8, dropped 4
at a time so the prefix stays cacheable 3 turns out of 4); what matters beyond them is already in the
stores and comes back through the pack, `sonni_memory` and `recall`.

## 7. Integrity

- Predictions and trades are append-only; the agent's tools can insert but not update or delete them.
  Orders are settled once by code (a trigger refuses a second settlement or a change to the order's
  own fields); the ledger, trades, position updates, traps and hits are append-only; positions are
  state kept by code, with every level change logged. Fees, slippage, P&L, returns, drawdown and the
  self-funding ratio are computed by code, never written by the model.
- Each day, code computes a hash chain over new predictions and trades. The weekly report shows the
  latest hash, so a silent rewrite would be visible.
- Limitation, inherited from Money Lab: in-process protections are not an isolation boundary. Since
  the guard map (docs/GUARDS.md, G1) the model has no shell, file or installer tool, so a prompt
  injection has no path to the database or the host; before any real-money phase the resolver and
  the records must still move out of the agent's reach (separate Linux user or service).
- Incident log (`trader_incidents`, append-only, code only): automatic pauses, caps, unknown costs,
  error streaks, cut answers, unknown stop reasons, no-progress sleeps, disabled sources, refused
  readers, failed backups; `/technique` shows 7 days, the morning report counts 24 h.

## 8. Owner view and hygiene

- Weekly export to `~/carnet/` as Markdown (implemented, step C1, src/trader/notebooks.ts: every
  Sunday in the owner's time zone and on `/carnets`, files rewritten whole from the stores):
  `journal.md`, `intuitions.md`, `pieges.md`, `lecons.md`, `identite.md`, `portefeuille.md`, one file
  per followed asset (dossier versions, predictions, closed trades), and `cycles.md` (step C2).
- Size caps per store; duplicates merged at weekly review; hypotheses untouched for 90 days retired
  with a reason, never deleted.
- Owner commands (French): `/note <texte>` stores a trusted owner note (step C1); `/idee <texte>`
  creates a hypothesis with origin `owner`; `/memoire <sujet>` shows what it knows on a topic (step
  C1); `/dossier [actif]` shows a dossier and its versions (step C1); `/carnets` writes the
  notebooks now (step C1); `/cycles` shows the measured reactions and the named cycles with their
  verdicts (step C2); `/veto <règle>` retires a lesson. Step 4 A: `/statut` is four short blocks in French and in the
  owner's time zone (`trader.timeZone`, default Europe/Paris) without identifiers, `/technique` keeps
  the runtime's technical state, and the daily message is Sonni's own morning report (yesterday,
  today, real alerts only; src/trader/report.ts). Step 4 B: `/portefeuille` (value, positions with
  their reasons, pending and recent orders, code-computed results, closed trades, traps), `/journee`
  (the day's orders with reasons, value and daily change, resolved predictions, what it wrote and
  spent), also sent once each evening from 20:00 in the owner's time zone, the owner's choice of
  2026-10-07 over a message per order; `/bilan` adds the three proofs of decision 0003 (return after
  fees, errors, self-funding ratio). Implemented in step 3: `/identite` (and `/identite <texte>`, the
  owner's own version, recorded with source `owner`), `/journal`, `/lecons`, `/veto <id>`, `/bilan`,
  `/reveils`, `/lecteurs`, `/sources`, `/source ok|non <id>`, `/actifs`.

## 9. Open questions

- Pack token budget and ordering: tune after two weeks of measured sessions.
- Confidence thresholds (8 instances, 0.65 / 0.35): proposal, to confirm with the owner.
- Whether daily consolidation needs Opus or Sonnet is enough: decide on measured quality.
