# Research note: reusable projects and data sources

Researched 2026-10-06 for three decisions: what code or ideas to reuse for memory, which data sources
the agent may use (free first, paid within budget), and what LLM trading projects teach. Figures were
read on the linked pages that day; vendor claims are labelled as such. A French summary is in
docs/PLAN.fr.md.

## 1. Projects with reusable code or ideas

| Project | License | Stars | What we take | What we leave |
| --- | --- | --- | --- | --- |
| [Money Lab](https://github.com/Cloied/Money-lab) | MIT (Conway Automaton) | — | The runtime: agent loop, inference router and budgets, Telegram, scheduled jobs, sealed secrets, Haiku delegation, recall, episodic/semantic/procedural memory modules (decision 0002, accepted) | Stripe, domains, social posting, image tools, wallet, replication |
| [FinMem](https://github.com/pipiku915/FinMem-LLM-StockTrading) ([paper](https://arxiv.org/abs/2311.13743)) | MIT | 961 | Layered memory where each layer decays at its own rate and retrieval ranks by recency, relevance and importance; trader "profile" | Python code, vector database, OpenAI embeddings; backtest-only design |
| [TradingAgents](https://github.com/TauricResearch/TradingAgents) | Apache-2.0 | 109.9k | "Settle and reflect": when a decision's holding period ends, fetch the realised return and write a one-paragraph reflection; bull/bear researcher debate; its data vendor list (EDGAR, FRED, Alpha Vantage) | Simulation-only execution, Python stack |
| [Graphiti](https://github.com/getzep/graphiti) | Apache-2.0 | 31.5k | Bi-temporal facts: when a belief became true or was superseded, and when it was recorded; superseded facts are kept, not deleted | Python, Neo4j/FalkorDB backends |
| [Mem0](https://github.com/mem0ai/mem0) | Apache-2.0 | 66.7k | Hybrid keyword (BM25) plus entity retrieval | Embeddings and vector store (out of scope); OpenAI defaults |
| [Letta](https://github.com/letta-ai/letta) | Apache-2.0 | 25.1k | Nothing new: its editable memory blocks overlap with Money Lab's memory | Separate runtime |
| [Halawi et al., 2024](https://arxiv.org/abs/2402.18563) | paper | — | Retrieval, then reasoning, then aggregation of several forecasts nears the human forecaster crowd; evaluation only on questions published after the model's knowledge cutoff | — |
| [Alpha Arena season 1](https://forklog.com/en/four-out-of-six-ai-models-suffer-losses-in-trading-tournament/amp) | results | — | Organisers' finding: "LLMs do not handle numerical time series data well". 4 of 6 models lost money | — |

### Design changes adopted from this research

1. **Code computes indicators, the model reads them** (Alpha Arena). The memory pack gives returns,
   volatility, drawdown, moving-average position and volume ratios computed by code, never raw candles.
2. **Recency decay and importance in retrieval** (FinMem). Items in the memory pack are ranked by a
   computed score: relevance to the context, importance (for example evidence count or money at stake)
   and exponential recency decay with a half-life per store. Lessons and traps decay slowly,
   observations quickly.
3. **Bi-temporal semantic records** (Graphiti). Hypotheses and lessons carry `valid_from` / `valid_to`
   (when the belief held in the market) and `recorded_at` (when the agent wrote it). Superseded
   beliefs are closed, never deleted.
4. **Settle and reflect** (TradingAgents). Already the role of the resolver plus daily consolidation;
   the post-mortem is written once the outcome is known, never before.
5. **Aggregated forecasts for important calls** (Halawi et al.). For predictions above a conviction
   threshold, sample several independent forecasts and record their median probability. Costlier, so
   used only when the budget allows; the threshold is tuned on measured spend.
6. **Optional bull/bear check** (TradingAgents). Before a high-conviction virtual trade, one short
   adversarial pass argues the other side; its arguments are stored with the trade.

Not adopted: vector databases and embeddings (no proven need at this scale, extra cost and
dependencies); Python memory frameworks (second stack).

## 2. Data sources

The agent uses free sources first and may propose paid ones within its monthly budget (decision 0003).
It never creates accounts: the owner subscribes, and the subscription cost counts against the budget.

| Need | Source | Free tier | Paid option | Notes |
| --- | --- | --- | --- | --- |
| Crypto prices, live | Kraken public market-data API | Yes, no key | — | Also gives the order book spread for slippage |
| Crypto history | [Kraken OHLCVT downloads](https://support.kraken.com/articles/360047124832-downloadable-historical-ohlcvt-open-high-low-close-volume-trades-data) | Yes, CSV, 1 min to 1 day, from each pair's first trade to 30 June 2026 | — | Quarterly updates; for code-only reaction statistics |
| Crypto market data | [CoinGecko](https://www.coingecko.com/en/api/pricing) | 10,000 calls/month, 100/min | $35/month | Market caps, broad coverage |
| Stocks and ETFs | [Twelve Data](https://twelvedata.com/pricing) | 8 credits/min, 800/day | $29/month (Grow) | Vendor states real-time US equities, ETFs, forex, crypto on the free plan |
| Stocks and ETFs | [Massive](https://massive.com/pricing) (formerly Polygon.io) | 5 calls/min, 2 years history | $29/month (Starter) | US coverage |
| Stocks, US | [Alpaca market data](https://docs.alpaca.markets/docs/about-market-data-api) | IEX feed, 200 calls/min, history since 2016 | $99/month | Account required; availability to a French resident not verified |
| Company news, calendars | [Finnhub](https://finnhub.io/pricing) | Company and market news, earnings and economic calendars, quotes | Paid tiers | Free rate limit not confirmed on the pages read |
| Macro data, release dates | [FRED API](https://fred.stlouisfed.org/docs/api/fred/releases_dates.html) | Free key; future release dates with `include_release_dates_with_no_data` | — | Inflation, jobs, rates |
| US filings | [SEC EDGAR APIs](https://www.sec.gov/search-filings/edgar-application-programming-interfaces) | Free, no key | — | Submissions and XBRL company facts |
| World news | [GDELT DOC 2.0](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/) | Free | — | Rolling 3-month window, 65 languages, JSON and RSS. Asks for at most one request every 5 s (it answered only that message from the development sandbox on 2026-10-06). Used hourly since step 2. |
| Fed rate decisions | [FOMC calendar page](https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm) | Free, no key | — | Meetings 2021-2027 parsed on 2026-10-06 (56 decision days). Used since step 2. |
| Open web | Anthropic web search and fetch (already in Money Lab) | — | Billed per search plus tokens | Counted in the inference budget |

Excluded: scraping libraries for sites without a public API or whose terms forbid automated access
(for example unofficial Yahoo Finance wrappers).

## 3. Realism constraints for the asset universe

The agent chooses the assets it follows (decision 0003), within rules that keep the virtual training
transferable to real money later:

- Crypto: assets listed on a MiCA-authorised platform reachable from France (Kraken, Coinbase,
  Bybit EU per the feasibility report).
- ETFs: European UCITS ETFs. Under the EU PRIIPs rules, retail brokers generally cannot sell
  US-domiciled ETFs without a KID to EU retail investors
  ([justETF](https://www.justetf.com/news/etf/us-domiciled-etfs.html)).
- Stocks: listed shares with data available from a configured source.
- Size: a bounded watch list (proposal: 30 assets) so data calls and reading stay within budget;
  every addition or removal is recorded with a reason, so universe choices are part of what it learns.

## 4. Open points

- Verify Finnhub's free rate limit and Twelve Data's free-plan data delay with a test key before
  relying on them (slice 7).
- Check whether a French resident can open an Alpaca data account.
- Halawi et al. aggregation: measure the extra cost per prediction before enabling it by default.
