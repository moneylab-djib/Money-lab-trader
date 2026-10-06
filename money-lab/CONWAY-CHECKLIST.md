# Money Lab — Conway installation, funded run and shutdown checklist

Nothing in this checklist has been executed. Every step marked **[owner]** needs the owner's
explicit approval of the concrete resources, credentials, budget and permissions first.
Conway availability, prices and service conditions were **not** verified; check them at the source.

## 0. Before anything is provisioned [owner]

- [ ] Owner-controlled fork/copy of Automaton exists, keeps `LICENSE`, and contains branch
      the Money Lab changes merged on `main`. Record the release commit SHA to deploy: `________`.
- [ ] Mocked checks pass on that commit: `pnpm install --frozen-lockfile && pnpm typecheck && pnpm vitest run src/__tests__/money-lab`.
- [ ] Current Conway prices recorded (sandbox per day, inference per model, any minimums,
      overage rules, subscriptions, prepaid balance behaviour): `________`.
- [ ] Budget approved, distinguishing EUR funding from USD accounting. Illustrative: USD 20 total,
      at most USD 15 provisioned to Conway credits, USD 5 kept outside the agent's control.
      No automatic funding from a larger wallet or payment account.
- [ ] `moneyLab.inference` limits confirmed against real prices (provisional: 5 c/call,
      10 c/hour, 30 c/day, 1024 output tokens). If too small for useful work, change the config
      explicitly and record why; never bypass in code.
- [ ] Payment mode decided: `payments: "allowed"` (agent may buy credits, pay x402 services and
      transfer within `paymentLimits`) or `"disabled"`. Set the caps (`null` = none).
- [ ] Research route decided (permitted HTTP retrieval only, or a scoped search tool + allowance).
- [ ] Help channel: local CLI (`--money-lab help-list`). Telegram is not implemented.

## 1. Install the pinned custom build [owner]

Do **not** use `curl https://conway.tech/automaton.sh | sh`: it clones upstream `main`, runs
`git pull` on updates and would replace the custom build.

```sh
# inside the approved, existing Conway sandbox
node --version            # must be >= 20
git clone <OWNER_FORK_URL> /opt/automaton
cd /opt/automaton
git checkout <PINNED_RELEASE_SHA>
git log -1 --format=%H    # must print the pinned SHA
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm run build
node dist/index.js --version
```

- [ ] Remote of `/opt/automaton` points to the owner fork, not upstream (`git remote -v`).
- [ ] `node dist/index.js --init` and `--provision` only after approval of the wallet/API-key step.
      Put in the agent wallet only the USDC you accept the agent may spend (payments mode).
- [ ] Run `node dist/index.js --setup`, then merge `money-lab/automaton.money-lab.example.json`
      into `~/.automaton/automaton.json`, replacing placeholders with the real sandbox id.
      Keep `maxChildren: 0`.
- [ ] Copy the strategy skill: `mkdir -p ~/.automaton/skills && cp -r money-lab/skills/money-lab-strategy ~/.automaton/skills/`.
- [ ] Pause before first start: `node dist/index.js --money-lab pause "pre-launch check"`.
- [ ] `node dist/index.js --money-lab status` shows the profile, limits, resources and
      "Pause : OUI". An invalid profile must make this command exit with an error.

## 2. Provision credits [owner]

- [ ] Owner adds the approved Conway credits through the Conway dashboard/credits API
      (not through the agent). Record it: `node dist/index.js --money-lab ledger-add credit_purchase <cents> <receipt-ref>`
      and the funding itself: `... ledger-add owner_funding <cents> <ref>`.
- [ ] Check on a block explorer that the agent wallet holds only the USDC you approved
      (record it with `ledger-add owner_funding`).

## 3. Back up state before every run

State lives in `~/.automaton/` (outside the build directory). Back it up before each start,
before upgrades and before shutdown:

```sh
mkdir -p ~/money-lab-backups
/opt/automaton/scripts/backup-restore.sh backup ~/.automaton/state.db ~/money-lab-backups/state-$(date -u +%Y%m%dT%H%M%SZ).db
tar czf ~/money-lab-backups/config-$(date -u +%Y%m%dT%H%M%SZ).tgz -C ~ .automaton/automaton.json .automaton/heartbeat.yml .automaton/skills
```

- [ ] Copy backups off the sandbox to owner storage. `wallet.json` and `config.json` contain
      secrets: store them only in owner-controlled encrypted storage, never in chat/Telegram.
- [ ] Restore: stop the process, then `scripts/backup-restore.sh restore <backup.db> ~/.automaton/state.db`
      and `verify`.

## 4. Supervised smoke run [owner]

- [ ] `node dist/index.js --money-lab resume`, then `node dist/index.js --run` in a supervised
      terminal (tmux/screen), for a short window (e.g. 30–60 minutes).
- [ ] Watch logs for `[MONEY LAB]`, `Policy denied`, `Budget exceeded`.
- [ ] Every 10–15 minutes: `node dist/index.js --money-lab status` — inference cost today vs cap,
      experiments, open help requests.
- [ ] Verify at least: one experiment recorded; a disabled tool attempt is denied; pause from a
      second terminal stops new inference before the next turn; resume works.
- [ ] Compare Conway's billing view with `Inférence consommée`. Record discrepancies.
- [ ] Stop with `Ctrl-C` (state set to sleeping) and pause.

## 5. Bounded experiment [owner]

- [ ] Approve the run window and review date. The review date is not permission to spend more.
- [ ] Daily: `node dist/index.js --money-lab summary` (French daily summary) and answer help
      requests with `help-resolve <id> "<note>"` / `help-reject <id> "<note>"` only after the
      prerequisite is really satisfied.
- [ ] Import provider-confirmed revenue only from provider reports
      (`ledger-add confirmed_revenue <cents> <provider-ref> --provider-import`), and cash only when
      received (`cash_received`). Estimated ad income stays `estimated_revenue`.
- [ ] If the runtime pauses ("coût d'inférence inconnu", "limite per_call", "prix inconnu"), reconcile against Conway billing or fix the profile,
      record the amount, then `resume`.

## 6. Shutdown and resource stop [owner]

Pausing the agent does **not** stop Conway billing.

1. [ ] `node dist/index.js --money-lab pause "end of run"`; stop the process (`Ctrl-C`).
2. [ ] Final `--money-lab summary` saved to owner storage.
3. [ ] Back up state (section 3) and copy it off the sandbox.
4. [ ] Review published-service obligations: active users, pending deliveries, refunds,
       promises on the page. Decide: keep a low-cost artifact online (only if hosting cost and
       obligations fit the envelope) or take it down with notice.
5. [ ] Remove exposed ports (`remove_port`) or stop the web process if the service is taken down.
6. [ ] List all Conway resources in the account (sandboxes, domains, subscriptions), including
       those the agent created itself, and compare with `moneyLab.resources` and the experiment
       journal. Record each one's cost; delete those you do not keep.
7. [ ] Stop/delete the sandbox and cancel any subscription via the Conway dashboard/API **after**
       the backup is verified off-box.
8. [ ] Record final hosting/external costs in the ledger and report separately: working
       artifact, independent genuine usage, provider-confirmed revenue, money received,
       repeatable positive contribution.
