# Working status
- Updated: 2026-10-06
- Branch / commit: claude/sonni-first-slice (stacked on claude/trader-specification, PR #1)
- Current goal: first slice done and verified against fake APIs; next is a supervised live run approved
  by the owner, then slice 2 (virtual portfolio).
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
  - likma project check (types, sonni 19 tests, money-lab 110 tests, build, sonni-e2e): PASS, 2026-10-06.
  - likma project feature verify first-prediction (criteria 1 via sonni-e2e, 2-8 via sonni): PASS, 2026-10-06.
  - node sonni/e2e.mjs: real built process against fake Kraken/Anthropic/Telegram: PASS, 2026-10-06.
- Known gaps (deliberate, later slices):
  - Monthly budget pacing is approximated by Money Lab's daily cap (example: $1.90/day) and its funding
    balance (example: $58, topped up monthly by the owner with /fonds). Remaining/remaining-days pacing
    and per-purpose shares are not implemented.
  - Only price-threshold predictions; no virtual orders, news, events, traps, cycles or historical
    statistics yet. Readiness thresholds are left for after the first results (owner, 2026-10-06).
  - Money Lab's experiment-oriented parts remain in the runtime (no-progress sleep, discovery sleep cap,
    /resume summary); they do not block Sonni but some owner texts still mention experiments.
- Blockers: none for code. A live run needs the owner's approval of the exact resources: a separate
  Linux user on the VPS, a dedicated Anthropic key with a workspace spend limit, a new Telegram bot.
- Next concrete action: owner reviews PR #1 and this slice; then a supervised live run (guide to write).
- Files to read first: AGENTS.md, PROJECT.md, ARCHITECTURE.md, docs/MEMORY.md, docs/FIRST-SLICE.md,
  src/trader/, sonni/automaton.sonni.example.json.
Never store secrets or report planned work as complete.
