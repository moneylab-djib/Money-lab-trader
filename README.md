# Sonni

Sonni is an autonomous Claude agent that trains as an apprentice broker on a **virtual** portfolio (crypto,
stocks, ETFs). It reads market news, places fictitious trades, and learns from their outcomes through
a long-term memory of traps, intuitions and event cycles. Real money is out of scope until the owner
decides otherwise.

> **Status:** first slice built and verified against fake APIs (2026-10-06): live Kraken prices, owner
> hypotheses, predictions resolved and scored by code, French status on Telegram. Not launched yet.
> No exchange account, no money involved.

## Read first

- [PROJECT.md](PROJECT.md): purpose, principles, scope
- [ARCHITECTURE.md](ARCHITECTURE.md): components, data flow, budget
- [docs/MEMORY.md](docs/MEMORY.md): memory design, the core of the project
- [docs/FIRST-SLICE.md](docs/FIRST-SLICE.md): first deliverable and its acceptance criteria
- [docs/RESEARCH.md](docs/RESEARCH.md): reusable projects, data sources, realism rules
- [docs/PLAN.fr.md](docs/PLAN.fr.md): owner summary in French, with open questions
- [docs/decisions/](docs/decisions/): accepted and proposed decisions
- [AGENTS.md](AGENTS.md): rules for coding agents

Project methods follow [Likma Dev System](https://github.com/Cloied/likma-dev-system)
(profile `ai-product`). The runtime is planned to start from
[Money Lab](https://github.com/Cloied/Money-lab) (decision 0002), imported at a pinned commit; Sonni's
code is in `src/trader/`. Checks and commands are listed in [AGENTS.md](AGENTS.md).
