# Working status
- Updated: 2026-10-08
- Branch / commit: main after PRs #20 to #28 (plan of 2026-10-08, steps 1 to 4, field fixes, /cerveau recompter, Likma 0.13.0); claude/sonni-brain-coherence-night holds the second brain's memory checks below
- Likma 0.13.0 and agent posture (2026-10-08, branch claude/stoic-hawking-cpjn87), mirroring Money Lab 8e81318:
  `project upgrade` 0.10.1 -> 0.13.0 (AGENTS.md Likma block, docs/LIKMA.md); removed the unused direct dependency
  simple-git (its 2 critical advisories are fixed only in 3.32.3/4.x; nothing in the repository imports it); new
  `deps` check (`pnpm audit --prod --audit-level critical`: 0 critical, 9 high and 17 moderate remain, transitive);
  TruffleHog secret scan in CI (.github/workflows/secrets.yml, pinned v3.97.0); Claude Code deny rules for .claude/,
  .git/hooks/, .mcp.json, .env*; `agent_isolation` records that the Claude Code sandbox cannot run in cloud
  containers or on Windows and that Sonni runs as the separate `sonni` user on its VPS. Checks after the change
  (likma project check): types, sonni, money-lab, build, sonni-e2e (589 s) and deps pass. After merging main (PR #25,
  second-brain field fixes) the 15 stale features were re-verified (`project feature reverify`: build, sonni-e2e,
  sonni, money-lab) and types and deps pass again.
