# Architecture decision 0005: a second brain on the owner's PC, and the plan of 2026-10-08
- Status: accepted (owner, 2026-10-08: "je suis d'accord avec ton plan", "je veux tout implémenter",
  "le mode par défaut du second cerveau doit être assistant", "pas besoin de prendre le coût de l'IA
  locale en compte")
- Date: 2026-10-08
- Context and constraints: on 2026-10-07 Sonni kept its 1,000 virtual EUR in cash, idle wakes cost
  about a third of the day's non-restart spend, and post-mortems quoted numbers the model computed
  wrongly ("margin ~27 %" for 2.7 %). The owner has a Windows desktop (Ryzen 5 5500, 32 GB RAM,
  Radeon RX 9070 XT 16 GB) that can run 24/7, and asked for more assets, Opus for the big decisions
  and the best memory approach research supports. Research of the day: docs/RESEARCH.md section 5.
- Decision, in four steps, one pull request each, observed on the VPS between steps:
  1. Decide for real: an explicit decision per followed asset every few hours (staying out included,
     scored by code); code's odds stored with every prediction and a skill score against them; big
     buys (`portfolio.bigOrderPct`, 20 % of the portfolio) confirmed by the stronger model within
     half of the daily cap; the "is it learning?" scoreboard in /bilan.
  2. A living universe: gold (PAXG/EUR), US equities (SPYx), the dollar against the euro (USDC/EUR)
     and Nvidia (NVDAx) besides BTC and ETH; tokenized stocks are USD-quoted on Kraken's
     `tokenized_asset` class and converted to EUR by code; a weekly screen computed by code proposes
     candidates and Sonni rotates a few satellite slots with written reasons, the owner's core list
     and veto staying authoritative.
  3. A second brain on the owner's PC: llama.cpp `llama-server` (Vulkan) reached by the VPS through
     Tailscale only, with an API key; modes off, assistant (default), parallel and delegated, chosen
     by the owner with a Telegram command and enforced by code. Delegation of a task category needs
     the owner's decision on measured evidence. The second brain never places an order, never writes
     a statistic and its outputs are untrusted data. The VPS owns a job queue with leases, expiry and
     idempotent results: a PC that stops mid-task loses nothing, Sonni falls back to the free
     readers, code's watches and Claude, and resumes with the freshest jobs first. The PC also keeps
     a nightly verified copy of the memory.
  4. Memory v2: three levels (vital, situational, archive), SQLite FTS5 search, an outcome embargo,
     lessons kept as items with code-computed counters edited in small steps (never rewritten as a
     whole), day/week/month summaries linked to their sources, similar-case retrieval on code's
     market features, market-regime tags, and a recall evaluation set.
- Cost: the electricity and hardware of the owner's PC are outside Sonni's 50 EUR/month budget (the
  owner's decision), like the VPS (decision 0004). Unknown cost is still never free for the
  Anthropic and paid-data spend.
- Scope exception: a semantic index inside SQLite (for example sqlite-vec with embeddings computed on
  the owner's PC) is accepted in principle as an exception to the "no vector database" rule, and is
  built only if the recall evaluation shows that keyword search misses what Sonni needs. No hosted
  memory service and no separate database server.
- Alternatives and trade-offs: letting the local model decide directly (cheaper, but weaker
  calibration and a record that no longer says who learned what); hosted memory services and graph
  databases (more moving parts, no independent evidence of gains); keeping two assets (Sonni learns
  the same lesson twice: ETH/BTC daily correlation 0.90 over a year).
- Reversibility and migration: every new store is append-only and additive; the second brain is
  optional at every moment (mode off, or the PC offline) and holds no state of its own.
- Evidence: owner messages of 2026-10-08; research reports of 2026-10-08 (docs/RESEARCH.md section 5).
- Revisit trigger: the recall evaluation (semantic index), the parallel mode's measured accuracy
  (delegation), or the real-money phase.
