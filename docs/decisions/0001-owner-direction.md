# Architecture decision 0001: owner direction for the trader
- Status: accepted (owner, 2026-10-06, in conversation)
- Date: 2026-10-06
- Context and constraints: a feasibility report (Claude Docs, 2026-10-06) showed that a trading bot
  whose survival depends on its profits is unrealistic with a small capital: fixed costs and trading
  fees outweigh plausible returns. The owner reframed the project.
- Decision:
  1. The bot trains on a virtual portfolio first, fed with as much information as useful, placing
     fictitious bets.
  2. It is a self-learning experiment: it should learn like a broker, noting traps, intuitions and
     event cycles that move prices. Memory is central, and Claude's existing knowledge must be made
     useful.
  3. No survival/death mechanic and no comparison against passive investing.
  4. Inference budget: 50 EUR/month, which the bot may use fully; the owner may raise it after
     conclusive first tests.
  5. Real money comes only after the bot has shown proof, by owner decision. Long term, it should
     invest the owner's monthly savings (about 50 EUR/month).
- Alternatives and trade-offs: survival-based trading bot (rejected: capital too small); benchmark
  against monthly index buying (rejected by the owner).
- Reversibility and migration: fully reversible; no money or account involved.
- Evidence: owner messages of 2026-10-06; feasibility report.
- Revisit trigger: the owner considers moving to real money, or changes the budget.
