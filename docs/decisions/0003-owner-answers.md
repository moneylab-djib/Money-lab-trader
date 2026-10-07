# Architecture decision 0003: owner answers on capital, data, assets and readiness
- Status: accepted (owner, 2026-10-06, in conversation); item 4 thresholds will be set after the
  first months of results (owner, 2026-10-06)
- Date: 2026-10-06
- Context and constraints: open questions from docs/PLAN.fr.md after decisions 0001 and 0002.
- Decision:
  1. **Virtual capital:** 1,000 EUR at start, plus the virtual 50 EUR monthly contribution (decision 0001).
  2. **Data sources:** the agent uses free and paid sources according to its budget. Interpretation
     recorded here: paid data subscriptions count against the same monthly budget as inference; the
     agent proposes a subscription with its expected use and cost; the owner subscribes (the agent
     never creates accounts). See docs/RESEARCH.md section 2.
  3. **Assets:** the agent chooses the assets it follows, within the realism rules of
     docs/RESEARCH.md section 3 (MiCA platforms for crypto, UCITS ETFs, bounded watch list, every change
     recorded with a reason).
  4. **Readiness for real money**, owner's criteria: a substantial return, few errors, and the ability
     to pay for its own running costs. Proposed measurement, over the latest 3 months of at least 6:
     - return: virtual portfolio result after simulated fees, contributions excluded;
     - errors: calibration of its predictions and the share of high-conviction calls that failed;
     - self-funding ratio: virtual gains divided by its running costs (inference plus data); 1.0
       means it paid for itself.
     The owner sets the thresholds; real money stays an owner decision (decision 0001).
  5. **Codebase:** start from Money Lab (decision 0002 accepted).
  6. **Research:** look for other projects whose code or ideas help; done in docs/RESEARCH.md.
  7. **Name:** the bot is called Sonni.
- Alternatives and trade-offs: a separate data budget (rejected for now: one envelope lets the agent
  trade reading against data, which is part of what it learns).
- Reversibility and migration: all reversible; no money or account involved.
- Evidence: owner message of 2026-10-06.
- Revisit trigger: first two weeks of measured spend; the owner sets readiness thresholds.

## Note on the self-funding criterion
With about 1,300 EUR of average virtual capital in the first year and running costs near 50 EUR a
month, paying for itself means earning about 4 % a month (roughly 45 to 60 % a year), which few
professional strategies sustain. The ratio is still useful as a weekly progress indicator. Two levers
make it more reachable: lower running costs once training settles, and a larger capital at the time
real money is considered.