- Likma migration (2026-10-07, branch claude/affectionate-bohr-nyhhv3 from main eb71a19): Likma 0.7.0 -> 0.10.1,
  profile `bot` (was the snapshot's `ai-product`); checks in object form with timeouts, `sonni-e2e` requires
  `build`; setup `install`; budget 240 min; `bot_guards` maps the 8 Likma guard classes to guards.test, the
  Money Lab suites and sonni/e2e.mjs (docs/GUARDS.md stays the detailed map); merge driver (.gitattributes),
  Likma audit workflow (.github/workflows/likma-audit.yml, secret LIKMA_REPO_TOKEN) and Claude Code hooks
  (.claude/settings.json, need the `likma` command on PATH).
  - Test fixes found by the re-verification (no runtime change): sonni/e2e.mjs read the first matching Telegram
    message, so after 20:00 Paris the automatic evening summary was taken for the /journee reply; it now reads
    only replies after each command. A run started within 12 min of Paris midnight scheduled the evening
    consolidation at 00:0x, already due before midnight; the e2e now waits for the new day. dossiers.test.ts
    expected the literal date "mer. 7 oct." for a dossier and a note written at the real current time.
  - `likma project feature reverify` (report .likma/checks/2682ffc4870049c186866b1fc52a60c6.json): build pass;
    sonni-e2e PASS (68 checks, 564 s); sonni 122/122; money-lab 110/110; all 13 features verified with
    fingerprint v3 evidence. `likma project check --only types`: pass. `likma project audit`: 0 failures.
  - Feature scopes are still broad (src, sonni): any source change makes every feature stale; reverify keeps
    that cheap, narrowing scopes per feature is a follow-up.
- Current goal: step 3 "Sonni alive" built on the owner's request of 2026-10-06 ("as alive as possible:
  consciousness, finds its own tools, free AIs for information, all of A to D"). First slice live on the
  owner's VPS since 2026-10-06 22:12 UTC (steps 1 and 2 not deployed there yet: see "Next concrete action").
- Accepted decisions: 0001 (owner direction), 0002 (start from Money Lab), 0003 (capital, data, assets,
  readiness measures; thresholds to be set after the first months of results), 0004 (dedicated VPS), name Sonni.
- Completed behaviour (first slice, docs/FIRST-SLICE.md):
  - Money Lab imported verbatim at 2c5580ac18bc49dcb133dafef7cdb8b06d0399e5 (separate commit).
  - src/trader/: strict `trader` config block; Kraken public price collection every collectMinutes;
    hypotheses with confidence computed by code; record_prediction refused on stale prices or missing
    fields; append-only predictions and evidence (SQLite triggers); resolution by code at the horizon
    (Brier score, evidence, or void when no price exists in the window); memory pack tool; Sonni
    mission, rules and weekly review replacing Money Lab's; Money Lab web-business tools denied;
    French /statut, /idee, /intuitions on Telegram and `--sonni` CLI.
- Step 1 built (2026-10-06): Kraken daily candles (720 days) refreshed every 6 h; test-rule language;
  historical tests by code (30 cases, z >= 2.33), append-only; propose_hypothesis tool with origins and
  daily limit; intake on Opus for 8 turns until 30 prior hypotheses (3 attempts max, counted on paid
  turns); historical verdicts in the memory pack, /statut and /intuitions. Live check (read-only, no
  key): 720 days for BTC and ETH; "BTC rebounds the day after a -3 % day" scored 19/47 = 40 % vs 51 %, refuted.
- Step 2 built (2026-10-06): event calendar (FOMC from federalreserve.gov, parsed live: 56 decision days
  2021-2027; CPI and jobs from FRED with an optional FRED_API_KEY), GDELT headlines hourly, event
  conditions in test rules, reactions to past events in the memory pack, /agenda.
- Step 3 built (2026-10-07, "Sonni alive", src/trader/soul.ts, curiosity.ts, readers.ts, pages.ts,
  sources.ts + catalog.ts, universe.ts; docs/MEMORY.md updated):
  - A. Identity (versioned, seed by code, one model revision per day, anchor kept), journal
    (append-only; post-mortem once per scored prediction), lessons with evidence ids (3/day, 40 active,
    retired by the model or by /veto), self-report computed by code (calibration buckets, Brier by
    asset/horizon/direction, spend) in the pack and /bilan; reflection instructions on the first wake
    after a scored prediction, marked done by code after a paid turn; identity and lessons in the cached
    part of the system prompt, rules block last.
  - B. Curiosity: code triggers every minute (3 % move in 1 h, event day 07:00 UTC, morning after 06:00
    UTC, resolved predictions every 6 h at most, model watches: price level / move over a window / date),
    logged delivered or not; at most 6 self-wakes per UTC day, 30 min apart, only while sleeping, unpaused
    and not on a budget cap; Sonni's own wake events now end a Money Lab sleep (the step-1 `sonni_history`
    intake wake was being ignored by `isOperatorWake`: fixed); /reveils.
  - C. Catalog of free sources polled by code by JSON path (Fear & Greed, CoinGecko global, Kraken BTC
    order-book top, mempool fees enabled by default; DefiLlama ETH TVL, FRED fed funds / 10 y / CPI with
    the owner's key available), enable/disable/propose by the model with reasons, owner /source ok|non,
    auto-disable after 20 failures with a Telegram notice; read_page (https only, public hosts, 1 MB,
    12 000 chars, 20/day, untrusted); follow_asset/unfollow_asset checked against Kraken's EUR pairs,
    logged, used live by every tick, tool, pack and status (/actifs).
  - D. Readers: OpenAI-compatible free models (example config: Gemini via Google AI Studio, Groq) with
    sealed keys, per-day caps, resting after errors, fallback order; hourly digest of headlines into
    validated observations (assets, kind, sentiment, summary, event date; prompt-boundary patterns
    rejected; untrusted); page summaries; observations per asset with code-averaged sentiment in the
    pack; /lecteurs. Without a key, headlines stay raw as before.
  - Prompt and cost: automaton survival/orchestration layers and status removed from Sonni's prompt;
    Automaton soul/memory/relay tools denied; Automaton memory retrieval and ingestion skipped for
    Sonni; the volatile rules block is the last system text so the tool list and the mission are cached.
  - Checks (run 2026-10-07, this sandbox): typecheck PASS; sonni suite 82/82 (sonni 20, knowledge 13,
    world 9, soul 9, curiosity 8, readers 9, sources 8, alive 6); money-lab suite 110/110; build PASS;
    sonni-e2e PASS (35 checks, about 4 min: fake Kraken, Anthropic, Telegram, reader and sources;
    self-wake after a 4 % move observed end to end). The Likma runtime run opened for the build and the
    recorded check session opened for steps 1-2 (all attempts passed) both reached their 60-minute
    limit before the final `project check`; the run was ended with its summary and a new run and a new
    check session were begun deliberately for the verification phase (no failure budget was evaded;
    the previous session is archived under .likma/sessions/). Likma `project check` (types, sonni 84,
    money-lab 110, build, sonni-e2e 263 s): PASS, 2026-10-07 01:09 UTC after the review fixes, report
    .likma/checks/36ce9c9dbfad44fb9fb7fa670d4448b0.json (an earlier PASS before the fixes:
    5df38e141a1a4b4cb3b4eed392df5069). Feature verifications: see docs/FEATURES.md.
  - Checks after the second review round (run 2026-10-07, this sandbox): typecheck PASS; sonni suite
    91/91 (sonni 20, knowledge 13, world 9, soul 10, curiosity 10, readers 12, sources 9, alive 8);
    money-lab suite 110/110; build PASS; sonni-e2e PASS (37 checks, 263 s, including the history wake
    for the intake). The recorded check session begun at 00:44 UTC reached its 60-minute limit with
    10 attempts, all passed; it was archived and a new one begun for this verification (no failure
    budget evaded). Likma `project check`: PASS at 04:07 UTC (report
    .likma/checks/3ed267e76fc84166a9a01f85c9c2d6b3.json) and, after the pair-correction fix, PASS at
    04:13 UTC (report .likma/checks/44f6f681d44f4f4aa7cc811f134a9b44.json). The new pair-correction
    test was confirmed to fail without the fix. CI on PR #5: green through 5a71cdd.
  - Owner's update on the VPS (2026-10-07, 06:32 Paris): /lecteurs answered "Aucune IA lectrice
    configurée", i.e. the new code ran with the old config (the configure.mjs step was skipped or run as
    root). configure.mjs now says "Mise à jour" on later runs instead of asking for the month's budget
    again (which would have funded the month twice) and warns when run as root; the guide says how to
    check the readers line; the e2e re-runs it. Likma `project check` PASS (report
    .likma/checks/00293b38e9f4469c90a31db9d0aec3f1.json).
  - Likma upgraded to 0.7.0 (system checkout fast-forwarded to 902f3e9, `validate` and its 112 tests
    pass): `project upgrade` wrote the managed block in AGENTS.md (routine and ai-product skill index,
    which now lists agents/autonomous-agents) and docs/LIKMA.md; `commands.start_disabled` records why
    no start command exists; the seven features are scoped to the code they depend on (src, sonni,
    constitution.md, package and build files), so documentation edits no longer make evidence stale,
    and were re-verified under fingerprint v2 (see docs/FEATURES.md).
  - Research by web agents (2026-10-07, reports kept in the session scratchpad, conclusions applied):
    free LLM APIs: Gemini free tier is the primary reader (`gemini-3.5-flash-lite`; limits no longer
    published, EEA users get the no-training terms; auth keys since May 2026), Groq free plan the
    fallback (`openai/gpt-oss-20b`, 1K requests and 200K tokens per day per model, no Llama models any
    more; cap set to 80 calls/day), Cloudflare Workers AI, Mistral Free and OpenRouter documented as
    later options; GitHub Models retired, Cerebras needs a card. Free data APIs: every catalog entry
    verified live (alternative.me, CoinGecko global keyless, Kraken Depth, mempool.space, DefiLlama,
    FRED), two keyless derivatives sources added disabled by default (Kraken Futures BTC funding and
    open interest, OKX funding), FRED attribution printed by /sources. The two other research tasks
    (agent liveness patterns, reader safety checklist) were lost in a container restart and not
    re-run: the design already follows the project's own rules (observations only, validation,
    caps, public hosts); nothing from them is claimed.
  - Adversarial review (five reviewer agents over the diff, 2026-10-07): 14 findings, 13 fixed with a
    test each (model-proposed sources followed redirects; the owner never saw a proposed source's URL;
    reader keys could be sent to any https host named in the editable config; watch notes and reasons
    unchecked; raw page title stored unchecked; provider bodies in error texts; identity text could forge
    the runtime's prompt sections; the "resolved" trigger re-fired after 6 h on a timestamp-precision
    mismatch; the move trigger re-fired on stale prices; the startup tick wasted a wake; a GDELT error
    skipped the digest; digest capacity below the headline inflow; intake checked on the base config in
    the loop). Not fixed, documented: the agent's shell runs as the same OS user as the runtime, so it
    could edit state.db or the config (known limitation, AGENTS.md; a second OS user is deployment work
    for the real-money phase).
  - Second round (the review's other candidates, checked by hand against the code because its verifier
    agents stopped on a session limit), each with a test: the memory pack exceeded the runtime's
    10,000-character tool-result cut, so open predictions, watches and reflections were never seen (now
    9,000 characters, Sonni's own state first, cuts announced, `sonni_memory {"section"}` for detail);
    pages read were invisible in the pack; void predictions could get a post-mortem; Sonni's own writes
    did not count as work, so a forced end of cycle restarted a paid cycle within two minutes (now 15
    minutes); self-wakes ignored the long sleep after cycles without progress; the progress fingerprint
    counted the owner's writes; failed page reads escaped the daily cap; catalog changes never reached
    existing rows; a prediction scored during a reflection turn was skipped by the next reflection
    (marker `sonni.reflection_upto`); removing an asset from the config had no effect once Sonni had
    followed assets (the config now keeps authority, open predictions are respected, a pair corrected in
    the config replaces the one an older follow entry carries); the owner could
    not write the identity (`/identite <texte>`, refusals in French); the e2e never exercised the
    history wake (the fake Kraken now holds the history until the startup cycle sleeps, and the test
    requires a `sonni_history` wake for the intake); MEMORY.md still described a Haiku ingest.
- Known gaps (deliberate, later slices):
  - Monthly budget pacing is approximated by Money Lab's daily cap (1/30 of the month) and funding balance.
  - Only price-threshold predictions; no virtual orders, traps or cycles yet; readiness thresholds left
    for after the first results (owner, 2026-10-06).
  - read_page checks DNS before fetching, then fetch resolves again (DNS rebinding not covered); reader
    rest state is process memory (a restart retries); daily caps count UTC days.
  - Money Lab's experiment-oriented texts remain in some owner commands (/aides, /resume).
- First live run (owner's VPS, 2026-10-06 22:12 UTC): two predictions due 2026-10-07 22:12 UTC.
- Blockers: none for code. The owner must update the VPS after merging the step 4 B PR.
- Full Likma check on 418535b's tree (2026-10-07 ~10:00 UTC): types, sonni (104), money-lab, build, sonni-e2e all PASS
  (.likma/checks/60407717f1bf4f5c82661d0c5e687513.json) after three diagnosed failures recorded with `project attempt`
  (reader-call ordering in a test, e2e fill timing, fill wakes blocking the move wake) and one deliberate new session.
- PRs #1 to #5 were merged into main by the owner on 2026-10-07 (05:32 to 05:38 UTC, merge commits);
  main now carries the whole of Sonni and the guide points the VPS at main.
- Step 4 A (clarity, owner's request of 2026-10-07 after reading /statut): `/statut` rewritten as four
  blocks in French and Paris time without identifiers (src/trader/status.ts, format.ts), the budget
  read from the ledger (`budgetView`), `/technique` for Money Lab's technical state, Sonni's morning
  report replacing the health report as the daily message (src/trader/report.ts: yesterday, today,
  alerts only when real: pause, no session in 26 h, cap exceeded, owner message stuck, a task failing
  12 times in 24 h and still, no reader available with headlines waiting), hypotheses written in
  French by the model and translated for display by a reader otherwise (`statement_fr`, set once,
  checked like any reader output), `trader.timeZone` setting. Tests: src/__tests__/trader/clarity
  (6) plus updated status assertions. PR #10 (draft) carries it.
- Step 4 B (virtual portfolio, owner's order of 2026-10-07: "A then B, keep 30 %, a summary each evening
  or a precise Telegram command, build everything"): src/trader/portfolio.ts paper broker (funding at
  the first price and monthly, orders checked by code and filled at the next price with Kraken fees and
  spread slippage, limit orders, expiries, stops placed by code at the invalidation level, horizon
  wakes, trades with P&L after fees, daily snapshots, performance incl. the self-funding ratio, traps
  with hits), tables in schema.ts (settle-once trigger on orders, append-only elsewhere, the
  reflections table rebuilt once for the `trade` kind), tools place_order / cancel_order /
  manage_position / note_trap, pack sections, prompt, curiosity triggers (stops and expiries, horizons; a plain fill waits for the next session),
  trade post-mortems in the reflection cycle, `/portefeuille`, `/journee` and the evening summary at
  20:00 local (telegram.ts), `/bilan` with the three proofs of decision 0003, `brokerTick` after each
  collection (index.ts), configure.mjs writes `portfolio.eurUsd`. Tests: src/__tests__/trader/portfolio
  (5), e2e places and fills a 100 EUR BTC order and checks /statut, /portefeuille, /journee.
- Guards (owner's decision of 2026-10-07, docs/GUARDS.md): G1 no shell/file/installer/git/sub-agent tool
  for Sonni (SONNI_DENIED_TOOLS), G2 and G3 verified as Money Lab's existing guards (unknown cost pauses,
  no-progress sleep; the model's orders now count as progress), G4 `portfolio.maxOrdersPerDay` (10), G5
  truncated answers never run their tool calls and unknown stop reasons pause (loop.ts), G6 page-injection
  test, G7 backups verified (integrity, row counts) before they count, G9 incident log (trader_incidents,
  /technique, morning report). G8 chaos e2e planned with step C1. Tests: src/__tests__/trader/guards.test.ts (8).
- Step C1 (owner's decision of 2026-10-07): src/trader/dossiers.ts (versioned asset dossiers, one model
  revision per asset and day; the owner's trusted notes), src/trader/notebooks.ts (Markdown notebooks in
  ~/carnet every Sunday and on /carnets), tool update_dossier, pack sections dossiers and notes, recall
  over dossiers, traps, notes and order theses, commands /dossier, /note, /memoire, /carnets; G8 chaos
  scenario in the e2e (3 API 529s, Telegram and Kraken down 40 s, owner message handled once). Tests:
  src/__tests__/trader/dossiers.test.ts (6). The e2e now takes ~9 min (check timeout 900 s).
- Step C2 (owner's decision of 2026-10-07): src/trader/cycles.ts measures reactions once per past event,
  asset and window (run-up, day, week, first hour from 5-minute prices) after each history and calendar
  update (trader_reactions), the model names cycles (name_pattern, trader_patterns) whose cases, base
  rate, z and verdict code computes on display; pack section for the events due within 7 days (detail
  "cycles"), /cycles, cycles.md. Tests: src/__tests__/trader/cycles.test.ts (3); e2e: a past Fed day in
  the fake calendar, a cycle named in the session, /cycles.
- Step C3 (owner's decision of 2026-10-07): src/trader/consolidation.ts (due from `trader.consolidation`
  19:30 local once per local day, own wake event `sonni_evening` under the usual gate, pending marker
  dropped after midnight, done only after a paid turn), SONNI_EVENING_INSTRUCTIONS in prompt.ts, loop
  hooks, the evening summary line and the day's note. Tests: src/__tests__/trader/consolidation.test.ts
  (2); e2e: the consolidation scheduled 7 min into the run, delivered as a wake, /journee shows it.
- Budget guards G10 (owner's agreement of 2026-10-08 after the VPS costs of 2026-10-07: 13 restarts
  about 0.96 $, the productive session about 0.49 $, idle wakes about 0.33 $; calls of 38k to 49k tokens;
  the evening wake held back by the daily cap): a restart while Sonni sleeps resumes the sleep without a
  paid call unless an owner message waits (src/index.ts); 40c of the daily cap reserved for the evening
  turn, owner messages excepted, one incident a day (src/trader/consolidation.ts, src/agent/loop.ts); any
  wake after 19:30 is the evening turn until done, and the evening timer may end a no-progress sleep;
  incident times in the owner's time zone; 21 leftover automaton tools denied (measured locally: 41 -> 21
  tools, tool schemas about 6,800 -> 4,900 tokens, system 5,970 -> 5,320); history window 8 to 11 turns
  instead of 20 to 29. Tests: src/__tests__/trader/budget.test.ts (5); e2e: a restart during a sleep makes
  no paid call. Checks (2026-10-08 07:10 UTC, this sandbox, Likma project check
  6b775e3c): types PASS, sonni 127/127, money-lab 110/110, build PASS, sonni-e2e PASS (565 s). Not yet
  observed on the VPS.
- Plan of 2026-10-08 (docs/decisions/0005, owner's agreement): four steps, one PR each, observed on the
  VPS between steps: 1 decide for real, 2 living universe (PAXG, SPYx, USDC/EUR, NVDAx), 3 second brain on
  the owner's PC (assistant mode by default), 4 memory v2. Research of the day: docs/RESEARCH.md section 5.
- Step 1 "decide for real" (branch claude/sonni-decisions): src/trader/decisions.ts (a stated decision per
  followed asset every 8 hours, scored by code at 24 h and 7 d, staying out included), src/trader/snapshot.ts
  (code's odds: distance in % and in volatility units, random-walk reference, historical share; stored with
  every prediction; `market_odds` tool; skill score against the reference), src/trader/strong.ts (a buy of
  20 % of the portfolio or more is validated, held and confirmed on the stronger model within half of the
  daily cap; guard G11), the "is it learning?" scoreboard in /bilan and the self-report, decisions in the
  pack and in the G3 fingerprint, the readers test no longer depends on the real date. Tests:
  src/__tests__/trader/decisions.test.ts (7); e2e: decision instructions in the wake, market_odds, one
  decision per asset, the scoreboard in /bilan. Also fixed: the budget test of 2026-10-08 recorded its
  spend with SQLite's real clock under a fake JS clock (it failed after 10:00 UTC real time). Checks
  (2026-10-08 10:15 UTC, this sandbox, Likma project check 13d2f0f7): types PASS, sonni 134/134,
  money-lab 110/110, build PASS, sonni-e2e PASS (563 s). Not yet observed on the VPS.
- Step 2 "living universe" (branch claude/sonni-universe, after step 1): the example config's core is BTC,
  ETH, PAXG (PAXGEUR), USDC (USDCEUR), SPY (SPYxUSD) and NVDA (NVDAxUSD); src/trader/markets.ts (tokenized
  pairs need `asset_class=tokenized_asset`; USD prices and daily candles converted to EUR with Kraken's
  EURUSD, stored in trader_fx and trader_fx_daily; nothing stored in dollars); universe rules (core removed
  only by the owner, 3 satellites, 250,000 EUR a day minimum, 3-day hold, 7-day cooldown, owner veto with
  `/actifs non`, 30 days; guard G12); src/trader/screen.ts (weekly code screen of liquid pairs Sonni does
  not follow, ranked by distinctness, in the pack and /actifs); trade-day volatility in code's odds.
  Tests: src/__tests__/trader/universe.test.ts (4), sources.test universe cases rewritten, the other suites
  pinned to BTC and ETH; e2e: tokenized prices converted to EUR, the fake Kraken refuses a tokenized pair
  without its asset class. Checks (2026-10-08 10:28 UTC, this sandbox, Likma project check
  d777ac8b): types PASS, sonni 138/138, money-lab 110/110, build PASS, sonni-e2e PASS (563 s). Not yet
  observed on the VPS.
- Step 3 "second brain" (branch claude/sonni-brain, after step 2): src/trader/brainstate.ts and brain.ts
  (the owner's PC through Tailscale only: a base URL outside the tailnet is refused at config load; modes
  off / assistant (default) / parallel / delegated set with /cerveau; a VPS-owned job queue with
  priorities, dedupe keys, validity windows, leases, backoff, 3 attempts and every lease released at a
  start; jobs: news triage (shadow wakes, at most 4 a day once the owner turns them on), the situation note
  shown at wakes, the case against each open position, post-mortem facts, /question by Telegram, parallel
  probabilities scored by code; health checked every minute, an outage over 2 hours is an incident; each
  answer stores the model the PC serves (its /v1/models list) and the evidence (parallel score, delegation
  gate, "confirmed" at 50 tasks with under one failure in ten) counts only that model; delegation refused
  until 100 parallel bets within 0.01 of Claude's Brier; guard G13); the PC reads first among the readers.
  sonni/GUIDE-PC.fr.md (26 steps: Windows power and updates, BIOS, autologon, llama.cpp Vulkan,
  Qwen3.6-35B-A3B with gpt-oss-20b as fallback, a supervisor and a scheduled task, Tailscale grants that
  limit the VPS to one port, `tailscale serve`, /cerveau, the nightly memory copy, troubleshooting) with
  sonni/pc/llm-main.ps1 and backup-pull.ps1 (Windows PowerShell 5.1 syntax, ASCII). Nightly memory copy
  (guard G14): sonni/vps/export-backup.mjs with sonni-backup-export.service and .timer, a chrooted,
  read-only, key-only SFTP account usable from the tailnet only. Found and fixed while building it: the
  daily backups were WAL-mode copies, G7's read-only check left -wal/-shm files beside them and the
  rotation counted those, so the VPS kept about three days instead of seven (src/money-lab/backup.ts:
  self-contained copies, leftovers cleaned; regression test in guards.test, which fails on the old code).
  Tests: brain.test.ts (7), pc-scripts.test.ts (5; the PowerShell scripts run with pwsh when installed,
  as on GitHub's Ubuntu runners), guards.test G7 rotation; e2e: a fake PC server, no call without the key,
  triage, /question answered, /cerveau online, no Claude call, no key leak. The guide's part 6 was run as
  written on OpenSSH 9.6 (Ubuntu 24.04, this sandbox, 2026-10-08): `sshd -t` accepts the block, a key used
  from outside 100.64.0.0/10 is refused, `put` is refused, no shell, the chroot shows only `.ssh` and
  `files`, backup-pull.ps1 with the real sftp fetched an identical copy. Not testable here: parts 1 to 5
  (Windows, the AMD driver, the model's speed, Tailscale itself), to be checked on the owner's PC.
  Checks (2026-10-08 11:42 UTC, this sandbox, Likma project check 789b457a): types PASS, sonni 151/151,
  money-lab 110/110, build PASS, sonni-e2e PASS (79 checks, 590 s); features second-brain and
  pc-memory-copy verified (sonni). Not yet observed on the VPS or the owner's PC.
- Step 4 "memory v2" (branch claude/sonni-memory, after step 3): src/trader/memory.ts (one FTS5 index of every
  store, fed by rowid high-water marks; `search_memory` tool, free: BM25 × importance × recency, current
  versions first, retired lessons lower, filters by asset, period and kind, provenance on every hit and
  untrusted kinds marked; words folded for accents, case and plural, passed as quoted terms only; `/memoire`,
  `recall` and the second brain's `/question` context use it), src/trader/lessonuse.ts (`lesson_ids` on
  record_prediction and record_decision; code scores each use against code's reference or the next 7 days;
  flag after 6 uses that hurt twice as often as they helped, in the cached prompt only when flagged, counts in
  the pack and /lecons; evening instruction to retire or justify), src/trader/analogs.ts (market regime per
  asset and per lesson; the five most similar past days with the outcome embargo, in the pack),
  src/trader/summaries.ts (day, ISO week and month summaries by code with their sources, hourly, searchable);
  guard G15. Recall evaluation (memory.test): the answer in the first three hits for 16/16 questions against
  11/16 for the keyword recall it replaced; paraphrases 0/3 for both (the semantic index's revisit trigger).
  Fixed on the way: `/memoire l'or` found nothing (the English "or" was a filler word), plurals missed their
  singular, a bare `until` date excluded its own day, and a summary showed a false 0 % move for a day without a
  traded candle. Tests: memory.test.ts (12); e2e: the model's search_memory finds the dossier it just wrote,
  `/memoire Catalyseurs` (case and plural folded). Checks (2026-10-08 12:08 UTC, this sandbox, Likma project check
  c0fabd90): types PASS, sonni 163/163, money-lab 110/110, build PASS, sonni-e2e PASS (80
  checks, 591 s); feature memory-v2 verified (sonni). Not yet observed on the VPS.
- Re-verification after the four steps (Likma `project feature reverify`, report f5dcd98f, 2026-10-08 12:25 UTC,
  this sandbox, on the tree merged in main): build PASS, sonni PASS, money-lab PASS, sonni-e2e PASS (591 s); the
  15 stale features re-verified, second-brain, pc-memory-copy and memory-v2 verified the same day: every feature
  verified.
- Owner's setup, 2026-10-08 afternoon (observed, reported by the owner with screenshots): VPS updated to main
  (6 assets); on the PC llama.cpp b11500 Vulkan on the RX 9070 XT serves qwen3.6-35b-a3b (UD-Q4_K_M, 20.6 GB,
  part of it on the CPU); measured 30.6 tokens/s output and 100 tokens/s prompt with --load-mode none (13.5 and
  4 at the first answer without it); "Sonni second cerveau" task restarts it at logon (checked after a reboot;
  automatic logon declined by the owner, so after a reboot it waits for the owner's logon); Tailscale serve
  tailnet-only, VPS limited to sonni-pc:8080; key in /etc/sonni.env (rotated once the same day after it showed
  on a screenshot); /cerveau, /question and /technique answer; nightly memory copy fetched and verified once.
- Field fixes from that run (branch claude/sonni-brain-fieldfixes, feature brain-field-fixes): the first 8 real
  jobs gave 5 done and 3 failed, all triage answers cut mid-JSON (20 observations in 1500 tokens), plus one
  timeout during the PC's reboot. Found while fixing it: a failed triage batch came back first with the same dedupe key and held
  back every later triage for up to 6 hours. Now a triage job takes 8 observations with 200 + 160 tokens each, a
  failed batch is not tried again, an answer
  stopped by max_tokens is named "cut at the token limit", only answers the PC gave and code could not use
  count against the model (outages and lost leases no longer do), Markdown marks are removed from the second
  brain's texts (seen as ** on Telegram), and the supervisor starts llama-server with --no-ui (--no-webui is
  deprecated) and --load-mode none. The 3 failures already recorded stay (append-only): with 50 done they
  still allow confirmation (27 < 50). Checks (2026-10-08 15:15 UTC, this sandbox, Likma project check 03fd0bce):
  types PASS, sonni 164/164, money-lab PASS, build PASS, sonni-e2e PASS (591 s); feature brain-field-fixes verified
  (sonni, d7d53956). The new brain test fails on the old code (batch block and outage blame both reproduced).
  Merged as PR #25 (2026-10-08 15:23 UTC, GitHub CI green). Re-verification after it (Likma `project feature
  reverify`, report f2dd6a7e, this sandbox): build PASS, sonni PASS, money-lab PASS, sonni-e2e PASS (590 s); the 15
  features made stale by the shared brain and reader sources re-verified: every feature verified.
  Not yet observed on the VPS or the PC.
- Confirmation counter restart (owner's decision 2026-10-08 after the diagnosis; branch claude/sonni-brain-recount,
  feature brain-recount): the first day ended with 9 done and 9 failed, all 9 failures between 14:34 and 15:38 UTC
  under the old code (8 triage answers cut by the 1500-token budget, 1 timeout during the PC's reboot), none after
  the update at 15:46 UTC. `/cerveau recompter` makes the confirmation counter count jobs finished from that moment
  (KV sonni.brain_evidence_since); /cerveau shows the start date, each restart is a `brain_recount` incident, no
  row is deleted, the parallel score is untouched. Checks (2026-10-08, this sandbox, Likma project check 644cb442):
  types PASS, sonni 165/165, money-lab PASS, build PASS, sonni-e2e PASS (591 s); feature brain-recount verified;
  the four features sharing brain.ts re-verified (report 996cd774: build, sonni, money-lab, sonni-e2e PASS).
  After merging main (Likma 0.13.0, PR #27): project check 44d6324e PASS (types, sonni, money-lab, build, sonni-e2e
  589 s, deps); the 8 features made stale by the merge re-verified (report 64016353); audit 0 failures, 0 warnings.
  Not yet observed on the VPS.
- Second brain checks of Sonni's own memory (owner's go of 2026-10-08 after "the GPU idles"; branch
  claude/sonni-brain-coherence-night, feature brain-checks, guard G16): src/trader/brainchecks.ts. The two
  assistant tasks the plan announced but step 3 had not built: (1) consistency check: each text Claude writes
  with a figure and a unit is read by the PC next to code's figures at its time; the PC only points (quote,
  fact id, value) and code judges (passage not cut inside a number, the fact's unit next to the number, an
  anchor word near it, forecasts and targets dropped, bounds and negations, sign only for moves, every reading
  of an ambiguous number, a mis-pairing cleared by any figure written with '%'), at most 3 flags of Claude's
  own words with code's figure, in the pack 48 h ("Numbers to correct"), corrected in the evening note; older
  texts re-checked 01:00 to 05:00 local, 40 a night; (2) night upkeep from 01:00 local: lesson merges,
  conflicts and lessons resting on a hypothesis code refutes, ids checked by code, shown with code's counts
  on the evening and weekly wakes only, never applied. No wake, no statistic, no change to a stored text;
  nothing reaches Claude when the second brain is unconfigured or off; both kinds stay out of the 50-task
  confirmation. Designed by a 3-design + judge workflow; an adversarial review (5 dimensions, 2 skeptics per
  finding) confirmed 27 findings, all fixed (number bound to its unit, list dashes read as minus, cut quotes,
  forecasts, negations, expired checks never retried, the night cap overrun by seconds and the October clock
  change, a dedupe subquery bug, upkeep reasons faking code's counts, search exposure, the confirmation counter
  inflated by empty answers, a 'skipped' key hiding runs, a test making network calls), each fix shown to fail
  its test when undone. Also fixed: decisions.test failed after 19:30 Paris (real clock, evening turn took the
  wake; failing on main too). PLAN.fr.md corrected (steps merged and in service; what the second brain really
  does). Checks (2026-10-08 evening, this sandbox, Likma project check 737cdf12): types PASS, sonni 179/179,
  money-lab PASS, build PASS, sonni-e2e PASS (622 s, "the second brain re-reads the figures of Sonni's texts",
  no Claude call), deps PASS; feature brain-checks verified (f9f34850); the 18 features sharing the touched files
  re-verified (report f1d5da8f: build, sonni, money-lab, sonni-e2e PASS); audit 0 failures, 0 warnings. Not yet
  observed on the VPS or the PC:
  the first night re-check should find the real 2026-10-07 « marge ~27 % ».
- Next concrete action: owner updates the VPS (update block of
  sonni/GUIDE-VPS.fr.md) and the PC script (step 11 of sonni/GUIDE-PC.fr.md); then observe a few days
  (/cerveau toward 50 tasks, /bilan "Est-ce qu'il apprend ?", /portefeuille, decisions in /journee). The VPS
  shows "System restart required" (kernel update): reboot it at a quiet time, Sonni restarts by itself.
- Files to read first: AGENTS.md, PROJECT.md, ARCHITECTURE.md, docs/MEMORY.md, docs/FIRST-SLICE.md,
  src/trader/, sonni/automaton.sonni.example.json.
Never store secrets or report planned work as complete.
