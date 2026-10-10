# Research notes: controlled deployment of steps 0.1-0.3 to Sonni's VPS

Read-only analysis of 2026-10-10 on main b0479a3 (steps 0.1 CI gate, 0.2 trade fees and 0.3 price
precision merged). Five readers each mapped one area with file:line evidence: backups, the VPS-to-main delta,
startup and Telegram, the audit and pending orders, and the Likma go-live method. No VPS was reachable from the
sandbox: every VPS fact below comes from the repository and has to be confirmed by the owner's read-only survey.

## What the VPS runs

- The repository cannot tell. The last owner observation is "VPS updated to main (6 assets)" on 2026-10-08,
  15:46 UTC (docs/STATUS.md). The running code does not log its commit: the start banner prints the constant
  VERSION 0.2.1 (src/index.ts). The deployed commit is somewhere in 4c015b0 (PR #25) .. fd5916d (PR #29);
  the owner reads it with `sudo -u sonni -H git -C /opt/sonni log -1`.
- From fd5916d to b0479a3: no DDL, no change to config.ts, the example config, configure.mjs, the env file,
  the systemd units, package.json or the lockfile. Only TypeScript runtime code and the read-only
  sonni/vps/audit-prix.mjs change. An older base (before 6c0aa67, PR #27) also changes the lockfile
  (simple-git removed), so `pnpm install --frozen-lockfile` is part of the update.
- First start of main on existing data:
  - step 0.1 only changes the token counter;
  - step 0.2 reads trade results, the win rate and open positions after every fee. Nothing stored is
    rewritten. Day, week and month summaries that are not stored yet are written once, after fees;
  - step 0.3: brokerTick runs seconds after start (timers fire at once). With a stored position code cannot
    value (pre-0.3 Infinity quantity or zero average cost), pending buys become `rejected` (suspended), pending
    sales or stops on it `rejected` (position), and snapshots, decisions and its horizon wake are suspended.
    With clean data only the 12-digit prices and the display change.
- configure.mjs rewrites ~/.automaton/automaton.json. No key changed since 4c015b0, so this deployment skips
  it, which is one fewer VPS change and no risk of losing a hand edit.
- The guide's update block (sonni/GUIDE-VPS.fr.md, "Mettre Sonni à jour") pulls whatever main is
  (`git pull`), installs and builds while the old process still runs. The runtime imports some modules lazily
  (src/agent/tools.ts, src/agent/loop.ts), so the old process could load a new module. The controlled
  procedure stops Sonni first and pins the approved commit with `git merge --ff-only <sha>`.

## Backups today

- Daily copy: an hourly task, also run at start (src/index.ts), calls backupStateDaily
  (src/money-lab/backup.ts). That function uses better-sqlite3's db.backup() (SQLite online backup API) to
  write `~/.automaton/backups/state.db.backup-YYYY-MM-DD` (UTC), switches the copy to journal_mode DELETE and
  keeps 7 copies in a 0700 folder. Guard G7 reopens the copy read-only and checks integrity_check and that
  8 tables hold at least the live row counts. It records no hash. A copy that fails G7 keeps the day's name
  and is not retried that day.
- One copy a day: once today's file exists, backupStateDaily returns null. A restart on deployment day makes no
  fresh copy, and the newest copy can be up to 24 h old.
- Nightly export (sonni-backup-export.timer, 02:30 UTC, export-backup.mjs) publishes the newest copy with a
  .sha256 for the PC. The PC pulls it at 05:15 (backup-pull.ps1, SHA-256 checked, never opened with SQLite).
  STATUS.md says this PC copy has never been observed working.
- Restore exists only as prose (GUIDE-PC.fr.md "Ne restaure rien seul", MEMORY.md "Restoring is a manual step
  with the owner"). No script or test puts a copy back at ~/.automaton/state.db. Nothing sets aside a stale
  state.db-wal/-shm, which SQLite could replay into the restored file. Nothing compares counts or hashes after
  a restore.
- The guide's "Arrêter Sonni" backup is `cp state.db` after a stop. It does not check that no -wal/-shm is
  left, and has no integrity check and no hash.
- The VPS has Node 22 and better-sqlite3 11.10.0 in /opt/sonni/node_modules, and no sqlite3 command-line tool.
  New tools are therefore Node scripts under /opt/sonni/sonni/vps, run as the sonni user.
- The operator CLI (`node dist/index.js --sonni statut`) opens the database read-write. It runs
  integrity_check, DDL, migrations, the catalog upsert and the seed identity, so it must never be pointed at a
  copy or used as a read-only check.

## SQLite facts (checked with better-sqlite3 11.10.0 in a scratch WAL setup, not on Sonni's data)

- A `{ readonly: true }` + `query_only` connection sees commits from a concurrent writer and gets
  SQLITE_READONLY on any write. `.backup()` from that read-only connection gives a consistent copy.
- A read-only open of a WAL database whose writer is stopped creates -wal/-shm files and leaves them. The
  tools therefore never open the live file when no -wal is beside it: they byte-copy it, or refuse.
- `db.backup(dest, { progress: () => 1e9 })` copies everything in one step, which gives one consistent
  snapshot even while the service writes.

## The price audit and what it missed

- audit-prix.mjs (step 0.3) reads a private copy and reports invalid figures, market fills below 10 EUR
  against the market price, and averaged positions against a ledger replay. It exits 0 when it finds points,
  and 0 when Sonni's tables are absent. Section 2 drift never counts as a problem: a copy with an 18.7 % fill
  drift concluded "rien à réparer".
- It does not look at:
  - pending orders and what the first tick does with them (a fill at an old stored price after a pre-0.3
    broker failure, an expiry, a rejection while a position is corrupt);
  - positions without a stop, or stops the last price already crossed;
  - cash, or ledger-versus-position quantities for single-buy positions;
  - the link between orders, ledger rows and trades;
  - integrity_check, the copy's freshness, the restart's paid-cycle rule, and recent incidents.
- A builder probe (a copy with a crossed stop, a position without a stop, a 5-day-old pending market buy,
  negative cash and a quantity mismatch) got "rien à réparer", exit 0.
- Its exit code is kept: step 0.3 shipped it and its tests pin it. The gate is a new script,
  controle-predeploiement.mjs, which imports the audit's sections. The audit's output was proved byte-identical
  after the refactor on six copies (commit 040060a).

## Startup, paid calls and Telegram

- Sleep rule (src/index.ts, "Redémarrage pendant le sommeil"): a restart skips the paid cycle only when kv
  agent_state = 'sleeping', kv sleep_until is more than 60 s ahead and no inbox message is unprocessed. In
  every other case the first loop runs a paid cycle. `/reprendre` after `/pause` always inserts an operator
  wake (a paid cycle), so the procedure does not use /pause.
- With Restart=always and RestartSec=30, a crash after the loop starts restarts every 30 s. Each restart
  that is not asleep pays a cycle, bounded only by the in-process caps. That is a rollback trigger.
- Healthy-start evidence that can be read without writing:
  - new trader_prices rows for each followed asset after the start;
  - inference_costs rows since the start (created_at in `datetime('now')` format, UTC);
  - trader_incidents since the start (kind 'broker' or 'backup');
  - rejected orders;
  - kv money_lab.health_events;
  - the unsent money_lab_outbox backlog.
- Nothing is pushed to Telegram at start, and incidents are never pushed (/technique, the morning report).
  Queuing a report through money_lab_outbox would write to the live database, take from Sonni's 30-a-day
  message quota and fail exactly when the service is down. The report is therefore sent by a separate
  send-only script run as root. It reads TELEGRAM_BOT_TOKEN (named by moneyLab.telegram.botTokenEnv) from
  /etc/sonni.env and moneyLab.telegram.ownerChatId from automaton.json. It never calls getUpdates, whose
  offset belongs to the service.

## Go-live method (Likma delivery/production-readiness)

High-risk tier: the history is the product and paid inference runs. The gates that apply:
- a restore-tested backup with measured restore time (RTO) and data loss (RPO);
- a rehearsed rollback with triggers written down before starting;
- the owner as the only decider;
- post-start smoke checks and an observation window.

Load tests, rate limits, HTTP headers, a status page and legal retention do not apply: there is no public
endpoint and no real money (decision 0001). The default verdict is NO-GO until each gate has executed
evidence.

## Rollback rehearsal

Filled in from the rehearsal run of 2026-10-10 (old builds opening data written by main); see below.
