/**
 * Catalog of free public data sources Sonni can enable on its own
 * (src/trader/sources.ts). Each entry is data: a URL, a cadence and the
 * JSON paths of the numbers to keep. Keyed sources name the environment
 * variable that holds the owner's free key; "{key}" in the URL is replaced
 * at fetch time. Formats checked against the providers' public
 * documentation on 2026-10-07 (docs/RESEARCH.md); a changed format shows
 * up as "metric absent" in /sources, never as a wrong number.
 */

export interface SourceMetric {
  name: string;
  /** Dotted JSON path: keys, indexes (negative from the end), "*" for the first key. */
  path: string;
  /** Multiply the raw value, e.g. 100 to turn a ratio into a percentage. */
  scale?: number;
}

export interface SourceDef {
  id: string;
  label: string;
  url: string;
  everyMinutes: number;
  metrics: SourceMetric[];
  keyEnv?: string;
  /** What the numbers mean, for the model's manage_source list. */
  note: string;
}

export const SOURCE_CATALOG: SourceDef[] = [
  {
    id: "fear_greed",
    label: "Crypto Fear & Greed (alternative.me)",
    url: "https://api.alternative.me/fng/?limit=1",
    everyMinutes: 240,
    metrics: [{ name: "index", path: "data.0.value" }],
    note: "0 = extreme fear, 100 = extreme greed; a sentiment composite updated daily.",
  },
  {
    id: "coingecko_global",
    label: "Crypto market (CoinGecko global)",
    url: "https://api.coingecko.com/api/v3/global",
    everyMinutes: 60,
    metrics: [
      { name: "market_cap_eur", path: "data.total_market_cap.eur" },
      { name: "btc_dominance_pct", path: "data.market_cap_percentage.btc" },
      { name: "eth_dominance_pct", path: "data.market_cap_percentage.eth" },
      { name: "cap_change_24h_pct", path: "data.market_cap_change_percentage_24h_usd" },
    ],
    note: "Whole-market capitalisation, BTC and ETH shares, 24 h change.",
  },
  {
    id: "kraken_spread_btc",
    label: "Kraken BTC/EUR order book top",
    url: "https://api.kraken.com/0/public/Depth?pair=XBTEUR&count=1",
    everyMinutes: 30,
    metrics: [
      { name: "ask", path: "result.*.asks.0.0" },
      { name: "bid", path: "result.*.bids.0.0" },
    ],
    note: "Best ask and bid; their gap is the spread your virtual orders would pay.",
  },
  {
    id: "mempool_fees",
    label: "Bitcoin network fees (mempool.space)",
    url: "https://mempool.space/api/v1/fees/recommended",
    everyMinutes: 60,
    metrics: [
      { name: "fastest_sat_vb", path: "fastestFee" },
      { name: "hour_sat_vb", path: "hourFee" },
    ],
    note: "Recommended fee rates in sat/vB: on-chain demand and congestion.",
  },
  {
    id: "defillama_eth_tvl",
    label: "Ethereum DeFi TVL (DefiLlama)",
    url: "https://api.llama.fi/v2/historicalChainTvl/Ethereum",
    everyMinutes: 360,
    metrics: [{ name: "tvl_usd", path: "-1.tvl" }],
    note: "Value locked in Ethereum DeFi, in USD: on-chain activity on ETH.",
  },
  {
    id: "fred_fedfunds",
    label: "Fed funds effective rate (FRED)",
    url: "https://api.stlouisfed.org/fred/series/observations?series_id=FEDFUNDS&api_key={key}&file_type=json&sort_order=desc&limit=1",
    everyMinutes: 1440,
    metrics: [{ name: "rate_pct", path: "observations.0.value" }],
    keyEnv: "FRED_API_KEY",
    note: "Monthly effective federal funds rate, in %.",
  },
  {
    id: "fred_us10y",
    label: "US 10-year Treasury yield (FRED)",
    url: "https://api.stlouisfed.org/fred/series/observations?series_id=DGS10&api_key={key}&file_type=json&sort_order=desc&limit=1",
    everyMinutes: 1440,
    metrics: [{ name: "yield_pct", path: "observations.0.value" }],
    keyEnv: "FRED_API_KEY",
    note: "Daily 10-year yield, in %: the risk-free benchmark.",
  },
  {
    id: "fred_cpi",
    label: "US CPI index (FRED)",
    url: "https://api.stlouisfed.org/fred/series/observations?series_id=CPIAUCSL&api_key={key}&file_type=json&sort_order=desc&limit=1",
    everyMinutes: 1440,
    metrics: [{ name: "index", path: "observations.0.value" }],
    keyEnv: "FRED_API_KEY",
    note: "Monthly consumer price index level (1982-84 = 100).",
  },
];

/** Enabled the first time the catalog is loaded; the model may change this with reasons. */
export const DEFAULT_ENABLED_SOURCES: string[] = ["fear_greed", "coingecko_global", "kraken_spread_btc", "mempool_fees"];
