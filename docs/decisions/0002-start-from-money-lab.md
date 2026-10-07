# Architecture decision 0002: start from the Money Lab codebase
- Status: accepted (owner, 2026-10-06)
- Date: 2026-10-06
- Context and constraints: the trader needs an agent loop, an inference router with per-purpose
  budgets, a Telegram owner channel, scheduled jobs without inference, a journal in SQLite, sealed
  secrets, delegation to Haiku and full-text recall. Money Lab
  ([Cloied/Money-lab](https://github.com/Cloied/Money-lab), commit
  `2c5580ac18bc49dcb133dafef7cdb8b06d0399e5`) has all of these, tested on the same VPS, and inherits
  episodic/semantic/procedural memory modules from Conway Automaton (MIT).
- Decision: copy Money Lab at a pinned commit into this repository, keep its MIT LICENSE and
  attribution, and add the trader as a thin extension under `src/trader/`, enabled by a `trader`
  configuration block. Money Lab-specific tools (Stripe, domains, social posting, image generation)
  are denied in the trader profile. Wallet, replication and Conway Cloud paths stay disabled.
- Alternatives and trade-offs:
  - New TypeScript project borrowing selected modules: smaller codebase, but re-tests and re-wires
    proven pieces (Telegram, budgets, sealed secrets) and loses Money Lab's end-to-end harness.
  - Python project around Freqtrade or NautilusTrader: strong trading tooling, but a second stack to
    maintain and none of the agent or memory pieces.
  - Claude Managed Agents: hosted loop and sandbox, but a different runtime from Money Lab and less
    control over local data and cost pacing.
- Reversibility and migration: moderate. The memory schema and paper broker under `src/trader/` stay
  portable; the copy can be replaced later by a slimmer runtime.
- Evidence: Money Lab docs/STATUS.md (2026-10-06): 1,722 passing tests, end-to-end and chaos harnesses PASS.
- Revisit trigger: the copied codebase slows development, or upstream Money Lab fixes must be ported often.
