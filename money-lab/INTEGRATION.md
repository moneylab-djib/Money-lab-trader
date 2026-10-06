# Money Lab — integration note

Status: development build, mocked tests only. Not launched, not funded, nothing published.
Specification: `MONEY_LAB_CORE_SPEC_v0.1.md` (lean first-run scope), amended by the owner on
2026-10-04: maximum agent freedom except replication, with optional price caps.

## Upstream baseline

| Item | Value |
| --- | --- |
| Repository | https://github.com/Conway-Research/automaton (MIT, `LICENSE` retained unchanged) |
| Pinned commit | `d8f816881fd24b6f5e3d616e59edec387a447667` (2026-08-26, "it's beautiful") |
| Package | `@conway/automaton` 0.2.1 |
| Verified | `origin/main` at clone time (2026-10-03) was this exact commit |
| Toolchain used | Node 22, pnpm 10.28.1 (`packageManager`), lockfile unchanged |

## Reused, not duplicated

| Need | Existing module used |
| --- | --- |
| Agent loop, tools | `src/agent/loop.ts`, `src/agent/tools.ts` |
| Policy | `PolicyEngine` + `createDefaultRules` (one extra rule, no-op without the profile) |
| Inference limits | `InferenceRouter` + `InferenceBudgetTracker` + `inference_costs` table |
| Storage | Same SQLite `state.db`; `kv` table for pause/no-progress; three small tables for the journal |
| Wake/sleep | `wake_events`, `sleep_until`, heartbeat daemon |
| Prompt | `buildSystemPrompt` (one code-owned section) |
| Skills | Standard `SKILL.md` loader (`money-lab/skills/money-lab-strategy`) |
| CLI | `automaton --money-lab …` subcommand in `src/index.ts` |

## Change set

New: `src/money-lab/{profile,journal,guard,prompt,tools,status,cli,cycle}.ts`,
`src/__tests__/money-lab/money-lab.test.ts`, this `money-lab/` folder.

Upstream patches (all narrow; behaviour unchanged when no `moneyLab` block is configured):

| File | Change |
| --- | --- |
| `src/types.ts` | `moneyLab?` on config; `dailyBudgetCents?`, `pinnedModel?`, `strictCostAccounting?` on model strategy; `costEstimated?`, `budgetLimit?` on inference result |
| `src/inference/budget.ts` | Daily budget check from persisted costs (absent/0 keeps upstream "no limit"); rejections name the limit |
| `src/inference/router.ts` | Optional pinned model. Opt-in strict accounting: tool schemas counted in the estimate; missing or zeroed usage and timeouts record the estimate and are flagged |
| `src/conway/x402.ts` | Process-wide payment gate (installed only when the owner disables payments) |
| `src/agent/tools.ts` | `executeTool` fails closed without policy context under Money Lab; top-ups and signed x402 amounts recorded so payment caps see them |
| `src/conway/x402.ts` (result) | `paidCents` on the result when a payment was signed |
| `src/agent/policy-rules/index.ts` | Registers `money_lab.first_run` rule |
| `src/agent/loop.ts` | All tools except replication/owner-denied; orchestration off; automatic top-ups only without payment caps; pause if a pinned model is missing or unpriced; owner pause; sleep on hourly/daily exhaustion, pause on per-call/session rejection; pause on unknown cost when limits are set |
| `src/agent/system-prompt.ts` | Money Lab mission + rules block |
| `src/heartbeat/tasks.ts` | USDC auto-top-up only when payments are allowed without caps; no upstream-update wake |
| `src/index.ts` | Profile validation (invalid = exit 1); optional payment gate; bootstrap top-up only without caps; pause-aware run loop; only operator events cut a sleep short; no-progress tracking; `--money-lab` CLI |

## Self-hosted runtime (2026-10-04)

Conway Cloud closed to new accounts, so `moneyLab.runtime: "self-hosted"` replaces it:

