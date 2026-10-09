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
| Decision model (Sonnet 5.5; a buy of 20 % of the portfolio or more is confirmed on Opus 5.5) | Predictions, virtual orders, theses, decisions per asset with reasons, links to hypotheses and traps; its identity (new versions), journal entries, lessons with evidence, watches, asset and source choices with reasons | Resolutions, confidence values, scores, the self-report, retired rules of the owner |
| Consolidation and review (Sonnet 5.5 daily, Opus 5.5 weekly) | Post-mortems, hypotheses, traps, patterns, lessons, dossier notes, status proposals | Past predictions, past trades, measured numbers |
| Owner (Telegram) | Notes, ideas, corrections, lesson vetoes (/veto), source approvals (/source ok|non), identity corrections | Nothing is off-limits to the owner |
| Second brain (the owner's local model, step 3; untrusted) | In its own stores only: situation notes, triage scores, parallel probabilities, answers to /question, and since 2026-10-08 pointers to figures in Claude's texts (code judges them and writes the flags) and night proposals about the lessons (code checks the ids) | Anything else: no order, statistic, setting, lesson, hypothesis or edit of a stored text; a proposal is applied only by Claude or the owner with the existing tools |

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
| `trader_trades` (implemented, step 4 B) | asset, opened_at, closed_at, quantity, entry_price, exit_price, fees_eur, pnl_eur, pnl_pct, open_order_id, close_order_id, close_reason (model / stop), thesis | One per sale, append-only. `pnl_eur` and `pnl_pct` are stored before the purchase fee (proceeds − sale fee − quantity × entry price, the entry price being the fill price); `fees_eur` holds the purchase fee share plus the sale fee. Since 2026-10-09 every reader goes through portfolio.ts, which subtracts the purchase share (`fees_eur` minus the sale order's fee): a trade's result, win rate, mean trade %, summaries, the pack and the consistency check's facts are after every fee, and stored rows are never rewritten. The model writes one `trade` reflection per closed trade. |
| `trader_position_updates` (implemented, step 4 B) | asset, at, field (invalidation / horizon_until), old_value, new_value, reason, by (model / code) | Every change to a position's levels, with the model's reason or code's (a stop clears the level); append-only. |
| `trader_portfolio_days` (implemented, step 4 B) | day, at, cash_eur, positions_eur, equity_eur, contributed_eur | One equity snapshot per UTC day (first tick), for returns, drawdown and the evening summary's daily change; append-only. |
| `trader_decisions` (implemented, plan of 2026-10-08 step 1) | made_at, asset, action (buy / add / hold / reduce / sell / stay_out), reason, price, position_eur, equity_eur, order_id | The model's stated decision per followed asset (`record_decision`), due when none was recorded in the last 8 hours (the loop adds the instructions; not on the evening turn), at most one per asset per hour, reason in French checked for prompt-boundary patterns. Code stores the market snapshot; outcomes at 24 h and 7 d are computed by code from stored prices (right side of the move or not, fees aside; staying out is scored like the others). Since 2026-10-09 the fees count where a score means profit: a buy or add is profitable at 7 d only beyond the round-trip break-even move (taker fee and configured slippage on both legs, about 1.72 %), and a rise after staying out is a missed gain only beyond it (beyond 0 after a sale). Append-only; counts as progress for guard G3. |
| `trader_prediction_snapshots` (implemented, plan of 2026-10-08 step 1) | prediction_id, price, distance_pct, daily_vol_pct, sigmas, ref_probability, historical_share, historical_windows | Code's odds when a prediction is recorded (src/trader/snapshot.ts): distance to the threshold in % and in units of the 30-day daily volatility over the horizon, a reference probability from a driftless random walk at that volatility, and the share of past windows of the same length (up to two years of daily closes) that moved that far. The same odds are readable before a prediction with `market_odds`. Shown with each resolution in the pack (post-mortems quote them) and used for the skill score (1 − Brier / reference Brier) in the self-report and `/bilan`. Append-only. |
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
| `trader_universe` (implemented; rules of 2026-10-08 step 2) | asset, kraken_pair, action (follow / unfollow), reason, recorded_at | The watch list (decision 0003): the owner's core is the config's assets (since 2026-10-08: BTC, ETH, gold PAXGEUR, the dollar USDCEUR, the tokenized stocks SPYxUSD and NVDAxUSD), which only the owner removes (config, or /actifs non for a satellite); Sonni rotates at most 3 satellites: a Kraken EUR pair or tokenized stock (matched without case, Kraken's spelling kept) traded at least 250,000 EUR a day, kept at least 3 days, not taken back within 7 days of dropping it or 30 days after the owner's veto (an unfollow whose reason starts with "veto du propriétaire"). Every change has a reason, append-only; the followed set is the config plus this log replayed. The owner's configuration keeps authority: at startup code compares the configured assets with the previous start (KV `sonni.config_assets`) and logs a follow for an added asset, a follow with the new pair when the owner corrects the pair of an asset an older follow entry carries, and an unfollow for a removed one; a removed asset with open predictions stays followed until they resolve (retried at the next start), and the last followed asset is never dropped. |
| `trader_fx`, `trader_fx_daily` (implemented, step 2) | ts or day, eurusd | Kraken's EUR/USD rate (dollars per euro) at each price collection and per day. Tokenized stocks are USD-quoted on Kraken (asset class `tokenized_asset`); code converts their prices and daily candles to EUR at the rate of the same collection or day (the closest earlier day for gaps), and stores nothing in dollars: without a rate a USD asset is skipped with an error. |
| `trader_screen` (implemented, step 2) | screen_id, at, asset, pair, volume_eur, ret30_pct, ret90_pct, above_ma50, vol_pct, corr_btc, max_corr, max_corr_with, score | The weekly screen computed by code (src/trader/screen.ts, first run an hour after a start, then every 7 days, no inference): Kraken's liquid EUR pairs and tokenized stocks Sonni does not follow (stablecoins out, at least 250,000 EUR a day, the 15 most traded measured from their daily history on traded days), ranked by 1 − the highest absolute correlation with a followed asset over 90 days. Shown in the pack ("Your universe", 4 rows; `sonni_memory {"section": "universe"}` for 15) and in /actifs (5 rows). Append-only. |
| `trader_brain_jobs` (implemented, step 3) | kind, priority, dedupe_key, payload, created_at, not_before, not_after, status (queued / leased / done / failed / expired), attempts, lease_until, result, error, model | The second brain's work queue on the VPS (src/trader/brain.ts). One job at a time by priority (the owner's question, news triage, parallel predictions, the situation note, the devil's advocate, post-mortem facts, then since 2026-10-08 the checks of Sonni's own memory in src/trader/brainchecks.ts: `upkeep` at 7 once per local night from 01:00; `consistency_check` at 8 for each text Claude wrote in the last 24 hours with a figure and a unit, queued once per text and valid 36 hours, and at 9 for older texts never checked or whose check expired with the PC off (at most 3 tries per text), from 01:00 to 05:00 local, at most 40 a local night counted by the night's date; both night kinds valid until 30 minutes before the evening consolidation, 19:00 by default; planned at most once a minute; a well-formed answer whose items code rejects is a done job, `result.code` holds code's counts and a `skipped` key from the PC is dropped; these two kinds are left out of the confirmation counter below, since an empty answer is a valid one); each job is queued once (dedupe key), dropped when its window passes, and leased while the PC works on it: an answer that never came back returns the job to the queue (backoff one minute per attempt, failed after 3); at a start every lease is released. Only an answer that passes code's checks is stored, and only once. `model` is the model the PC said it served (its /models list, read at each health check): /cerveau counts the done and failed jobs of the current model and calls it confirmed at 50 done with under one failure in ten; a failure counts only when the PC answered and code could not use the answer (unreadable, cut at the token limit, refused by code's checks), never for an outage (network, timeout, refused key, HTTP error, lost lease: `model` stays empty). `/cerveau recompter` (owner only) makes the counter start from that moment (KV `sonni.brain_evidence_since`, shown in /cerveau, recorded as a `brain_recount` incident); earlier jobs stay. Rows are never deleted. |
| `trader_brain_outputs` (implemented, step 3) | job_id, kind (briefing / counter_case / postmortem_brief / answer / consistency / consistency_past / upkeep), subject, content, at, model | Since 2026-10-08, `consistency` and `consistency_past` rows are flags composed by code: Claude's own words (a verbatim quote code found in the text) and code's labelled figure for the moment the text was written, kept only when code reads a gross error (unit, anchor word, comparators, tolerance, a figure the claim matches clears it; at most 3 per text); the live ones are in the pack for 48 hours ("Numbers to correct"), the night ones on the evening or weekly wake. `upkeep` rows are night proposals (merge, conflict, a lesson resting on a hypothesis code finds refuted) whose ids code checked, with a reason of at most 200 characters, shown only on the evening or weekly wake while the ids are still active, never applied by code, not repeated within 7 days. What the second brain wrote, in French, as untrusted data: the situation note shown at a wake when under 90 minutes old (`SECOND BRAIN NOTE`, rated by Claude with `brain_note_useful` in `record_decision`), the case against each open position (pack, under the position, 36 hours), the facts of a post-mortem still due (pack, under the waiting post-mortems), the answers to the owner's /question (sent by Telegram). Plain text, bounded, prompt-boundary patterns refused. Append-only. |
| `trader_brain_triage` (implemented, step 3) | observation_id, relevance, impact, novelty, note, would_wake, at, model | The second brain's scores for each observation of the last 6 hours (0 to 1, clamped by code). `would_wake` marks impact ≥ 0.8 and relevance ≥ 0.7: recorded only (shadow) unless the owner sets `secondBrain.triageWakes`, and then at most 4 wakes a UTC day, an hour apart. Feeds the situation note. Append-only. |
| `trader_brain_predictions` (implemented, step 3) | prediction_id, probability, reason, at, model | Parallel mode (/cerveau parallele): the second brain's own probability for each of Claude's predictions, asked within the hour without seeing Claude's answer; both are scored by code at resolution (/cerveau, /bilan). A question it could not answer in time is simply absent. The score counts only the model the PC serves now, so a model change starts afresh. Delegation needs at least 100 scored with a Brier score within 0.01 of Claude's, and the owner's decision. Append-only. |
| `trader_identity` (implemented) | version, content, reason, source (seed / model / owner), recorded_at | The model's self-description, in French, seeded by code; a new version per revision (at most one model revision per day, anchor words kept), never edited. |
| `trader_sources` + `trader_source_log` (implemented) | id, label, url, metrics (JSON paths), every_minutes, key_env, origin (catalog / model), status (enabled / disabled / proposed / rejected), reason, failures | Data sources polled by code (src/trader/catalog.ts). The model enables, disables or proposes one with a reason; the owner approves or rejects proposals (the proposal shows the exact URL); every action is logged append-only. At startup a catalog row whose label, URL, metrics, cadence or key changed in the code is updated in place, keeping its status and reason and resetting its failure count. Requests use HTTPS, refuse redirects and keep only the declared numeric paths; 20 failures in a row disable a source and the owner is told. |
| `trader_watches` (implemented) | kind (price / move / time), asset, direction, value, window_hours, due_at, note, expires_at, fired_at, cancelled_at | Conditions the model asks code to watch; fire once; the condition cannot be edited. |

Semantic and procedural records are bi-temporal, an idea taken from Graphiti (docs/RESEARCH.md):
`valid_from` / `valid_to` say when the belief held in the market, `recorded_at` when the agent wrote it.
A superseded belief is closed with `valid_to`, never deleted, so the agent can see how its views changed.

### 3.3 Procedural: how it works

| Store | Key fields | Notes |
| --- | --- | --- |
| `trader_lessons` (implemented) | text, evidence (prediction and hypothesis ids), status (active / retired), recorded_at, retired_at, retired_by (model / owner), retire_reason | Active lessons are in the cached part of every system prompt. A lesson needs at least one existing piece of evidence, at most 3 per day and 40 active; retired once, never deleted; the owner vetoes with /veto. Lessons change one at a time (add, retire), never rewritten as a whole (ACE, docs/RESEARCH.md 5.1). |
| `trader_lesson_uses` (implemented, step 4) | lesson_id, subject_kind (prediction / decision), subject_id, at | The active lessons a prediction or a decision cited (`lesson_ids`, at most 5, unknown and retired ids dropped). Code scores each use once the outcome is known: a prediction helped when its Brier score beat code's reference (its snapshot), a decision helped when the next 7 days proved it right (src/trader/lessonuse.ts). The counts are in the memory pack ("Your lessons in use"); a lesson used at least 6 times that hurt twice as often as it helped is flagged EVIDENCE AGAINST in the cached prompt and in /lecons ("les faits la contredisent"), and the evening instructions ask Sonni to retire it or say why it still holds. The prompt shows each lesson's market regime when it was learned (BTC's trend and volatility, code). Append-only. |
| `trader_summaries` (implemented, step 4) | period (day / week / month), start_day, end_day, content, sources, recorded_at | Summaries of finished UTC days, ISO weeks and months, written once by code (src/trader/summaries.ts, hourly task, no inference): each followed asset's move, predictions made and resolved with the Brier score against code's reference, decisions, orders and closed trades, the portfolio's result net of contributions, lessons added and retired, journal entries and the owner's notes; in French, with the ids it counted (`sources`, the first 12 also in the text). A period where nothing happened has none. Indexed for search. Append-only. |
| `trader_memory` (implemented, step 4) | kind, ref, asset, at, text (FTS5, `unicode61 remove_diacritics 2`) | A derived full-text index of every store above (lessons, journal, dossiers in all versions, hypotheses, traps, the owner's notes, model orders' theses, decisions, observations, second-brain notes, identity versions, summaries), fed incrementally by rowid high-water marks before each search; a hypothesis's French wording, added later by a reader, is indexed when it arrives, and a search lists each memory once. Not a source of truth: it can be dropped and rebuilt from the stores. |

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
| Check numbers (2026-10-08, src/trader/brainchecks.ts) | After each text with a figure; older texts at night | Second brain (points) and code (judges: the number next to the fact's unit, an anchor word near it, forecasts and targets dropped, bounds and negations read, the sign only for moves) | The text and code's figures at its time | flags in `trader_brain_outputs`, shown in the pack 48 h while the second brain is configured and not off; Claude corrects them in its evening note |
| Night upkeep (2026-10-08) | Once a night from 01:00 local, until 30 min before the evening turn | Second brain (proposes) and code (checks ids; the reason is plain words, no figures, ids or quotes) | Active lessons, code's counts, hypotheses code finds refuted | proposals shown with code's counts on the evening and weekly wakes only (not searchable, nothing when the second brain is off); Claude acts on one at most |

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

The model can then search further with `search_memory` (step 4, below). No embeddings and no vector
database: structured keys plus FTS5 are enough at this scale and cost nothing per query (measured below).

Memory v2 (step 4 of the plan of 2026-10-08, built): three levels.

- Vital, always present: the identity, the active lessons (with the regime they were learned in and, when
  the facts contradict one, its flag) and the rules, in the cached part of the system prompt.
- Situational, chosen by code for this wake: the memory pack above, with since step 4 the market regime and
  the five most similar past days per asset (src/trader/analogs.ts: standardized 1-, 7- and 30-day returns,
  30-day volatility and distance to the 50-day average; at least a week apart; only days whose next 7 days
  are stored, the outcome embargo; with the median move that followed) and the lessons in use with code's
  counts.
- Archive, searched on demand: `search_memory` (free) ranks the full-text index by BM25 × importance ×
  recency. Importance: lessons 1.5, the owner's notes and traps 1.3, dossiers 1.2, summaries 1.1, journal,
  hypotheses, decisions and orders 1, identity 0.8, observations 0.7, second-brain notes 0.6 (untrusted
  text counts less). Half-life in days: observations 3, second-brain notes 7, decisions and notes 30, orders
  60, journal 90, summaries 180, hypotheses 365, lessons, traps, dossiers and identity never fade. An older
  dossier or identity version weighs 0.3, a retired lesson 0.4. Words are folded (accents, case, a final
  plural "s"), matched by prefix from 4 letters, French and English filler words dropped, and passed to
  SQLite as quoted terms only. Filters: asset, period (a bare "until" date includes its day), kinds. Every
  hit carries its kind, id, date and asset, and observations and second-brain notes are marked UNTRUSTED.
  The owner's `/memoire` and the second brain's `/question` context use the same index (labels in French,
  no identifiers); Money Lab's `recall` takes Sonni's hits from it ahead of files.

Recall evaluation (step 4, src/__tests__/trader/memory.test.ts): a realistic memory of 24 items and 16
questions an owner or Claude would ask, each with the memories that answer it. The answer is in the
first three hits for 16/16 questions with the new search, 11/16 with the keyword recall it replaced, which
missed "baisse des taux de la Fed" (filler words outranked the active lesson), "liquidations" (plural),
"piège FOMO" (a trap's name was not searchable), "que pense sonni du dollar" (filler words) and "bitcoin
ETF inflows" (observations were not searchable). Three paraphrases (same meaning, other words or another
language) score 0/3 with both: that is the gap a semantic index would close, built only if real use shows
it matters (decision 0005).

Implemented pack (step 3, src/trader/pack.ts), within 9,000 characters, in order: what happened
since the previous session (triggers, resolutions, new headlines and observations, computed by code);
prices and changes; the owner's notes of the last 7 days (trusted); the virtual portfolio (step 4 B: cash, positions with stop, horizon and thesis,
pending orders, the last 24 h of settled orders, closed trades waiting for a post-mortem, the names of
the traps; since 2026-10-08 the big-order threshold); the latest decision per followed asset with code's
24 h score and the assets due a decision; open predictions (15); recent resolutions (6, each with code's
odds at the time and the reference's Brier), with the ids still waiting for a post-mortem; since 2026-10-08
the numbers to correct (wrong figures code found in Claude's texts of the last 48 hours, at most 3, only
when there are some); open watches;
the self-report (calibration, Brier by asset, horizon and direction, skill against code's reference for
all, the last 7 days and the 7 days before, decisions of the last 7 days, lessons added and retired,
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
system prompt. Before step 4, `recall` and `/memoire` searched the identity, reflections, lessons,
hypotheses, dossiers, traps, notes and order theses by terms; since step 4 both use the full-text index
above.

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
- Backups (src/money-lab/backup.ts, guard G7): once a day, a self-contained copy of state.db
  (rollback journal, not WAL) in `~/.automaton/backups`, reopened and checked before it counts; the
  last 7 are kept. Fixed 2026-10-08: copies used to be in WAL mode like the live database, the
  read-only check left `-wal`/`-shm` files beside them, the rotation counted those and only about
  three days were kept; leftover files are cleaned at the next backup.
- Off-site copy on the owner's PC (step 3, guard G14, sonni/GUIDE-PC.fr.md part 6): each night the
  VPS exports the newest copy as the `sonni` user (sonni/vps/export-backup.mjs, timer at 02:30 UTC)
  after reopening it (`integrity_check`, Sonni's stores present) with its SHA-256, into a folder that
  a chrooted, read-only, key-only SFTP account reads from the tailnet only; the PC
  (sonni/pc/backup-pull.ps1) fetches only names like a daily copy, keeps it only when the SHA-256
  matches, keeps 30 days and logs a failed or stale night. Restoring is a manual step with the
  owner.

## 8. Owner view and hygiene

- Weekly export to `~/carnet/` as Markdown (implemented, step C1, src/trader/notebooks.ts: every
  Sunday in the owner's time zone and on `/carnets`, files rewritten whole from the stores):
  `journal.md`, `intuitions.md`, `pieges.md`, `lecons.md`, `identite.md`, `portefeuille.md`, one file
  per followed asset (dossier versions, predictions, closed trades), and `cycles.md` (step C2).
- Size caps per store; duplicates merged at weekly review; hypotheses untouched for 90 days retired
  with a reason, never deleted. Since 2026-10-08 the second brain proposes lesson merges and
  retirements at night; only Claude (one change at most, on the evening or weekly wake) or the owner
  (/veto) acts on them, and /cerveau counts the proposals followed by a retirement.
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
- Semantic search: keyword search misses paraphrases (0/3 in the step 4 evaluation). Revisit with real
  misses from `/memoire` and `search_memory` before adding embeddings (sqlite-vec, computed on the owner's
  PC; decision 0005).
- Confidence thresholds (8 instances, 0.65 / 0.35): proposal, to confirm with the owner.
- Whether daily consolidation needs Opus or Sonnet is enough: decide on measured quality.
