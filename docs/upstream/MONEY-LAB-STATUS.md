# Working status
- Updated: 2026-10-05
- Branch / commit: claude/money-lab-first-run-bezu7x on upstream Automaton d8f816881fd24b6f5e3d616e59edec387a447667 (0.2.1)
- Current goal: self-hosted VPS runtime (Claude Sonnet 5.5, Telegram, Stripe, survival goal); development only, no launch.
- Accepted decisions:
  - Thin extension under src/money-lab/ plus narrow upstream patches; inert without a moneyLab block.
  - Owner decision 2026-10-04: maximum freedom, only replication forbidden; optional price caps
    (inference per call/hour/day, payments per payment/day); payments allowed or disabled by the owner.
  - Journal in the existing state.db; operator CLI and Telegram with French output.
  - Owner decision 2026-10-04: Conway Cloud closed; run self-hosted on a VPS; Claude Sonnet 5.5; Stripe revenue sync; survival as the bot's ultimate goal.
  - No start command configured: starting runs the agent and requires owner approval.
- Completed behaviour: profile, spend guards, experiment/help journal, operator ledger, pause/resume,
  status/summary, no-progress sleep, integration note, Conway checklist (features verified in docs/FEATURES.md).
- Checks run (command, result, date):
  - likma project feature verify (types/money-lab/build): pass, 2026-10-03
  - pnpm exec vitest run --exclude src/__tests__/context-hardening.test.ts: 1722/1722 pass (fourth audit), 2026-10-06
  - node money-lab/e2e/harness.mjs (real process, strict fake Anthropic/Telegram/Stripe): PASS, 2026-10-05
    (upstream d8f8168 baseline: 1614/1614)
- First supervised run (owner-approved, 2026-10-04, OVH VPS, $15 funding): Telegram works; the agent
  spent about $0.52 in 30 s re-checking a falsely "exposed" port until the hourly cap slept it; the owner
  paused it. Fixes: prompt caching with cache-aware cost, expose_port removed on self-hosted, VPS prompt
  wording, pause message. Second run (22:00 UTC): about $0.02-0.03 per turn instead of $0.05, but the
  agent still repeated the same check: turns with tool calls and no text were dropped from the history
  (src/agent/context.ts), so it never saw its own results. Fixed 2026-10-05. Third run: with the history
  restored, every request failed (400, tool_use without tool_result) because the router flattened tool
  results into user text for Anthropic; the router now keeps tool messages. End-to-end audit (owner
  request): a harness running the real process against a strict fake API found and fixed end_turn
  re-calls, owner messages unread on wake and blocked by the injection filter, write_file confined to
  /root, blocking execSync, name-based repetition on exec, 2-minute inference timeout, servers lost
  on restart (autostart.sh). Not yet measured live.
- Owner decision 2026-10-05 (full autonomy): web search/fetch, view_page screenshots (incl. print/PDF),
  own GitHub organization and analytics tokens readable by the bot, budget split by purpose, 24 h sleep
  cap, weekly review with ~/LESSONS.md, portfolio of up to 3 experiments. Not yet measured live.
- Owner decision 2026-10-05 (improvements 1-5): history prompt caching (chunked 20-29 turn window,
  live state in a trailing system message), Telegram alert on repeated errors and daily state.db
  backup, revenue levers in the prompt (accounts stay the owner's), read-only Search Console tool,
  Opus 5.5 for the first 4 turns of the weekly review. Measured live 2026-10-05: Search Console answers.
- Owner decision 2026-10-06 (plan steps 1-2): delegate to Haiku 4.5, scheduled jobs without inference,
  recall over the agent's notes, Lighthouse page audits, A/B tests. Next: step 3 (domain chosen by the
  agent, bought by the owner; Bluesky account by the owner; image generation), step 4 (e-mail once a
  domain exists), step 5 (revenue) last. Not yet measured live.
- Owner decision 2026-10-06 (plan step 1 bis, money-lab/PLAN.fr.md): the agent copied a common invoice
  tool; it must now research, score ideas on 9 criteria, have them challenged by Opus and wait 6 h
  before an experiment can become active (runtime-enforced). Not yet measured live.
- Plan step 3 code (2026-10-06): check_domain, render_image, Bluesky post_social with owner approval on
  Telegram; view_page blank-band fix. Owner still to buy the domain and create the Bluesky account.
- Live 2026-10-06 02:08 UTC (727338d): the agent recorded its experiment and slept 24 h "for indexing"
  without discovery, and dated evidence in the future. Fixed: current date in the prompt, 3 h sleep cap
  while fewer than 5 ideas are scored, idea work counted as progress.
- Bug audit 2026-10-06 (owner request): fixed false "free" domains and Cloudflare 403 on RDAP, a
  local-file leak path in render_image, forged idea_id, uncounted failed critiques, unbounded page
  downloads, Bluesky login retries every minute, budget-blocked review model, fake image markers
  breaking every request, partial backups. See INTEGRATION.md "Bug audit".
- Deep audit 2026-10-06: read_file leaked every key through /proc/self/environ (fixed); the bot's shell
  could read the runtime's environment (fixed by the root-start launcher, owner must install the new
  unit once); install_mcp_server could brick inference; switch_model/update_genesis_prompt could freeze
  budgets; Telegram replies could be lost (double /fonds); Stripe disputes ignored. Remaining by design:
  the bot owns its config and state files, so shell tricks can still alter limits; the Anthropic spending
  limit is the backstop.
- Sealed secrets 2026-10-06: keys leave process.env at startup, so no child process (which, git, curl)
  inherits them; 1719/1719 tests, E2E PASS.
- Fourth audit 2026-10-06: owner messages lost when a wake was budget-blocked (stuck in_progress), lost
  input and silently skipped weekly review after an API error, unbounded WORKLOG.md in every prompt,
  unbounded command timeouts. New chaos run (money-lab/e2e/chaos.mjs): PASS.
- Blockers and known regressions:
  - Upstream context-hardening.test.ts hangs on unmodified upstream; upstream CI masks it as a warning.
  - In-process limits are bypassable through exec; supervised run only.
  - GitHub Actions may be disabled on this fork until enabled by the owner.
  - Example caps ($3/day inference, $10/day payments) not checked against real Conway prices.
  - With payments allowed, prompt injection can trigger payments within the caps.
- Next concrete action: owner updates the VPS (guide, "Mettre à jour le bot"), resumes with /reprendre
  and checks cache reads and spend per turn in the logs.
- Files to read first: AGENTS.md, money-lab/INTEGRATION.md, money-lab/GUIDE-VPS.fr.md, docs/CODEMAP.md.
Never store secrets or report planned work as complete.
