# Working status
- Updated: 2026-10-07
- Branch / commit: claude/sonni-alive (step 3, stacked on claude/sonni-world, PR #4)
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
- Blockers: none for code. The owner must create free reader keys (optional) and update the VPS.
- Next concrete action: owner updates the VPS to claude/sonni-alive (guide: "Mettre Sonni à jour", with
  the configure.mjs line), adds GEMINI_API_KEY / GROQ_API_KEY to /etc/sonni.env if wanted, restarts,
  checks /lecteurs, /sources, /identite.
- Files to read first: AGENTS.md, PROJECT.md, ARCHITECTURE.md, docs/MEMORY.md, docs/FIRST-SLICE.md,
  src/trader/, sonni/automaton.sonni.example.json.
Never store secrets or report planned work as complete.
