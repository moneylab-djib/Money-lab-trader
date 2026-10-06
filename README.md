# Money Lab Trader

An autonomous Claude agent that trains as an apprentice broker on a **virtual** portfolio (crypto,
stocks, ETFs). It reads market news, places fictitious trades, and learns from their outcomes through
a long-term memory of traps, intuitions and event cycles. Real money is out of scope until the owner
decides otherwise.

> **Status:** specification only (2026-10-06). No code, no exchange account, no money involved.

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
[Money Lab](https://github.com/Cloied/Money-lab) (decision 0002).
