# Research notes: price precision of the paper broker (step 0.3)

Read-only analysis of 2026-10-09 on main c1638c0 (five readers, a designer and an adversarial critic; every
"before" figure measured with throwaway probes on the code of that commit, then deleted). Owner decisions of
the same day are in docs/plans/price-precision.md.

## What the old broker did

- Fill prices and the average cost went through `round2` (src/trader/portfolio.ts, before step 0.3), the
  helper meant for EUR amounts. A 100 EUR market buy at P filled at round2(P × 1.0005):
  - USDC 0.8936 (Kraken, 2026-10-09) filled at 0.89, 0.40 % below the market (slippage −0.40 EUR, a gift);
    USDC 0.855 at 0.86 (+0.58 %), so a flat round trip cost 2.73 EUR instead of 1.69;
  - an asset at 0.0123 filled at 0.01 (−18.7 %, a false open gain of +22.02 EUR);
  - below 0.005 EUR the fill price was 0 and the quantity (amount − fee) / 0 = Infinity. SQLite stores it as
    REAL 9e999 and `CHECK (quantity >= 0)` lets it through; the average cost became 0, the equity Infinity,
    so the position cap could refuse nothing. The next add or sale bound NaN as NULL and threw
    "NOT NULL constraint failed" on every tick: later orders, stops and the daily snapshot stopped.
- Averaged positions drifted: USDC 0.86 then 0.869 gave a −0.58 EUR gap between the trades and the portfolio
  result; ADA 0.20 then 0.2149 a 2.70 EUR gap.
- `round8` (quantities) is not idempotent from 2^25 (about 33.5 M) units: doubles there are 7.45e-9 apart,
  finer than the 1e-8 grid, so re-rounding a stored quantity can move it up a step and a sale of "all" then
  exceeds the position (measured at 2.61147e-6 EUR: 37,967,284.62804712 units).

## Kraken facts (sourced, version-bound to 2026-10-09)

- AssetPairs documents `pair_decimals` (price decimals), `lot_decimals`, `cost_decimals`, `ordermin`,
  `costmin` and `tick_size`; `fees` and `fees_maker` are deprecated since 8 September 2026.
  Source: https://docs.kraken.com/api/docs/rest-api/get-tradable-asset-pairs
- Ticker and OHLC return prices as strings. Sources: https://docs.kraken.com/api/docs/rest-api/get-ticker-information,
  https://docs.kraken.com/api/docs/rest-api/get-ohlc-data
- Live sweep of https://api.kraken.com/0/public/AssetPairs and Ticker on 2026-10-09: 501 online EUR pairs, 431
  below 1 EUR, 155 below 0.01, 113 below 0.005 (the cheapest REKT/EUR at 7.7e-8). 56 pass the 250,000 EUR
  satellite gate (src/trader/universe.ts); two of them are below 0.005 EUR: PEPEEUR (3.482e-6) and PUMPEUR
  (0.004885). `pair_decimals` runs from 0 to 10 (only 27 pairs quote with 2 decimals or fewer); `lot_decimals`
  is 5 or 8, so 1e-8 quantities never lose a lot digit.
- The project reads AssetPairs only for the universe (altname, base, quote, tokenized); prices are stored raw
  and finite (`CHECK price > 0`); only the broker rounded prices.

## Options weighed

1. Raw doubles for unit prices: exact, but float noise in stored values (60130.049999999996).
2. **12 significant digits (chosen)**: `Number(v.toPrecision(12))` keeps BTC and ETH fills on their cents
   (60130.05), keeps 3.483741e-6 whole, needs no metadata. Finite and positive checks stay mandatory: rounding
   cannot hide 0, NaN, Infinity or an underflow (1e-320 stays 1e-320).
3. Kraken's tick per pair: closest to the exchange but needs pair metadata at fill time, more code and more
   failure modes; not needed for a virtual broker.
4. A price floor: a strategy change the owner declined (assets below 0.01 EUR stay allowed).
5. Decimal arithmetic: too wide for one targeted change.

## Effect on BTC and ETH

12-digit fills move a BTC/ETH fill by at most 0.005 EUR a unit, so for 100 to 300 EUR orders sale proceeds move
by at most 0.0015 EUR. Over 20,000 random round trips per asset the result and the cash move by exactly one cent
in 0.10 % (BTC), 1.1 % (ETH), 1.05 % (PAXG) and 10 % (stocks at 120 to 700 EUR) of round trips, never more; the
new figure is the exact one (the old one used a cent-rounded fill price). Existing tests pinning BTC and ETH
figures pass unchanged.

## Out of scope, kept as follow-ups

- Capping an aberrant but positive Kraken quote (bid 0.01 against ask 60,010 gives about 100 % slippage): a
  fee-model change the owner deferred; zero, negative, crossed or non-finite quotes already fall back to 5 bps.
- The consistency check's tolerance (larger of 0.50 EUR and 3 %) cannot flag a wrong price below about
  0.5 EUR; its facts now keep small prices exactly and display them readably.
- French quantities are printed with a decimal point (115.34883721), as before.
