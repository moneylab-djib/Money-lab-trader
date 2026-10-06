# Working status
- Updated: 2026-10-06
- Branch / commit: claude/trader-specification (specification only, no code)
- Current goal: agree the specification with the owner, then build the first slice (docs/FIRST-SLICE.md).
- Accepted decisions:
  - 0001 (owner, 2026-10-06): virtual training first, memory central, no survival mechanic, no
    passive-investing benchmark, 50 EUR/month inference budget, real money only by owner decision.
- Proposed decisions awaiting the owner:
  - 0002: start from the Money Lab codebase at commit 2c5580ac18bc49dcb133dafef7cdb8b06d0399e5.
- Completed behaviour: none.
- Checks run (command, result, date):
  - python <likma>/scripts/likma.py bootstrap (profile ai-product): documents created, 2026-10-06.
  - No code checks exist yet.
- Blockers and known regressions:
  - Open questions in docs/PLAN.fr.md (starting virtual capital, stock data source, asset list,
    readiness criteria, codebase decision, name).
- Next concrete action: after owner approval of decision 0002, import Money Lab at the pinned commit,
  configure real checks in likma.project.json, and implement the first slice against fake APIs.
- Files to read first: AGENTS.md, PROJECT.md, ARCHITECTURE.md, docs/MEMORY.md, docs/FIRST-SLICE.md.
Never store secrets or report planned work as complete.