| Concern | Implementation |
| --- | --- |
| Execution | Upstream local mode (empty sandbox id) wrapped by `createSelfHostedClient`; Conway-only calls throw and their tools are denied |
| Secrets | `localExecEnv` strips `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `STRIPE_API_KEY`, `OPENAI_API_KEY`, `CONWAY_API_KEY` from the agent's shell; shell patterns block their names and `/proc/*/environ`; systemd reads them from a root-only file |
| Inference | `claude-sonnet-5-5` via the official `@anthropic-ai/sdk` (beta messages): `output_config.effort`, `tool_choice: auto`, `fallbacks: "default"` (`server-side-fallback-2026-07-01`), refusal handled; thinking blocks are never replayed because the loop rebuilds history every turn (the documented strip path for non-append-only harnesses) |
| Prompt caching | Explicit `cache_control` breakpoints on the last tool and on the system prompt before `--- WORKLOG.md` and `--- MONEY LAB RULES` (the live balance stays uncached); the router bills cache reads at 0.1x and writes at 1.25x of the input price (`TokenUsage.cacheReadTokens` / `cacheWriteTokens`) |
| Publishing | `expose_port` / `remove_port` removed (no proxy on a VPS; upstream local mode returned a localhost URL). The prompt tells the agent to run its own server above port 1024 and ask the owner to open the firewall or set up a host |
| History | `buildContextMessages` keeps turns that have tool calls but no text (Claude often answers with tool calls only; upstream dropped those turns, so the agent never saw its own results and repeated them). The router keeps tool messages for Anthropic (upstream flattened them into user text, which the API rejects once a tool_use is in the history); the Anthropic transform turns them into tool_result blocks, drops empty text blocks and makes the request start and end with a user turn |
| Shell | `runLocalCommand`: commands run asynchronously (upstream local mode used `execSync`, which froze Telegram, the heartbeat and `/pause` while a command ran); the call returns when the shell exits even if a background job keeps its output open; timeouts kill the process group. `~/autostart.sh` runs at every start, since background servers stop with the service |
| Files | `write_file` is confined to `$HOME` in local mode (upstream hard-coded `/root`, so the unprivileged bot user could not write any file); runtime files stay blocked by `MONEY_LAB_RUNTIME_PATH` |
| Loop | Anthropic `end_turn` maps to `stop`, so a final text answer ends the cycle (it used to re-call the model up to 10 times); a refusal ends it too; idle sleep is 15 minutes; inbox messages are read on the wake turn, and the reason of the operator event that ended the sleep (help answered with the owner's note, owner message, funds) is added to the wake-up prompt; the owner's Telegram messages are labelled as the owner's and bypass the social-message injection filter, which blocked e.g. "ignore les instructions précédentes"; repetition is detected on identical calls, not on the tool name (most work goes through `exec`); the inference timeout grows with `maxTokens` (25 ms per token) |
| Autonomy (2026-10-05) | Anthropic server tools `web_search_20260209` / `web_fetch_20260209` on agent turns (max 5 uses each per call, fetch capped at 15k tokens; searches billed 1 cent each via `TokenUsage.serverToolCents`; `pause_turn` resumed up to 3 times; a "[Web research this turn]" trace kept in the history). `view_page` screenshots a URL with headless Chrome (desktop, mobile, or print: first PDF page via `pdftoppm`); the 2 most recent screenshots are sent as image blocks. `set_budget_focus` stores a percentage plan per purpose and the current focus; each paid turn is attributed to it per week. Weekly review (`review.ts`): wakes an agent-chosen sleep, injects instructions, is marked done only once a paid turn runs; `~/LESSONS.md` is read into the prompt. Sleep tool capped at 24 h (6 h since 2026-10-06). Bot-readable credentials `GH_TOKEN`/`GITHUB_ORG`, `GOATCOUNTER_SITE`/`GOATCOUNTER_TOKEN` are announced in the prompt when set |
| Improvements (2026-10-05) | History caching: Money Lab sends a 20-29 turn window that only slides every 10 turns, the stable system prompt and the last history message carry cache breakpoints, and the volatile `--- MONEY LAB RULES` part goes in a trailing system message (models in `MID_CONVERSATION_SYSTEM_MODELS`). After `MAX_CONSECUTIVE_ERRORS` the owner gets a Telegram alert, at most hourly. `backupStateDaily` copies state.db to `~/.automaton/backups/` once a day (7 kept, protected). `search_console` reads Search Console search analytics with a service-account key in `~/.automaton/gsc-key.json` (protected, scope `webmasters.readonly`) for `GSC_SITE`. `InferenceRequest.model` asks for a model; the router uses it when enabled and within the per-call ceiling (it bypasses `pinnedModel`); the weekly review's first 4 turns ask for Opus 5.5. The prompt lists revenue levers and says accounts are requested from the owner |
| Plan steps 1-2 (2026-10-06) | `delegate` (delegate.ts): Claude Haiku 4.5 reads text, the agent's own home files (runtime paths refused) and up to 5 pages (HTML reduced to text, 400k characters shared between documents), with no tools; the call goes through the inference router (`InferenceRequest.model`, `ToolContext.inferenceRouter`), so caps and cost recording apply; `output_config.effort` is only sent to models in `ANTHROPIC_EFFORT_MODELS` (Haiku 4.5 rejects it). `schedule_job` (jobs.ts): up to 10 shell commands, every 15 min to 7 days, run by the runtime every minute without inference (scrubbed environment, 120 s, log in `~/.money-lab/jobs/`), same command protection as `exec`; on_failure / on_change alerts wake the agent through a `money_lab_job` wake event (accepted during a sleep like operator wakes), at most hourly, never while paused, dead or sleeping on a budget cap. `recall` (recall.ts): accent-insensitive keyword search over ~/research, ~/library, ~/skills, ~/notes, LESSONS.md, WORKLOG.md and the experiment journal. `audit_page` (audit.ts): bundled Lighthouse 12 CLI with the server's Chrome, mobile or desktop, summary of scores, metrics, failing checks by impact and speed opportunities; 10 reports kept. `ab_test` (abtest.ts): cookieless per-page-view variants counted as GoatCounter events, two-proportion z-test (100 views per variant minimum, p < 0.05) |
| Idea pipeline (2026-10-06) | `idea` tool (ideas.ts): ideas stored in KV with evidence, competitors, risks, kill criteria and a 0-10 score with a reason for each of 9 weighted criteria (total /100). `challenge` sends the dossier to Opus 5.5 through the router as a sceptical investor (critic.ts; verdict GO / NO-GO / NEEDS MORE EVIDENCE; at most 3 per idea, only after a change). Approval gates: all criteria, 3+ evidence, 2+ competitors, 5+ scored ideas, top 3, total 60+, latest critique not NO-GO and answered, kill criteria, 6 h since first record. `record_experiment` refuses to make an experiment active (building, observing, waiting_for_owner) without an approved `idea_id`, and beyond 3 active experiments; experiments created before 2026-10-06 are grandfathered. Prompt: discovery-first strategy and pipeline summary; weekly review re-scores active experiments |
| Plan step 3 (2026-10-06) | `check_domain` (domain.ts): RDAP via rdap.org, 404 = free, 200 = taken with expiry, up to 20 names. `render_image` (image.ts): HTML/CSS rendered by Playwright with the server's Chrome at exact presets (og 1200x630, square, portrait, story, banner) into `~/images/`, shown back to the agent; `view_page` desktop/mobile now uses the same exact-viewport render (Chrome's `--screenshot` left a blank band at the bottom). `post_social` (social.ts): Bluesky drafts with link facets and an optional image from `~/images` (alt required, 950 KB max); while approval is required (default) each draft goes to the owner on Telegram (`/publier`, `/rejeter`, `/publications auto|validation`); the runtime publishes approved drafts every minute with `BLUESKY_HANDLE` / `BLUESKY_APP_PASSWORD` (scrubbed from the shell, protected like other keys); 3 posts a day, no replies or DMs. Prompt: domain strategy (one brand domain with paths preferred, the agent's call; GitHub Pages DNS records) and social status |
| Live fixes (2026-10-06) | The Money Lab rules block starts with the current UTC date, time and weekday (the agent dated evidence "2026-10-11" on 2026-10-06: the prompt had no date). The sleep tool caps sleep at 3 h while fewer than 5 ideas are fully scored (`discoveryIncomplete`), so "waiting for indexing" does not replace discovery. `journalFingerprint` includes the idea pipeline, so discovery work counts as progress for the no-progress sleep |
| Bug audit (2026-10-06) | `check_domain`: rdap.org answers 404 itself for extensions without RDAP (.de, .io, .eu, .es, .ch...), which read as "free" (google.io came out free); those now fall back to DNS name servers ("probably free" without them), and requests carry a user agent (Cloudflare answered 403 to Node's default one, so every check had failed). `render_image` serves the design over a temporary 127.0.0.1 server limited to real files inside `~/images` (a file:// page could embed local files such as `/proc/<pid>/environ` or runtime keys in the picture) and offers JPEG; Chrome (render, view_page, browse) runs with the scrubbed environment. Image markers are only sent to the model when the file really is a PNG or JPEG (a fake one would fail every request). `record_experiment` no longer lets `idea_id` be forged through `metrics` or a non-approved idea; grandfathering checks the idea that launched the experiment. A critique that timed out, was refused or has no verdict is not counted. `delegate` stops downloads at 3 MB, refuses non-text content and resolves symbolic links before reading files. Bluesky: a refused login fails the drafts and tells the owner once instead of retrying every minute; outages retry after 15 minutes; post ids come from a ULID. The router falls back from a requested model that would break any budget (per call, hour, day) instead of blocking or pausing. Recall includes `~/.automaton/skills`, skips symbolic links and reads at most 20 MB. Backups are written to a `.partial` file first. The idea pipeline caps open ideas (40), not rejected ones. Prompt no longer tells the agent to use long sleeps while results accumulate |
| Deep audit (2026-10-06) | `read_file` runs inside the runtime process: `/proc/self/environ` returned every key (Anthropic, Telegram, Stripe, Bluesky) and `gsc-key.json` was readable; a Money Lab policy now refuses `/proc` (except load, memory, CPU, uptime, version), `/etc/money-lab*` and the protected runtime entries except `constitution.md`, after resolving symbolic links. The service starts as root and `dist/launch.js` switches to `MONEY_LAB_USER` before loading the runtime: a process that changed users is not dumpable, so the bot's shell (same user) cannot read `/proc/<pid>/environ` (verified with a test user); it refuses to run as root without the variable, and the runtime warns the owner daily while it is not protected. `install_mcp_server` (stub tools whose names could fail every request) and `switch_model` (a no-op under the pinned model that saved derived budgets) are always denied; installed tools with invalid or duplicate names are dropped from the request. `update_genesis_prompt` writes only the prompt to the config file; `configure.mjs` drops saved `modelStrategy`/`treasuryPolicy` (they capped a budget raised later). Telegram calls time out after 30 s, a command reply that fails to send is queued instead of lost (no double `/fonds`), a message Telegram rejects (400) no longer blocks the outbox. Stripe maps disputes/adjustments, refund failures and Stripe fees; Stripe and Search Console calls time out. A wake cycle without any paid turn (budget-blocked) no longer counts toward the no-progress sleep. Tool results are stored up to 20,000 characters (the context reads 10,000). The browse profile's disk cache is capped at 50 MB |
| Sealed secrets (2026-10-06) | Self-hosted Money Lab moves the keys (fixed list plus the configured Telegram and Stripe variable names) out of `process.env` right after startup (`sealSecrets`); the runtime reads them with `withSecrets()` (Telegram, Stripe, Bluesky). Before, every process the runtime started itself inherited them (`which` for skill checks on each cycle, `git`/`curl` for skill installs, `git` for upstream checks), and the agent's shell, as the same user, could read a short-lived child's `/proc/<pid>/environ` |
| Fourth audit (2026-10-06) | Inbox: a message claimed by a turn that then stopped before inference (daily or hourly cap, pause, death) stayed `in_progress` forever, so an owner message sent while the budget was spent was never read (seen live on 2026-10-05); such claims are now released without counting an attempt, claims left by a restart are recovered at startup, and the owner's messages never move to `failed` after API errors. A failed turn lost its input: the next attempt sent no message ("Cannot send empty message array") or lost the wake-up prompt with the weekly review instructions, and the review was then marked done unseen; Money Lab now retries the same input with its claims (released if the cycle ends). WORKLOG.md is cut to its last 12,000 characters in the prompt (it grew without limit and is sent every turn); the prompt lists at most 12 experiments and 12 open help requests. Shell commands run between 1 s and 30 min whatever timeout the model asks. `money-lab/e2e/chaos.mjs` runs the real process against failing fake services (Anthropic 529 and a broken body, Telegram down, 12 tool calls in one turn); the Anthropic request validator moved to `money-lab/e2e/validate.mjs` |
| Health report (2026-10-06) | `health.ts`: the daily Telegram message (once per UTC day after 07:00, queued in the outbox) is now a short health report instead of the full summary (still on `/resume`); `/sante` sends it on demand. Verdict ok / watch / problem from local state only (inference spend compared with the cap per UTC day, today and yesterday, not over a rolling 24 h window; the burn rate for days left counts inference at most at the daily cap): turns and tool errors over 24 h, failed agent turns and background task failures (recorded by the loop and the `every` timers in KV `money_lab.health_events`, 48 h, 200 max, keys masked), owner messages unread for over 1 h, no turn for 26 h, 24 h inference spend versus the daily cap, days of funds left, no-progress cycles, ideas and active experiments, free disk (<3 GB watch, <1 GB problem) and the last backup. No network call, no inference. |
| Interactive browser | `browse` (src/money-lab/browser.ts, playwright-core 1.56.1 driving the installed Chrome): one headless session with its own profile in `~/.money-lab/browser-profile` (no owner cookies), actions goto/elements/click/fill/select/press/text/screenshot/close, closed after 10 idle minutes. Chosen over open-browser-use, which drives the owner's desktop Chrome and logged-in accounts through an extension and does not fit a headless server |
| End-to-end check | `node money-lab/e2e/harness.mjs` (after `pnpm run build`): runs `dist/index.js --run` against strict fake Anthropic/Telegram/Stripe servers and scripts a full run, including restart; no network or cost |
| Models | Claude models seeded in the registry after `initialize()` (which disables non-baseline models) with first-party prices (hundredths of a cent per 1k tokens: Sonnet 5.5 20/100, Opus 5.5 40/200, Haiku 4.5 10/50) |
| Survival | `survivalBalance`: funding + confirmed revenue - (inference + hosting + external + fees + refunds + agent payments + accrued declared hosting). Negative = dead: no inference, one owner notification, revival when funds or revenue arrive |
| Owner channel | `TelegramChannel`: only `ownerChatId`; commands reuse the operator CLI; other text becomes an inbox message plus an operator wake; outbox for notifications (help requests, runtime pauses, death, revenue, `message_owner` tool, daily summary) |
| Revenue | `syncStripe` with a restricted read-only key: charge/payment → confirmed_revenue + fee, refund → refund, payout → cash_received; converted with the owner's `usdPerUnit`; other currencies skipped |
| Deployment | `money-lab/vps/` (configure script, systemd unit, environment template) and `money-lab/GUIDE-VPS.fr.md` |

Not verified against live services: Telegram commands were checked on the first run; Stripe API is
stubbed only. First supervised run (2026-10-04): the agent chose an invoice generator, then spent about
$0.52 in 30 s (about 21k uncached prompt tokens per turn) re-checking a port that `expose_port` had
falsely reported as published, until the hourly cap put it to sleep. Caching and the publishing fix
above answer that run; their live effect is not yet measured.

## Freedom model

The agent may use every tool and choose any legitimate activity. The runtime enforces only:

| Rule | Why |
| --- | --- |
| No replication: child sandboxes/funding/messaging, orchestrator workers, `maxChildren: 0` | Owner decision |
| No runtime code self-modification (`edit_own_file`, `pull_upstream`, `reset_to_upstream`, writes/shell into the runtime install) and no edits to `automaton.json`, `wallet.json`, `config.json`, `state.db*`, `constitution.md` | Otherwise the agent could remove the replication ban or corrupt the spending records |
| `CONWAY_API_KEY` not readable through the shell | Protects the owner's credential from prompt injection; Conway tools still use it |
| Owner pause | Lets the owner stop new spending at any time |
| Optional price caps (inference per call/hour/day, payments per payment/day), `null` = none | Limits cost, not capability |
| Optional `deniedTools`, `payments: "disabled"`, `noProgressCycles` | Owner switches, all off/empty by default except what the example sets |
| Upstream treasury rules (x402 domain allowlist `treasuryPolicy.x402AllowedDomains`, default `conway.tech`; transfer caps; minimum reserve) | Kept as upstream owner settings; payment caps tighten the amounts |

## Spend paths

| Path | Upstream behaviour | Money Lab behaviour |
| --- | --- | --- |
| Inference (router) | Matrix model, hourly/session/per-call only, missing usage counted as 0c | Owner model or matrix; per-call/hourly/daily caps when set; zero/missing usage and timeouts charged at the estimate |
| `topup_credits` | Any tier up to $2,500, unrecorded | Allowed within per-payment/daily caps; recorded in `spend_tracking` |
| `transfer_credits` | Treasury caps (default $50/transfer, $250/day) | Treasury caps tightened to the payment caps |
| `x402_fetch` | Max $1 per payment, recorded as 0c | Max = per-payment cap; the signed amount is recorded toward the daily cap (the daily check reserves the cap before the call) |
| Automatic top-ups (startup, inline, heartbeat) | Buy $5 when credits are low | Only when payments are allowed **without** caps (they bypass tool policy) |
| `create_sandbox`, `register_domain`, other paid Conway tools | Agent tools, paid from credits | Allowed; bounded by the credits the owner provisions |
| Orchestrator / local workers | Separate inference client, **bypasses router budgets**, spawns workers | Not initialised (replication) |
| `executeTool` without policy context | **Executes with no policy** | Denied (`MONEY_LAB_POLICY_MISSING`) |
| Heartbeat wakes during sleep | Start paid cycles | Ignored; only operator resume/help resolution wakes the agent |

## Units

`costPer1k*` in the model registry is in hundredths of a cent per 1 000 tokens.
Cost (cents) = ceil(input/1000 × in/100 + output/1000 × out/100). Fixture: `gpt-5-mini`
(8 / 32), 10 000 in + 1 000 out = 1.12 c → recorded 2 c. Rounding up slightly overstates small
calls. Limits must be positive integers or `null` (no limit); zero is rejected so it can never be
mistaken for either.

## Known limitations (do not remove from reports)

1. **Shell is not sandboxed by these checks.** `exec` runs arbitrary commands in the sandbox. The
   rule blocks obvious references to `automaton.json`, `wallet.json`, `state.db`,
   `~/.automaton/{config.json,constitution.md}`, the runtime install path and `CONWAY_API_KEY`.
   Obfuscated commands (encoding, variables, other interpreters) can still read the wallet key,
   edit the DB (e.g. clear the pause, delete cost rows) or call Conway APIs directly. This is a
   **supervised experiment**, not secure unattended financial automation. The real exposure limit
   is the credits and USDC the owner provisions.
2. With `payments: "allowed"`, a transfer or payment can be triggered by instructions hidden in a
   web page or message (prompt injection). Price caps bound each payment and each day; they do not
   judge whether a payment is wise.
3. The per-call ceiling uses a pre-call estimate (chars/4). The real cost is recorded afterwards and
   counts towards hourly/daily limits. A provider error thrown after the request was sent (other
   than a timeout) records no cost; reconcile with Conway billing when errors appear in the logs.
4. Pause is checked before each inference call and each tool. A call already in flight completes.
   **Pause does not stop Conway hosting billing.** Sandboxes or domains the agent creates are
   billed until deleted; list them before shutdown.
5. While awake the agent processes queued inbox messages; while sleeping, only operator events
   wake it.
6. A process restart clears `sleep_until` (upstream behaviour), so the first cycle after a restart
   runs even during a long no-progress sleep. Budgets, pause and the no-progress counter persist.
7. Use a fresh `state.db` for the run: the finance summary includes every row of
   `inference_costs`, including any from before the profile was enabled.
8. Money Lab tables are created with `CREATE TABLE IF NOT EXISTS`, outside upstream schema versions.
9. Telegram notifications are not implemented; the CLI is the help/notification channel.
10. Web research: no search adapter was added; the agent can use HTTP retrieval via `exec`.
11. `check_for_updates` still runs `git fetch` against the configured remote (no wake, no pull).

## Tests (2026-10-04, Node 22, pnpm 10.28.1)

| Check | Pinned upstream `d8f8168` | Money Lab branch |
| --- | --- | --- |
| `pnpm typecheck` | pass | pass |
| `pnpm build` | not run | pass |
| `vitest run --exclude src/__tests__/context-hardening.test.ts` | 63 files, 1614/1614 pass | 65 files, 1667/1667 pass (self-hosted VPS runtime) |
| `context-hardening.test.ts` | **hangs** (no result after 150 s; `buildContextMessages` blocks) | same hang; its other blocks, incl. `buildSystemPrompt` (8 tests), pass |

The `context-hardening` hang is a pre-existing upstream baseline failure in code this branch does
not touch (`src/agent/context.ts`); it is why a plain `pnpm test` never finishes.

`src/__tests__/money-lab/`: 66 tests (41 core + 25 VPS: survival, death/revival, Anthropic request shape and caching, Telegram, Stripe), including a simulated first cycle. Global `fetch` is replaced by a spy that
throws, USDC balance reads are mocked, and no test starts a funded loop. Coverage maps to
specification section 10: mocked mode has no network/payment effects and missing policy fails
closed; pause blocks paid calls and top-ups while status reports hosting as separately billed;
per-call/hourly/daily limits use correct units and persist across restart; replication, recovery
funding (when payments are disabled or capped) and runtime/safeguard edits are denied, while all
other tools stay available and payments respect per-payment/daily caps; help requests survive
restart, repeated or unrelated resolutions are harmless, agent tools cannot resolve them;
funding is not revenue, estimated ads are not cash, credit purchases are not double-counted;
no-progress cycles trigger a long sleep while keeping experiment context.

Not tested: `check_for_updates` (runs `git fetch`), a real Conway sandbox, real provider usage
reporting, or the CLI against the compiled `dist/` (the CLI was smoke-tested via `tsx` with a
temporary `HOME`).
