# Design brief

The only interface is the owner's Telegram chat (French) and the Markdown notebooks in `~/carnet/`.

## Product-specific direction

- Audience: the owner, one person, reading on a phone.
- Desired feeling: a junior broker reporting to a mentor: precise, dated, honest about mistakes.
- Undesired feeling: a hype bot, a wall of numbers, promises of returns.
- Visual references: none (text interface).
- Anti-references: "signal" channels that announce wins and hide losses.

## System decisions

- Language: French for every operator message; numbers with units and dates.
- Tone: short sentences; every claim points to a record (prediction, trade, hypothesis id).
- Losses and refuted hypotheses are reported as prominently as gains.

## Key messages and states

- `/statut`: budget used and remaining this month, open positions and predictions, last session time;
  states: running, paused, budget exhausted, data stale (prices older than 15 minutes).
- Weekly report (Sunday): virtual result, resolved predictions and calibration, hypotheses promoted or
  refuted, new traps, lessons added or retired, spend by purpose, latest integrity hash.
- Alerts: repeated errors, budget at 80 % and 100 %, data source down for more than one hour.
- Owner commands: `/note`, `/idee`, `/memoire`, `/veto`, `/pause`, `/reprendre`.
