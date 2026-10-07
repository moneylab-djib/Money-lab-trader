# First usable slice

Proposed slice: **the bot makes its first recorded prediction from live prices and its memory, and
code resolves it.** This is the smallest loop that exercises the core of the project: memory read
before a decision, an honest record, a measured outcome, and evidence written back to memory.

## Contract
- User and action: the owner starts the trader; it collects BTC and ETH prices, runs a decision
  session, records predictions, and the owner sees them resolved in `/statut`.
- Input, processing and visible result:
  - Input: Kraken public prices every 5 minutes for BTC/EUR and ETH/EUR; a seed of 5 owner-approved
    hypotheses (no full intake yet).
  - Processing: code builds a memory pack; Sonnet 5.5 records at least one prediction with a
    probability, a condition and a horizon, linked to a hypothesis; at the horizon, code resolves it
    and appends evidence.
  - Visible result: Telegram `/statut` (French) lists open and resolved predictions with their Brier
    score, and the linked hypothesis with its updated evidence count.
- Real data source/storage: Kraken public market data; SQLite `state.db`.
- Permissions and failure states: no exchange key; Kraken unreachable → collection retries, no decision
  on stale prices (older than 15 minutes); malformed model output → prediction rejected and logged;
  budget exhausted → session skipped and owner notified.
- Numbered acceptance criteria:
  1. Prices are stored every 5 minutes and survive a process restart.
  2. No prediction can be recorded when the asset's latest price is older than 15 minutes.
  3. A prediction cannot be recorded without probability (0 to 1), condition, horizon and hypothesis link.
  4. A recorded prediction cannot be updated or deleted through the agent's tools.
  5. At its horizon, code resolves the prediction from stored prices and computes its Brier score.
  6. Resolution appends one evidence row to the linked hypothesis and updates its computed confidence.
  7. `/statut` shows open and resolved predictions in French.
  8. Tests make no network or paid inference calls (fake Kraken and fake Anthropic, as in Money Lab).
- Named checks covering each criterion (likma.project.json): `sonni` (src/__tests__/trader, all eight
  criteria) and `sonni-e2e` (sonni/e2e.mjs: real built process against fake Kraken, Anthropic and
  Telegram; criteria 1, 7 and 8), plus `types`, `build` and the `money-lab` regression suite.
- Resolution detail: the resolution price is the first stored price at or after the horizon, at most
  `staleMinutes` later; when none exists, the prediction is voided (no score, no evidence) rather than
  judged on a price from another time.

## Evidence
Exercise the real entry point against fake APIs first (end-to-end harness), then one supervised live
run approved by the owner. Record commands, results and the spend of the live run.

## Scope
No virtual orders, news, events or weekly review in this slice; they follow in later slices
(see docs/PLAN.fr.md).
