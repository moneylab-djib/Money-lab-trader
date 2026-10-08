# Working status
- Updated: 2026-10-08
- Branch / commit: claude/sonni-evening (step C3, stacked on claude/sonni-cycles = PR #14, #13, #12; main after PRs #1 to #11)
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
- Next concrete action: owner merges the step PRs in order (1, 2, 3; each contains the previous ones) and
  runs the update block of sonni/GUIDE-VPS.fr.md; then follows sonni/GUIDE-PC.fr.md on the PC and checks
  /cerveau; observe a day (/bilan "Est-ce qu'il apprend ?", /portefeuille, decisions in /journee, /cerveau).
- Files to read first: AGENTS.md, PROJECT.md, ARCHITECTURE.md, docs/MEMORY.md, docs/FIRST-SLICE.md,
  src/trader/, sonni/automaton.sonni.example.json.
Never store secrets or report planned work as complete.
