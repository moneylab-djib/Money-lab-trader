# Architecture brief

Status: proposed (2026-10-06). Nothing below is implemented yet.

## Boundaries

- Client: Telegram (owner only), French messages.
- Agent runtime: a Node.js/TypeScript process derived from Money Lab (agent loop, inference router,
  budgets, Telegram, scheduled jobs, journal, sealed secrets, recall). See decision 0002.
- Database: SQLite `state.db` (memory stores in [docs/MEMORY.md](docs/MEMORY.md), virtual portfolio,
  spend ledger); Markdown notebook export in `~/carnet/`.
- External services:
  - Anthropic API (Haiku 4.5, Sonnet 5.5, Opus 5.5; server-side web search and web fetch).
  - Crypto prices: Kraken public market-data endpoints (no API key, no account).
  - Stock and ETF prices: source to be chosen (open question 2).
  - Calendars: central-bank meeting dates, macro releases, earnings dates (sources to be chosen during
    slice 3).
- Deliberately absent in this phase: any exchange or broker trading API, any API key able to move money.

## Components

| Component | Inference | Role |
| --- | --- | --- |
| Collectors | None | Fetch prices and calendars on a schedule (Money Lab scheduled jobs, no paid inference). |
| Digest | Haiku 4.5 | Turn news and filings into dated observations and events. |
| Statistics | None | Measure event reactions, pattern statistics, hypothesis confidence. |
| Decision agent | Sonnet 5.5 | Read the memory pack, record predictions, place virtual orders with a thesis. |
| Paper broker | None | Fill virtual orders realistically, track positions, cash, fees, contributions. |
| Resolver | None | Resolve predictions and positions at their horizon; append evidence. |
| Consolidation and review | Sonnet 5.5 daily, Opus 5.5 weekly | Post-mortems, hypotheses, traps, lessons, weekly report. |
| Owner channel | None (Sonnet for free-text replies) | Telegram commands, notes, report delivery. |

## Data flow

1. Collectors store prices and scheduled events.
2. The digest stores observations with their publication time.
3. Statistics compute reactions to resolved events and refresh pattern and hypothesis numbers.
4. A decision session (scheduled or triggered) receives the memory pack, then records predictions and
   virtual orders. Every order carries a thesis, a conviction, a probability, an invalidation level
   and a horizon.
5. The paper broker fills orders at the next observed price, never at the price the decision saw,
   adds simulated fees and slippage, and respects stock market hours. Limit orders fill only if the
   price crosses the limit.
6. The resolver closes predictions and positions at their horizon and appends evidence.
7. Daily consolidation and the weekly review update semantic and procedural memory; the weekly report
   goes to Telegram.

## Virtual portfolio rules

- Long-only spot positions, no leverage, no shorting.
- Starting virtual capital: open question 1 (proposal: 1,000 EUR) plus a virtual 50 EUR contribution on
  the first of each month.
- Fees: crypto at Kraken Pro's lowest tier (0.40 % maker, 0.80 % taker, checked 2026-10-06 on
  kraken.com/features/fee-schedule); stock and ETF fees configurable until a broker is chosen.
- Slippage: a configurable fraction of the observed spread; crypto spread from Kraken order book.

## Budget and model use

Owner budget: 50 EUR/month of inference (decision 0001), to be raised by the owner if the first tests
are conclusive. Configured in USD at an exchange rate the owner sets. Prices from Anthropic's model
table as cached on 2026-09-25: Haiku 4.5 $1 / $5 per million input / output tokens, Sonnet 5.5
$2 / $10 (cache reads $0.20), Opus 5.5 $4 / $20 (cache reads $0.20); Batch API halves prices.
Web searches are billed on top of tokens and count against the same budget.

| Purpose | Model | Share | About |
| --- | --- | --- | --- |
| News and data digest | Haiku 4.5 (Batch API where latency allows) | 30 % | 15 EUR |
| Decision sessions | Sonnet 5.5 | 40 % | 20 EUR |
| Consolidation and weekly review | Sonnet 5.5 daily, Opus 5.5 weekly | 20 % | 10 EUR |
| Reserve for market events | any | 10 % | 5 EUR |

These shares are estimates to be replaced by measured spend after two weeks. Enforcement:

- Money Lab's spend tracker with a cap per purpose, and pacing: the daily allowance is the remaining
  budget divided by the remaining days, so a busy day cannot spend the month.
- A dedicated Anthropic API key in its own workspace, with a monthly spend limit set by the owner in
  the Anthropic Console as the hard backstop. Money Lab and the trader never share a key.

## Decisions and trade-offs

- Start from the Money Lab codebase (decision 0002, proposed) rather than a new codebase: its agent
  loop, budgets, Telegram channel, scheduled jobs, sealed secrets and memory modules are already
  tested (1,722 passing tests and an end-to-end harness run on 2026-10-06).
- No trading engine (NautilusTrader, Freqtrade) in the virtual phase: a small paper broker in SQLite is
  enough and keeps one language. Revisit when real money is considered.
- No Managed Agents: the self-hosted Money Lab runtime already exists and is proven on this VPS.
- No vector database: structured keys plus SQLite FTS5 (see docs/MEMORY.md section 6).
- No backtesting of model decisions on past periods: the model remembers what happened. Code-only
  statistics on history are allowed.

## Risks

- Memory poisoning through news: mitigated because pages only create observations; hypotheses gain
  confidence only from measured evidence.
- Overfitting by narrative: the model may explain every move after the fact. Mitigated by predictions
  recorded before outcomes, computed confidence and scored calibration.
- Budget burn by loops (seen on Money Lab's first run, $0.52 in 30 s): per-purpose caps, pacing,
  repetition detection inherited from Money Lab, and the workspace spend limit.
- In-process guards are bypassable through the shell tool (known Money Lab limitation): acceptable with
  no money at stake; must be redesigned before any real-money phase.
- VPS capacity: two agents on the smallest VPS may run short of memory; to measure before launch.
- Paper results flatter reality: no market impact, optimistic fills. Fills at the next price, fees and
  slippage reduce but do not remove this bias.
