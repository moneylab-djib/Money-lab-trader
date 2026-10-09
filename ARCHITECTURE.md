# Architecture brief

Status: proposed (2026-10-06); rows marked "implemented" exist in src/trader/ (steps 1 to 4). The
virtual portfolio and the paper broker are implemented (step 4 B, src/trader/portfolio.ts);
consolidation is still a proposal.

## Boundaries

- Client: Telegram (owner only), French messages.
- Agent runtime: a Node.js/TypeScript process derived from Money Lab (agent loop, inference router,
  budgets, Telegram, scheduled jobs, journal, sealed secrets, recall). See decision 0002.
- Database: SQLite `state.db` (memory stores in [docs/MEMORY.md](docs/MEMORY.md), virtual portfolio,
  spend ledger); Markdown notebook export in `~/carnet/`.
- External services:
  - Anthropic API (Haiku 4.5, Sonnet 5.5, Opus 5.5; server-side web search and web fetch).
  - Crypto prices: Kraken public market-data endpoints (no API key, no account).
  - Stock, ETF, news, calendar and filing data: free sources first, paid ones within the budget
    (candidates and limits in [docs/RESEARCH.md](docs/RESEARCH.md)).
- Deliberately absent in this phase: any exchange or broker trading API, any API key able to move money.

## Components

| Component | Inference | Role |
| --- | --- | --- |
| Collectors | None | Fetch prices every 5 minutes and Kraken daily candles every 6 hours (calendars later), without paid inference. |
| Calendar and headlines | None | Fed decisions daily from federalreserve.gov (CPI and jobs from FRED with an optional key); GDELT headlines hourly; reactions to past events computed from daily candles. |
| Historical tests | None | Evaluate hypotheses' test rules on daily history; append verdicts (docs/MEMORY.md section 4). |
| Intake | Opus 5.5, then Sonnet 5.5 | Once history is stored: Sonni writes its prior market knowledge as hypotheses with propose_hypothesis. |
| Readers (implemented, step 3) | Free OpenAI-compatible models (Gemini, Groq...), owner's free-tier keys | Turn the hour's headlines and the pages Sonni asks to read into dated, validated observations; they read, never decide; counted and capped per day. |
| Curiosity (implemented, step 3) | None | Every minute, evaluate triggers (3 % move in an hour, event day, morning after, resolved predictions, the model's watches) and wake the sleeping agent within the owner's daily cap. |
| Sources (implemented, step 3) | None | Poll the enabled catalog entries (Fear & Greed, market cap, Kraken order book, Bitcoin fees, FRED series with a key) and model-proposed endpoints the owner approved, into metrics for the pack. |
| Identity and journal (implemented, step 3) | Decision model | Versioned identity, append-only reflections and post-mortems, lessons with evidence; the self-report they rely on is computed by code. |
| Statistics | None | Measure event reactions, pattern statistics, hypothesis confidence, and the indicators the model reads (returns, volatility, drawdown, moving-average position, volume ratios); the model never reads raw candles (docs/RESEARCH.md). |
| Decision agent | Sonnet 5.5; Opus 5.5 confirms a buy of 20 % of the portfolio or more (decision 0005) | Read the memory pack and code's odds (market_odds), record predictions, state a decision per followed asset (staying out included, scored by code), place virtual orders with a thesis. |
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
- Starting virtual capital: 1,000 EUR plus a virtual 50 EUR contribution on the first of each month
  (decision 0003).
- Fees: crypto at Kraken Pro's lowest tier (0.40 % maker, 0.80 % taker, checked 2026-10-06 on
  kraken.com/features/fee-schedule); stock and ETF fees configurable until a broker is chosen.
