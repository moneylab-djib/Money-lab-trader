# Working status
- Updated: 2026-10-06
- Branch / commit: claude/trader-specification (specification only, no code); draft PR #1
- Current goal: owner review of the specification, then build the first slice (docs/FIRST-SLICE.md).
- Accepted decisions:
  - 0001 (owner, 2026-10-06): virtual training first, memory central, no survival mechanic, no
    passive-investing benchmark, 50 EUR/month budget, real money only by owner decision.
  - 0002 (owner, 2026-10-06): start from Money Lab at commit 2c5580ac18bc49dcb133dafef7cdb8b06d0399e5.
  - 0003 (owner, 2026-10-06): 1,000 EUR virtual capital; free then paid data within the budget; the
    agent chooses its assets within realism rules; readiness measured by return, errors and
    self-funding ratio (thresholds to be set by the owner).
- Research: docs/RESEARCH.md (reusable projects, data sources, realism rules), adopted into
  docs/MEMORY.md (recency/importance ranking, bi-temporal records, indicators computed by code,
  universe store, optional aggregated forecasts and adversarial pass).
- Completed behaviour: none.
- Checks run (command, result, date):
  - python <likma>/scripts/likma.py bootstrap (profile ai-product): documents created, 2026-10-06.
  - python <likma>/scripts/likma.py project doctor: only "configure start" and "configure a check"
    actions, expected with no code, 2026-10-06.
- Blockers and known regressions:
  - Readiness thresholds are still open (docs/PLAN.fr.md). Bot name: Sonni (owner, 2026-10-06).
  - Unverified: Finnhub free rate limit, Twelve Data free-plan delay, Alpaca account availability
    for a French resident.
- Next concrete action: import Money Lab at the pinned commit, configure real checks in
  likma.project.json, and implement the first slice against fake APIs.
- Files to read first: AGENTS.md, PROJECT.md, ARCHITECTURE.md, docs/MEMORY.md, docs/FIRST-SLICE.md,
  docs/RESEARCH.md.
Never store secrets or report planned work as complete.
