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

## 5. Research of 2026-10-08: memory at scale, a local second brain, more assets

Three research passes on 2026-10-08 (web pages and Kraken's public API read that day), for the plan in
docs/decisions/0005. Vendor claims are labelled; figures computed by us are labelled too.

### 5.1 Long-term memory as the data grows

- Benchmarks: headline scores are mostly vendor claims and not comparable. Mem0 reports 92.5 on LoCoMo
  and 94.4 on LongMemEval for its 2026 algorithm ([vendor](https://mem0.ai/research)); in its own 2025
  paper a full-context baseline reportedly beat it (seen second-hand in
  [Zep's rebuttal](https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/),
  vendor against vendor). Letta's agent with plain files and grep scored 74.0 % on LoCoMo
  ([vendor, 2025-08-12](https://www.letta.com/blog/benchmarking-ai-agent-memory)). An independent audit
  found 6.4 % of LoCoMo's answers wrong and a lenient judge
  ([Penfield Labs, 2026-04-08](https://penfieldlabs.substack.com/p/we-audited-locomo-64-of-the-answer)).
  Conclusion: build a small Sonni-specific recall evaluation instead of choosing by leaderboard.
- What measurably helps ([LongMemEval, ICLR 2025](https://arxiv.org/abs/2410.10813), academic):
  fact-augmented index keys (+9.4 % recall), time-range filtering (+6.8 to +11.3 % recall on temporal
  questions); the reading format alone moves results by up to 10 points.
- Hybrid keyword plus dense search gives mixed gains once the agent searches iteratively (preprints,
  for example [arXiv 2608.29606](https://arxiv.org/pdf/2608.29606)).
- Lessons as items, not rewrites ([ACE, ICLR 2026](https://arxiv.org/abs/2510.04618), academic): items
  with helpful/harmful counters and small edits; full rewrites caused "context collapse" (18,282 tokens
  to 122, accuracy below baseline); without reliable ground truth, lessons polluted the context.
- Evidence kept apart from beliefs: [Hindsight](https://arxiv.org/abs/2512.12818) (MIT licence).
- Trading memory ([Agentic Trading survey, 2026-05](https://arxiv.org/html/2605.19337v1), academic):
  no dominant architecture; failure modes are outcome leakage when a past case is retrieved with its
  story ("Oracle Fallacy"), stale cases after a regime change, poisoning from uncurated sources and
  lost-in-the-middle; remedies: outcome embargo, decay, provenance, replayable snapshots.
  [META (2026-09)](https://arxiv.org/html/2609.28771): retrieval on indicator vectors beat text
  embeddings (64.0 % against 56.0 % directional accuracy); results unstable before about 300 trades.
- Sleep-time compute ([Letta and UC Berkeley](https://huggingface.co/papers/2504.13171)): pays only when
  future questions are predictable from stored context; Sonni's evening consolidation plays that role.
- Practical: SQLite FTS5 with the `unicode61 remove_diacritics 2` tokenizer (the Porter stemmer is
  English-only); sqlite-vec (about 8.2k stars, 0.1.x, last release 2026-05) as a later, measured option;
  small multilingual embedding models: Qwen3-Embedding-0.6B (Apache-2.0), EmbeddingGemma-300M,
  multilingual-e5-small, bge-m3 (licences to re-check before use).
- Adopted for memory v2 (step 4): FTS5 with recency and importance weights and time filters; an outcome
  embargo; lessons as items with code-computed support and contradiction counts; day/week/month
  summaries linked to their sources; similar cases by code's market features; market-regime tags; a
  recall evaluation set. Gated: the semantic index (decision 0005). Avoided: hosted memory services,
  graph databases, LLM-written links on every write, model-written confidence scores.

### 5.2 A local second brain on the owner's PC

PC: Ryzen 5 5500 (no integrated GPU), 32 GB DDR4-3200, Radeon RX 9070 XT 16 GB (RDNA 4, gfx1201),
Windows; PCIe 3.0 link.

- Runtime: llama.cpp `llama-server` with the Windows Vulkan build: OpenAI-compatible chat and
  embeddings endpoints, JSON-schema `response_format`, `--api-key`, loopback binding by default
  ([server README](https://raw.githubusercontent.com/ggml-org/llama.cpp/master/tools/server/README.md)).
  On this card Vulkan generated faster than ROCm in a secondary benchmark (Qwen3.5-9B 92.3 against
  81.7 tokens/s; [localaimaster, 2026-08-09](https://localaimaster.com/blog/rx-9070-xt-local-ai)).
  Ollama's Windows ROCm list does not include the 9070 XT, it has no built-in authentication and had an
  unauthenticated memory leak fixed in 0.17.1 ([CVE-2026-7482 report](https://lilting.ch/en/articles/ollama-cve-2026-7482-memory-leak)):
  not used. AMD's HIP SDK 7.2 lists gfx1201 on Windows
  ([AMD](https://rocm.docs.amd.com/projects/install-on-windows/en/docs-7.2/reference/system-requirements.html)).
- Models (16 GB VRAM): gpt-oss-20b MXFP4 (about 12.8 GiB, fully on the GPU, about 92 tokens/s measured on
  this card under Linux); Qwen3.6-35B-A3B UD-Q4_K_M (about 22 GB, Apache-2.0, part of its experts in
  system RAM; not measured on this card, estimated 25 to 40 tokens/s); Qwen3.5-9B and Gemma 4 12B as
  small fallbacks. Choice for Sonni: Qwen3.6-35B-A3B for quality in French and reasoning, confirmed by an
  offline comparison on 50 real Sonni reader tasks before it is fixed; gpt-oss-20b as the fallback.
  Known issue: schema-constrained JSON with gpt-oss's Harmony format has had bugs in several runtimes
  ([llama.cpp discussion](https://github.com/ggml-org/llama.cpp/discussions/15341)): code validates
  every answer and retries.
- Link: Tailscale (free Personal plan, non-commercial): the VPS is tagged and a single grant lets it
  reach the PC's port and nothing else; the server stays on loopback or the Tailscale interface, with an
  API key; no router port is opened ([pricing](https://tailscale.com/pricing),
  [run unattended](https://tailscale.com/kb/1088/run-unattended), [serve](https://tailscale.com/kb/1312/serve)).
- Always-on Windows: sleep and hibernation off, BIOS power restore on, pinned AMD driver, a start task
  at logon checked after a reboot (Vulkan from a session-0 service is unverified). Power draw estimated
  at 60 to 80 W idle and 250 to 330 W under load (estimates, not measurements); the owner does not
  count it against Sonni's budget (decision 0005).

### 5.3 Assets with different drivers (Kraken public API, 2026-10-08)

Correlations are our own Pearson correlations of daily log returns against XBTEUR over 365 days
(90 days in brackets); volumes are 24-hour base volume times VWAP; spreads are single snapshots.

| Asset | Kraken pair (altname, wsname) | Driver | Corr. with BTC | Volume / day | Notes |
| --- | --- | --- | --- | --- | --- |
| ETH (followed) | ETHEUR, ETH/EUR | crypto | 0.90 (0.87) | — | repeats BTC |
| Gold | PAXGEUR, PAXG/EUR | safe haven, real rates | 0.31 (0.49) | about 0.5 M EUR | thin book; MiCA status not verified |
| US equities | SPYxUSD, SPYx/USD | risk appetite | 0.35 | about 0.8 M USD | `asset_class=tokenized_asset` needed on Ticker, OHLC and Depth; USD only (EUR via Kraken's EURUSD); history from 2025-08-14; weekends without trades |
| Dollar vs euro | USDCEUR, USDC/EUR | Fed against ECB | −0.17 (−0.28) | about 114 M EUR | lowest volatility (6 %/year) |
| Nvidia | NVDAxUSD, NVDAx/USD | one stock, AI cycle, quarterly earnings | 0.35 | about 0.28 M USD | same caveats as SPYx (owner's choice) |
| SOL (runner-up) | SOLEUR, SOL/EUR | high-beta crypto | 0.86 (0.83) | about 8.3 M EUR | beta 1.3 against BTC |
| HYPE (runner-up) | HYPEEUR, HYPE/EUR | exchange token | 0.44 (253 days) | about 2.2 M EUR | EUR pair since 2026-01-28 |

Rejected: XRP (0.86) and LINK (0.81) duplicate BTC; QQQx and GLDx too thin; XAUT and USDT are on
Kraken's EEA restriction list ([geographic restrictions, updated 2026-09-30](https://support.kraken.com/articles/360001368823-geographic-restrictions)).
Tokenized US stocks opened to EU clients in September 2025
([Bloomberg, 2025-09-10](https://www.bloomberg.com/news/articles/2025-09-10/kraken-expands-tokenized-us-stocks-to-eu-clients)).
Unverified: PAXG's MiCA status; whether EEA retail can trade Kraken's EURUSD pair (used only as a data
feed).
