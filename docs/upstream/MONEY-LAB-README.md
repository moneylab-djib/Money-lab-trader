# Money Lab

A small, supervised economic experiment built on
[Conway Automaton](https://github.com/Conway-Research/automaton).

One Automaton instance gets a clear mission, maximum freedom and owner-set price caps. It chooses a
useful product, tries to find genuine users and investigates legitimate revenue. The only capability
removed is replication. Income is
uncertain: the goal is to observe what an autonomous agent can actually build, use and earn, and to
measure it honestly.

> **Runtime:** Conway Cloud no longer accepts new accounts (beta ended), so Money Lab runs
> **self-hosted on a VPS**: Claude Sonnet 5.5 through the Anthropic API, the owner on Telegram,
> revenue confirmed by Stripe. Step-by-step setup (French): [money-lab/GUIDE-VPS.fr.md](money-lab/GUIDE-VPS.fr.md).
> The goal the bot is given is to **stay alive**: its balance is the owner's funding plus
> confirmed revenue minus everything it spends; below zero it dies until funded again.

> **Status:** development build. Mocked tests pass; nothing has been launched, funded or
> published yet. Live use requires the owner's approval of the exact resources and budget.

## What Money Lab adds to Automaton

All additions are inert unless `~/.automaton/automaton.json` contains a `moneyLab` block.

| Area | Behaviour |
| --- | --- |
| Mission | Code-owned Money Lab prompt plus the `money-lab-strategy` skill; the agent chooses its activity |
| Tools | Everything Automaton offers (sandboxes, domains, payments, skills, messaging, git) **except replication** and runtime self-modification that could undo that ban |
| Price caps | Optional inference caps (per call, hour, day) and payment caps (per payment, day) in USD cents; `null` = no cap |
| Payments | `allowed` or `disabled` by the owner; automatic top-ups run only when no payment cap is set |
| Profile | Unknown/missing keys or zero values stop startup instead of silently using defaults |
| Journal | Experiments, owner help requests, operator ledger in the existing `state.db` |
| Self-hosted runtime | Local commands/files on the VPS, secrets kept out of the agent's shell, Conway-only tools removed |
| Survival | Balance = funding + Stripe/owner-confirmed revenue - spending (inference, hosting, fees); death below zero, revival on funding |
| Telegram | Owner-only chat: commands (`/statut`, `/fonds`, `/ok`, `/pause`…), free messages to the bot, notifications and a daily summary |
| Stripe | Read-only sync of balance transactions into the ledger (revenue, fees, refunds, payouts), deduplicated |
| Sleep | Sleeps when a budget window is exhausted or after repeated no-progress cycles; only the operator wakes it early |
| Accounting | Funding, credit purchases, consumed costs, estimated revenue, confirmed revenue and cash received are reported separately |

## Operator commands

Output is in French.

```bash
node dist/index.js --money-lab status        # state, budgets, resources, experiments, help, finances
node dist/index.js --money-lab summary       # daily summary
node dist/index.js --money-lab pause "raison"
node dist/index.js --money-lab resume
node dist/index.js --money-lab help-list
node dist/index.js --money-lab help-resolve <id> "note"
node dist/index.js --money-lab help-reject <id> "note"
node dist/index.js --money-lab ledger-add <kind> <amount-cents|unknown> <reference> ["note"] [--provider-import]
```

Pausing stops new paid inference. **It does not stop Conway hosting billing**; see the shutdown
section of the checklist.

## Install and run

Do **not** use the upstream `curl … automaton.sh | sh` installer: it tracks upstream `main` and
would replace this build. Follow [money-lab/CONWAY-CHECKLIST.md](money-lab/CONWAY-CHECKLIST.md)
(pinned commit, configuration, backups, supervised smoke run, bounded experiment, shutdown).

Start from [money-lab/automaton.money-lab.example.json](money-lab/automaton.money-lab.example.json):
payments allowed, inference capped at $1/hour and $3/day, payments capped at $5 each and $10/day,
no other limit. Adjust the caps to current Conway prices and the approved budget.

## Development

```bash
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm typecheck
pnpm exec vitest run src/__tests__/money-lab
pnpm exec vitest run --exclude src/__tests__/context-hardening.test.ts   # upstream suite
pnpm build
```

`src/__tests__/context-hardening.test.ts` hangs on unmodified upstream as well, so a plain
`pnpm test` does not finish. Project rules for coding agents are in [AGENTS.md](AGENTS.md).

## Documentation

- [money-lab/INTEGRATION.md](money-lab/INTEGRATION.md): pinned upstream commit, changed files, spend paths, units, **known limitations**
- [money-lab/CONWAY-CHECKLIST.md](money-lab/CONWAY-CHECKLIST.md): installation, funded run and resource stop
- [docs/STATUS.md](docs/STATUS.md), [docs/FEATURES.md](docs/FEATURES.md), [docs/CODEMAP.md](docs/CODEMAP.md): project status, verified features, code map
- Upstream Automaton documentation: [ARCHITECTURE.md](ARCHITECTURE.md), [DOCUMENTATION.md](DOCUMENTATION.md), [constitution.md](constitution.md)

## Safety limits

The controls run inside the agent process. The shell tool can still reach the wallet, the state
database and the API key through obfuscated commands, and with payments allowed a prompt injection
could trigger a payment within the caps. This is a **supervised experiment** with dedicated, finite
funds, not secure unattended financial automation. No profit is guaranteed;
displayed income is not necessarily received.

## Credits and license

Based on [Conway-Research/automaton](https://github.com/Conway-Research/automaton) at commit
`d8f816881fd24b6f5e3d616e59edec387a447667` (0.2.1). MIT License; see [LICENSE](LICENSE), which is
retained unchanged.