- Slippage: a configurable fraction of the observed spread; crypto spread from Kraken order book.
- Implemented (step 4 B, `trader.portfolio`): the capital arrives at the first collected price and the
  contribution on the first tick of each month; an order is a pending record checked by code (followed
  asset, fresh price, cash or quantity available, at most 30 % of the portfolio per asset as the owner
  chose on 2026-10-07, 10 EUR minimum, a thesis, an invalidation level below the entry for every buy,
  a horizon of 1 h to 90 days) and filled at the first price collected after it (market: price plus
  half the Kraken spread when fresh, else 5 bps, taker fee; limit: at the limit once crossed, maker
  fee; a market order expires after 24 h without a price, a limit at its horizon). A position whose
  invalidation is reached gets a market sell from code at the next price; at the horizon the model is
  woken to keep (new horizon) or sell. Every sale closes a trade with P&L after fees computed by code.
  One equity snapshot per day gives returns and drawdown; the self-funding ratio divides the virtual
  gain by the inference spend converted at `eurUsd`.
- Numeric soundness (step 0.3, 2026-10-09; guard G17 in docs/GUARDS.md): fill prices and average costs keep
  12 significant digits, EUR amounts cents, quantities 1e-8, so a round trip costs the same at any price
  (no price floor: assets below 0.01 EUR are allowed). Every figure of a fill is checked before anything is
  written; a zero, negative or non-finite one settles the order as `rejected` (note and incident) with
  nothing else written, and one order's failure never stops the others, the stops or the snapshot. A
  stored position code cannot value (only a pre-0.3 fill could write one) makes the total unknown: buys,
  decisions and snapshots are suspended and the value is shown as not reliable until the owner approves a
  repair; sales and stops of the other positions go on. Unit prices below 1 EUR are shown with at least 5
  significant digits.

## Budget and model use

Owner budget: 50 EUR/month (decision 0001), covering inference and any paid data subscription the
agent proposes and the owner subscribes to (decision 0003); raised by the owner if the first tests
are conclusive. Configured in USD at an exchange rate the owner sets. Prices from Anthropic's model
table as cached on 2026-09-25: Haiku 4.5 $1 / $5 per million input / output tokens, Sonnet 5.5
$2 / $10 (cache reads $0.20), Opus 5.5 $4 / $20 (cache reads $0.20); Batch API halves prices.
Web searches are billed on top of tokens and count against the same budget.

| Purpose | Model | Share | About |
| --- | --- | --- | --- |
| News and data digest | Free reader models since step 3 (Gemini, Groq; no Anthropic spend); Haiku 4.5 (Batch API) only if the owner chooses it later | 30 % planned, nothing spent now | 15 EUR |
| Decision sessions | Sonnet 5.5 | 40 % | 20 EUR |
| Consolidation and weekly review | Sonnet 5.5 daily, Opus 5.5 weekly | 20 % | 10 EUR |
| Reserve for market events | any | 10 % | 5 EUR |

These shares are estimates to be replaced by measured spend after two weeks. Enforcement:

- Money Lab's spend tracker with a cap per purpose, and pacing: the daily allowance is the remaining
  budget divided by the remaining days, so a busy day cannot spend the month.
- A dedicated Anthropic API key in its own workspace, with a monthly spend limit set by the owner in
  the Anthropic Console as the hard backstop. Money Lab and the trader never share a key.
- First slice (2026-10-06): pacing and per-purpose caps are not built yet. Money Lab's daily inference
  cap and funding balance stand in for them (sonni/vps/configure.mjs: 1/30 of the monthly budget per day,
  $1.93/day for 50 EUR at 1.16; $58 funded per month with /fonds).

## Decisions and trade-offs

- Start from the Money Lab codebase (decision 0002, accepted) rather than a new codebase: its agent
  loop, budgets, Telegram channel, scheduled jobs, sealed secrets and memory modules are already
  tested (1,722 passing tests and an end-to-end harness run on 2026-10-06).
- No trading engine (NautilusTrader, Freqtrade) in the virtual phase: a small paper broker in SQLite is
  enough and keeps one language. Revisit when real money is considered.
- No Managed Agents: the self-hosted Money Lab runtime already exists and is proven on Money Lab's VPS.
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
- Hosting: Sonni runs on its own VPS (decision 0004), so a Money Lab crash or install cannot stop price
  collection, and no future trading key will sit next to another agent with shell access.
- Paper results flatter reality: no market impact, optimistic fills. Fills at the next price, fees and
  slippage reduce but do not remove this bias.
