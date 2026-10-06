# Architecture decision 0004: Sonni gets its own VPS
- Status: accepted (owner, 2026-10-06); the cost treatment below is proposed and awaits the owner
- Date: 2026-10-06
- Context and constraints: the first slice planned Sonni as a second Linux user on Money Lab's VPS.
  Money Lab has maximum freedom on its server (installs, services, a headless browser), its in-process
  guards can be bypassed through its shell, and a crash there would leave gaps in Sonni's price data
  (predictions due during a gap are voided).
- Decision: Sonni runs on a dedicated VPS (Ubuntu 24.04, 2 GB), as user `sonni` under systemd, with its
  own Anthropic workspace and key, and its own Telegram bot. Setup: sonni/GUIDE-VPS.fr.md,
  sonni/vps/configure.mjs, sonni/vps/sonni.service, sonni/vps/sonni.env.example.
- Cost (proposed): the VPS is paid by the owner outside Sonni's 50 EUR/month budget, so hosting does not
  reduce what Sonni can spend on learning; the configuration counts it as 0.
- Alternatives and trade-offs: same VPS with a separate Linux user (cheaper by a few euros a month, but
  shared failures and no isolation for a future real-money phase).
- Reversibility and migration: the state lives in /home/sonni/.automaton/state.db and can be copied.
- Evidence: owner message of 2026-10-06; sonni/e2e.mjs runs the configure script.
- Revisit trigger: the real-money phase (stricter isolation of trading keys).
