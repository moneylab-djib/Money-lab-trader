# Project DNA

## Identity

- Name: Sonni (owner decision 2026-10-06; repository `Money-lab-trader`)
- One-sentence description: an autonomous Claude agent that trains as an apprentice broker on a
  virtual portfolio, with a long-term memory of traps, intuitions and event cycles at its core.
- Product category: personal research project; supervised AI trading agent.
- Current status: specification only (2026-10-06). No code, no exchange account, no money involved.

## Users and problem

- Primary user: the owner, alone, through Telegram.
- Problem being solved: the owner wants a tool that will eventually invest their monthly savings
  (about 50 EUR/month) with judgement that improves over time. Rule-based bots do not learn, and a
  language model forgets everything between sessions unless memory is designed for it.
- Context of use: the agent runs continuously on the owner's VPS, next to Money Lab. The owner reads a
  weekly report, asks questions and feeds observations from Telegram.
- What success looks like: after a long virtual training period, a measured track record
  (calibrated predictions, positive virtual result after simulated costs, controlled losses) that
  convinces the owner to let it manage a small amount of real money.

## Product principles

1. Memory is the product. Every decision reads memory first and writes memory afterwards.
2. Evidence over recollection. Claude's prior market knowledge enters memory as hypotheses to be
   tested on live data, never as established rules.
3. Honest records. Predictions and trades are written before their outcome is known and cannot be
   edited; outcomes and statistics are computed by code from price data, not judged by the model.
4. Virtual until the owner decides. No exchange keys and no real orders in this phase.
5. Spend the budget on learning. The monthly inference budget is meant to be used, paced over the
   month and bounded by a hard cap.

## Visual and interaction direction

- The product should feel like: a junior broker's desk notebook reviewed weekly with a mentor.
- It should not feel like: a "get rich" signal bot promising returns.
- Primary interaction model: Telegram chat in French (commands, free messages, weekly report).
- What must be recognisable about it: every claim it makes can be traced to a dated record.

## Scope

### In

- Virtual portfolio: 1,000 EUR at start; crypto, stocks and ETFs chosen by the agent within realism
  rules; long-only spot positions; simulated fees and slippage; a virtual 50 EUR monthly contribution
  that mirrors the owner's future savings.
- Market data, news and economic/earnings calendar ingestion.
- The memory system described in [docs/MEMORY.md](docs/MEMORY.md).
- Decision sessions, daily consolidation and a weekly review reported on Telegram.
- Owner channel: status commands, free-text notes and ideas stored in memory.

### Out for now

- Real money, exchange or broker API keys, account creation (owner decision 2026-10-06).
- Leverage, derivatives, short selling, high-frequency trading.
- Comparison against a passive-investing benchmark (owner decision 2026-10-06).
- Survival/death mechanic (owner decision 2026-10-06; see decision 0001).
- Backtesting the language model's decisions on past periods (it already knows what happened).
- Dashboards, multi-user features, vector database.

## Technical constraints

- Runtime/framework: TypeScript on Node.js, starting from the Money Lab codebase (decision 0002).
- Data/backend: SQLite (`state.db`) as canonical store; Markdown notebooks exported for the owner.
- Deployment: the owner's existing VPS, as a separate Linux user and systemd service from Money Lab.
- Supported devices: Telegram clients only.
- Non-negotiable constraints:
  - Budget 50 EUR/month for inference and paid data (decisions 0001 and 0003), enforced in process and
    backed by an Anthropic workspace spend limit; raised only by the owner after conclusive tests.
  - No real trading credentials on the machine during the virtual phase.
  - Operator-facing output in French; code, comments and repository documentation in English.

## Decisions

See [docs/decisions/](docs/decisions/). Do not silently reverse an accepted decision.
