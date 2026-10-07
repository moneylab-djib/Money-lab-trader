# Money Lab — project operating rules
Money Lab is a thin extension of Conway Automaton for a small, supervised economic experiment.
Read money-lab/INTEGRATION.md, money-lab/CONWAY-CHECKLIST.md, money-lab/PLAN.fr.md and docs/STATUS.md first.
Shared methods come from Likma Dev System (https://github.com/Cloied/likma-dev-system); this project's
identity, scope and constraints are defined here and in the Money Lab specification.

## Scope
- Lean first-run scope only. Do not build deferred architecture: SaaS/dashboard, multi-tenant engine,
  marketplace, model framework, vector database, ROI engines, payment server,
  comprehensive ledger/broker, unrestricted self-modification.
- Keep upstream Automaton code and its MIT LICENSE. Prefer small patches under src/money-lab/ over
  edits to upstream modules; behaviour must stay unchanged when no moneyLab block is configured.
- Code, comments and repository documentation: English. Operator-facing output: French.

## Safety
- Never launch the agent, fund wallets, buy credits, create accounts, provision paid resources or
  publish anything without the owner's explicit approval of the exact resources and budget.
- Owner decision (2026-10-04): the bot gets maximum freedom; only replication is forbidden, and
  spending is bounded by optional price caps. Do not add capability restrictions without the owner's
  approval, and do not remove the replication ban, runtime protection or price-cap enforcement.
- Owner decision (2026-10-04): Conway Cloud is closed; the default runtime is self-hosted on a VPS
  (Anthropic Claude Sonnet 5.5, Telegram owner channel, Stripe revenue sync). The bot's ultimate goal
  is survival: only provider- or owner-confirmed revenue extends its balance.
- Owner decision (2026-10-05): full autonomy. The bot may run a portfolio of up to 3 experiments, use
  web search/fetch, see pages (view_page), publish in its own GitHub organization and read its analytics
  with narrowly scoped credentials it can read (GH_TOKEN, GOATCOUNTER_TOKEN), split its budget by purpose,
  sleep at most 6 h, and must hold a weekly review that maintains ~/LESSONS.md. It also drives a headless
  browser (browse) with its own profile; it must never use the owner's accounts or create accounts.
- In-process limits are not tamper-proof (exec can bypass them). Never describe them as secure isolation.
- Unknown cost is never free. Funding is not revenue; estimated income is not cash.
- Tests must not make network or payment calls (src/__tests__/money-lab replaces fetch with a failing spy).

## Commands
Setup: corepack enable pnpm && pnpm install --frozen-lockfile
Checks (configured in likma.project.json, run through the Likma checkout):
  python <likma>/scripts/likma.py project check --path .
  - types: pnpm run typecheck
  - money-lab: pnpm exec vitest run src/__tests__/money-lab
  - build: pnpm run build
End-to-end (real process, fake APIs, ~3 min): pnpm run build && node money-lab/e2e/harness.mjs
Chaos run (real process, failing fake APIs, ~4 min): pnpm run build && node money-lab/e2e/chaos.mjs
Upstream suite: pnpm exec vitest run --exclude src/__tests__/context-hardening.test.ts
(context-hardening.test.ts hangs on unmodified upstream; plain `pnpm test` never finishes.)
No start command is configured on purpose: starting runs the agent.

## Likma tracking
Track features in .likma/features.json and docs/FEATURES.md; keep docs/CODEMAP.md current via
likma.project.json. Use project runtime begin/context/guard/record/end for substantial tasks.
Update docs/STATUS.md with real checks and blockers; never report planned work as complete.
