# Working status
- Updated: 2026-10-06
- Branch / commit: claude/sonni-knowledge (step 1, stacked on claude/sonni-first-slice, PR #2)
- Current goal: step 1 "Sonni already knows things" (owner's order 2026-10-06: step 1, then step 2
  news and calendar). First slice is live on the owner's VPS since 2026-10-06 22:12 UTC.
- Accepted decisions: 0001 (owner direction), 0002 (start from Money Lab), 0003 (capital, data, assets,
  readiness measures; thresholds to be set after the first months of results), name Sonni.
- Completed behaviour (first slice, docs/FIRST-SLICE.md):
  - Money Lab imported verbatim at 2c5580ac18bc49dcb133dafef7cdb8b06d0399e5 (separate commit).
  - src/trader/: strict `trader` config block; Kraken public price collection every collectMinutes;
    hypotheses with confidence computed by code; record_prediction refused on stale prices or missing
    fields; append-only predictions and evidence (SQLite triggers); resolution by code at the horizon
    (Brier score, evidence, or void when no price exists in the window); memory pack tool; Sonni
    mission, rules and weekly review replacing Money Lab's; Money Lab web-business tools denied;
    French /statut, /idee, /intuitions on Telegram and `--sonni` CLI.
  - Prompt caching keeps working: the Sonni rules block is the volatile part (src/conway/inference.ts).
- Checks run (command, result, date):
  - likma project check (types, sonni 20 tests, money-lab 110 tests, build, sonni-e2e): PASS, 2026-10-06.
  - likma project feature verify first-prediction (criteria 1 via sonni-e2e, 2-8 via sonni): PASS, 2026-10-06.
  - node sonni/e2e.mjs: real built process against fake Kraken/Anthropic/Telegram: PASS, 2026-10-06.
  - After the discovery-cap fix (22:20 UTC): the same five checks run directly (typecheck, sonni 20/20,
    money-lab 110/110, build, sonni-e2e PASS). The Likma session had reached its 60-minute limit and was
    not renewed, so the feature board shows the earlier verification as stale.
- Step 1 built (2026-10-06): Kraken daily candles (720 days) refreshed every 6 h; test-rule language;
  historical tests by code (30 cases, z >= 2.33), append-only; propose_hypothesis tool with origins and
  daily limit; intake on Opus for 8 turns until 30 prior hypotheses (3 attempts max, counted on paid
  turns); wake for the intake when history arrives; historical verdicts in the memory pack, /statut
  and /intuitions. Live check (read-only, no key): 720 days for BTC and ETH, 2024-10-16..2026-10-05;
  "BTC rebounds the day after a -3 % day" scored 19/47 = 40 % vs 51 % on all days, refuted.
  - Found while testing: the runtime runs at most 10 tool calls per turn; the intake text says so.
  - Checks (new Likma session begun deliberately for step 1 after the previous one reached its time
    limit): likma project check PASS (types, sonni 33/33, money-lab 110/110, build, sonni-e2e);
    features knowledge-intake and first-prediction verified, 2026-10-06.
- Known gaps (deliberate, later slices):
  - Monthly budget pacing is approximated by Money Lab's daily cap (1/30 of the month: $1.93/day for 50 EUR) and its funding
    balance (example: $58, topped up monthly by the owner with /fonds). Remaining/remaining-days pacing
    and per-purpose shares are not implemented.
  - Only price-threshold predictions; no virtual orders, news, events, traps or cycles yet; historical
    statistics cover daily price rules only (no event reactions). Readiness thresholds are left for after the first results (owner, 2026-10-06).
  - Money Lab's experiment-oriented parts remain in the runtime (no-progress sleep, /resume summary);
    they do not block Sonni but some owner texts still mention experiments. The idea-discovery sleep cap
    no longer applies to Sonni (seen on the first live run, fixed 2026-10-06).
- First live run (owner's VPS, 2026-10-06 22:12 UTC): Sonni read its memory pack and recorded two
  predictions due 2026-10-07 22:12 UTC, then slept.
- Blockers: none for code. The owner is renting a dedicated VPS (decision 0004) and will follow
  sonni/GUIDE-VPS.fr.md: own Anthropic workspace and key with a spend limit, new Telegram bot.
- Next concrete action: owner merges PRs #1 and #2 (or clones the branch), sets up the VPS with the
  guide, then a supervised first run.
- Files to read first: AGENTS.md, PROJECT.md, ARCHITECTURE.md, docs/MEMORY.md, docs/FIRST-SLICE.md,
  src/trader/, sonni/automaton.sonni.example.json.
Never store secrets or report planned work as complete.
