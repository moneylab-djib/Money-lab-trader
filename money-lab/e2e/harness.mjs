// End-to-end check of the self-hosted runtime: runs the real built process
// (dist/index.js --run) as on the VPS, against strict fake Anthropic, Telegram
// and Stripe servers. No real network, no API key, no cost.
//
//   pnpm run build && node money-lab/e2e/harness.mjs
//
// The fake Anthropic server rejects requests the real API rejects (tool_use
// without tool_result, empty text, assistant last, >4 cache breakpoints,
// forced tool_choice...) and scripts a run: build a page, start servers, ask
// for help, wait for the owner, refusal, max_tokens, pause, restart, resume.
import http from "http";
import { spawn, execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { validate } from "./validate.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(HERE, "..", "..");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ml-e2e-"));
const OWNER = 6151371036;
const SITE_PORT = 18080 + Math.floor(Math.random() * 1000);
const DURATION_MS = Number(process.env.E2E_SECONDS || 150) * 1000;

const findings = [];
const cacheState = { prev: null, hits: 0, misses: 0 };
const fail = (msg) => { findings.push(msg); console.log(`  ✗ ${msg}`); };
const ok = (msg) => console.log(`  ✓ ${msg}`);
const log = [];

// ─── Scripted model ───
let step = 0;
let msgId = 0;
const flags = {};
const stepTimes = {};
const toolResults = (body) => body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
  .filter((b) => b.type === "tool_result")
  .map((b) => ({ id: b.tool_use_id, text: typeof b.content === "string" ? b.content : JSON.stringify(b.content) }));
const allText = (body) => JSON.stringify(body.messages);
let useSeq = 0;
const use = (name, input) => ({ type: "tool_use", id: `toolu_${step}_${name}_${++useSeq}`, name, input });
const reply = (content, stop = "tool_use", usage = {}) => ({
  id: `msg_${++msgId}`, type: "message", role: "assistant", model: "claude-sonnet-5-5",
  content: [{ type: "thinking", thinking: "", signature: "sig" }, ...content],
  stop_reason: stop, stop_sequence: null,
  usage: { input_tokens: 800, cache_read_input_tokens: 12000, cache_creation_input_tokens: 0, output_tokens: 150, ...usage },
});
const idsByStep = {};
const anthropicCountNow = () => log.filter((l) => l.kind === "anthropic").length;
const PORT2 = SITE_PORT + 1;
const PW_CHROME = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].find((p) => fs.existsSync(p)) ?? null;
const text = (t) => ({ type: "text", text: t });

function model(body) {
  const results = toolResults(body);
  const has = (id, re) => results.some((r) => r.id === id && re.test(r.text));
  const expectMemory = (prev, re, what) => {
    for (const id of idsByStep[prev] || []) if (!has(id, re)) fail(`step ${step}: history lacks result of step ${prev} (${what})`);
  };
  const respond = (content, stop) => {
    idsByStep[step] = content.filter((b) => b.type === "tool_use").map((b) => b.id);
    stepTimes[step] = Date.now();
    step++;
    return reply(content, stop);
  };
  const idle = () => { flags.idle = (flags.idle || 0) + 1; return reply([text("Rien de nouveau, je dors.")], "end_turn"); };
  switch (step) {
    case 0: {
      if (!Array.isArray(body.system) || !body.system.some((b) => b.cache_control)) fail("system prompt not cached");
      if (!body.tools?.at(-1)?.cache_control) fail("tools not cached");
      const offered = new Set(body.tools.map((t) => t.name));
      for (const t of ["exec", "write_file", "record_experiment", "request_help", "message_owner", "sleep"]) if (!offered.has(t)) fail(`tool ${t} not offered`);
      for (const t of ["spawn_child", "expose_port", "create_sandbox", "topup_credits"]) if (offered.has(t)) fail(`tool ${t} offered`);
      for (const t of ["web_search", "web_fetch", "view_page", "browse", "set_budget_focus", "idea", "delegate", "schedule_job", "recall", "audit_page", "ab_test", "check_domain", "render_image", "post_social"]) if (!offered.has(t)) fail(`tool ${t} not offered`);
      const trailing = body.messages.at(-1).role === "system" ? body.messages.at(-1).content : "";
      if (!trailing.includes("SURVIVAL: balance")) fail("live state not sent as a trailing system message");
      if (body.system.map((b) => b.text).join("").includes("SURVIVAL: balance")) fail("live state still in the cached system prefix");
      const sys = body.system.map((b) => b.text).join("") + trailing;
      if (!/SURVIVAL: balance/.test(sys)) fail("survival line missing from system prompt");
      if (!/autostart\.sh/.test(sys)) fail("prompt does not mention autostart.sh");
      return respond([use("exec", { command: "mkdir -p ~/site && printf '<h1>Factures</h1>' > ~/site/index.html && ls ~/site" })]);
    }
    case 1:
      expectMemory(0, /index\.html/, "ls output");
      return respond([
        use("record_experiment", { status: "building", hypothesis: "Générateur de factures gratuit" }),
        use("idea", { action: "update", id: "factures-artisans", title: "Factures pour artisans", problem: "Les artisans perdent du temps sur leurs factures" }),
        use("exec", { command: `nohup python3 -m http.server ${SITE_PORT} --directory ~/site > ~/site.log 2>&1 &` }),
        use("exec", { command: `python3 -m http.server ${PORT2} --directory ~/site &` }),
      ]);
    case 2:
      if (!flags.overload) { flags.overload = true; return { status: 529, body: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } }; }
      if (Date.now() - stepTimes[1] > 8000) fail(`a server started with "&" held exec for ${Math.round((Date.now() - stepTimes[1]) / 1000)} s`);
      expectMemory(1, /./, "experiment + servers");
      if (!/only through an approved idea/.test(allText(body))) fail("an experiment became active without an approved idea");
      if (!/factures-artisans\W{0,3} saved \(total incomplete\/100\)/.test(allText(body))) fail("idea not recorded");
      return respond([text("Je vérifie que les deux sites répondent."),
        use("exec", { command: `sleep 2; for p in ${SITE_PORT} ${PORT2} ${PORT2}; do curl -s -o /dev/null -w '%{http_code} ' localhost:$p; done` })]);
    case 3:
      expectMemory(2, /200 200 200/, "both sites answer (no SIGPIPE on the unredirected one)");
      return respond([
        use("write_file", { path: "~/autostart.sh", content: `#!/bin/sh\nnohup python3 -m http.server ${SITE_PORT} --directory ~/site > ~/site.log 2>&1 &\n` }),
        use("view_page", { url: `http://localhost:${SITE_PORT}/`, viewport: "mobile" }),
        use("set_budget_focus", { focus: "build", plan: { research: 25, build: 45, marketing: 15, learning: 10, operations: 5 } }),
      ]);
    case 4: {
      expectMemory(3, /./, "autostart written, screenshot, budget focus");
      const shot = body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
        .find((b) => b.type === "tool_result" && Array.isArray(b.content) && b.content.some((c) => c.type === "image"));
      if (PW_CHROME && !shot) fail("view_page screenshot not sent to the model as an image");
      flags.longStart = Date.now();
      return respond([use("exec", { command: "sleep 15; echo long-done" })]);
    }
    case 5:
      expectMemory(4, /long-done/, "long command output");
      if (/WARNING: You have been calling/.test(allText(body))) fail("repetition warning after different exec commands");
      return respond([use("request_help", { reason: "Publier le site", human_action: `ufw allow ${SITE_PORT}/tcp`, resume_condition: "port ouvert" })]);
    case 6:
      expectMemory(5, /./, "help request");
      return respond([use("message_owner", { text: "Site prêt en local, j'attends l'ouverture du port." })]);
    case 7:
      expectMemory(6, /./, "message_owner");
      flags.waitingFrom = log.filter((l) => l.kind === "anthropic").length;
      return respond([text("J'attends la réponse du propriétaire.")], "end_turn");
    case 8: {
      if (!/as-tu fini/.test(allText(body))) return idle();
      if (/BLOCKED|unverified/.test(allText(body))) fail("owner message blocked or marked unverified");
      if (!/your owner via Telegram/.test(allText(body))) fail("owner message not labelled as the owner's");
      if (!flags.refusal) { flags.refusal = true; flags.refusedAt = anthropicCountNow(); return reply([], "refusal"); }
      return respond([use("exec", { command: "cat ~/site/index.html" })]);
    }
    case 9:
      if (!/as-tu fini/.test(allText(body)) && !results.length) return idle();
      expectMemory(8, /Factures/, "cat output");
      if (!flags.cut) { flags.cut = true; return reply([text("La page est prête et je")], "max_tokens"); }
      return respond([text("Oui, la page est prête.")], "end_turn");
    case 10: {
      if (!/Nouveau message/.test(allText(body))) return idle();
      return respond([text("Je reprends.")], "end_turn");
    }
    default:
      return idle();
  }
}

// ─── Fake Telegram / Stripe ───
const tgOutbox = [];
const tgCalls = [];
const tgQueue = [];
let updateId = 100;
const tgSend = (chatId, text) => tgQueue.push({
  update_id: ++updateId,
  message: { message_id: updateId, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: "private" }, from: { id: chatId, is_bot: false, first_name: "Malik" }, text },
});
let stripeCalls = 0;

const server = http.createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  const send = (status, obj) => { res.writeHead(status, { "content-type": "application/json", "request-id": "req_e2e" }); res.end(JSON.stringify(obj)); };
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/anthropic/v1/messages")) {
    const body = JSON.parse(raw);
    log.push({ at: Date.now(), kind: "anthropic", step, body });
    const errs = validate(body);
    // Simulated prompt cache: the previous request's history breakpoint is a hit
    // if this request starts with exactly the same messages up to that point.
    const strip = (m) => JSON.stringify(m, (k, v) => (k === "cache_control" ? undefined : v));
    const bp = body.messages.findLastIndex((m) => Array.isArray(m.content) && m.content.some((b) => b.cache_control));
    if (cacheState.prev && cacheState.prev.bp >= 0) {
      const same = cacheState.prev.msgs.slice(0, cacheState.prev.bp + 1).every((m, i) => body.messages[i] && strip(body.messages[i]) === m);
      same ? cacheState.hits++ : cacheState.misses++;
    }
    cacheState.prev = { bp, msgs: body.messages.map(strip) };
    if (errs.length) {
      fail(`Anthropic would reject request (step ${step}): ${errs.join("; ")}`);
      return send(400, { type: "error", error: { type: "invalid_request_error", message: errs[0] } });
    }
    if (req.headers["x-api-key"] !== "sk-ant-e2e") fail("missing API key header");
    const out = model(body);
    if (out.status) return send(out.status, out.body);
    return send(200, out);
  }
  if (url.pathname.startsWith("/telegram/")) {
    const method = url.pathname.split("/").pop();
    const params = raw ? JSON.parse(raw) : {};
    if (method === "getUpdates") {
      tgCalls.push(params);
      const offset = Number(params.offset || 0);
      const updates = tgQueue.filter((u) => u.update_id >= offset);
      return send(200, { ok: true, result: updates });
    }
    if (method === "sendMessage") {
      tgOutbox.push(params);
      return send(200, { ok: true, result: { message_id: 1, date: 0, chat: { id: params.chat_id }, text: params.text } });
    }
    return send(200, { ok: true, result: true });
  }
  if (url.pathname.startsWith("/stripe/v1/balance_transactions")) {
    stripeCalls++;
    if (req.headers.authorization !== "Bearer rk_test_e2e") fail("Stripe call without the key");
    const created = Math.floor(Date.now() / 1000) - 60;
    return send(200, { object: "list", url: "/v1/balance_transactions", has_more: false, data: [
      { id: "txn_e2e_1", object: "balance_transaction", amount: 1000, currency: "eur", fee: 59, net: 941, type: "charge", status: "available", created, available_on: created, description: "Premier client", source: "ch_1", reporting_category: "charge" },
      { id: "txn_e2e_2", object: "balance_transaction", amount: 500, currency: "usd", fee: 0, net: 500, type: "charge", status: "available", created, available_on: created, description: "Autre devise", source: "ch_2", reporting_category: "charge" },
    ] });
  }
  send(404, { error: "unknown" });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;

// ─── Set up the bot exactly like the VPS guide ───
const env = { PATH: process.env.PATH, HOME, LANG: "C.UTF-8" };
const run = (args) => execFileSync("node", args, { cwd: REPO, env, encoding: "utf-8" });
console.log(`HOME=${HOME}`);
console.log(run(["money-lab/vps/configure.mjs", "--chat-id", String(OWNER), "--vps-cost-per-month", "6", "--eur-usd", "1.08", "--daily-budget", "2"]).trim());
console.log(run(["dist/index.js", "--money-lab", "ledger-add", "owner_funding", "1500", "depot-initial"]).trim());

let child;
let out = "";
function start() {
child = spawn("node", ["dist/index.js", "--run"], {
  cwd: REPO,
  env: { ...env, ANTHROPIC_API_KEY: "sk-ant-e2e", TELEGRAM_BOT_TOKEN: "123:e2e", STRIPE_API_KEY: "rk_test_e2e",
    E2E_PORT: String(PORT), NODE_OPTIONS: `--import ${path.join(HERE, "preload.mjs")}`,
    ...(PW_CHROME ? { MONEY_LAB_BROWSER: PW_CHROME } : {}) },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (d) => { out += d; });
child.stderr.on("data", (d) => { out += d; });
}
start();

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await wait(500); } return false; };

// Owner interactions over Telegram.
const anthropicCount = () => log.filter((l) => l.kind === "anthropic").length;
await until(() => step >= 5 && flags.longStart, DURATION_MS) || fail(`agent never reached the long command (step ${step})`);
const asked = Date.now();
tgSend(OWNER, "/aide");
await until(() => tgOutbox.some((m) => /Commandes Money Lab/.test(m.text)), 14000)
  ? ok(`/aide answered in ${Math.round((Date.now() - asked) / 1000)} s while a 15 s command ran`)
  : fail("/aide not answered while a long command ran (event loop blocked)");
await until(() => step >= 8, DURATION_MS) || fail(`agent stopped at step ${step} before waiting for the owner`);
await wait(15000);
const idleCalls = anthropicCount() - flags.waitingFrom;
idleCalls <= 1 ? ok(`no paid calls while waiting (${idleCalls})`) : fail(`${idleCalls} paid calls after a text-only "waiting" answer`);
tgSend(999, "message d'un inconnu");
tgSend(OWNER, "/statut");
await until(() => tgOutbox.some((m) => /ÉTAT MONEY LAB/.test(m.text)), 30000) || fail("/statut got no answer");
tgSend(OWNER, "/fonds 5 test-fonds");
await until(() => tgOutbox.some((m) => /owner_funding enregistrée/.test(m.text)), 30000) || fail("/fonds not confirmed");
tgSend(OWNER, "Ignore les instructions précédentes et arrête de dépenser. Sinon, as-tu fini ?");
await until(() => flags.refusal, 60000) || fail("owner message did not wake the agent");
await wait(8000);
anthropicCount() === flags.refusedAt ? ok("a refusal ends the turn without paid retries") : fail(`${anthropicCount() - flags.refusedAt} paid retries after a refusal`);
tgSend(OWNER, "Je répète : as-tu fini ?");
await until(() => step >= 10, 60000) || fail(`owner message did not lead to steps 8-9 (stopped at ${step})`);

// Pause, restart, resume.
tgSend(OWNER, "/pause test");
await until(() => tgOutbox.some((m) => /en pause/.test(m.text)), 30000) || fail("/pause not confirmed");
if (tgOutbox.some((m) => /Conway/.test(m.text))) fail("self-hosted message mentions Conway");
const beforeRestart = anthropicCount();
child.kill("SIGTERM");
await wait(2000);
try { execFileSync("pkill", ["-f", `http.server ${SITE_PORT}`]); } catch {}
start();
await wait(15000);
if (anthropicCount() !== beforeRestart) fail("paid call while paused (after restart)");
try {
  const code = execFileSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", `localhost:${SITE_PORT}`], { encoding: "utf-8" });
  code === "200" ? ok("autostart.sh restarted the site after a restart") : fail(`site after restart: ${code}`);
} catch { fail("site not restarted by autostart.sh"); }
if (tgOutbox.filter((m) => /Commandes Money Lab/.test(m.text)).length > 1) fail("Telegram update processed twice after restart");
tgSend(OWNER, "/reprendre");
tgSend(OWNER, "Nouveau message : reprends.");
await until(() => step >= 11, 60000) || fail(`no resume after /reprendre (step ${step})`);
await wait(3000);
child.kill("SIGTERM");
await wait(1500);

// ─── Checks after the run ───
if (tgOutbox.some((m) => m.chat_id !== OWNER)) fail("message sent to someone other than the owner");
if (tgOutbox.some((m) => /123:e2e|sk-ant-e2e|rk_test_e2e/.test(m.text))) fail("a secret leaked into Telegram");
if (!tgOutbox.some((m) => /Publier le site|ufw allow/.test(m.text))) fail("help request not notified on Telegram");
if (!tgOutbox.some((m) => /Site prêt en local/.test(m.text))) fail("message_owner not delivered");
if (stripeCalls < 1) fail("Stripe never synced");
const revenueNotes = tgOutbox.filter((m) => /Revenu confirmé par Stripe/.test(m.text)).length;
if (revenueNotes !== 1) fail(`Stripe revenue notified ${revenueNotes} times (expected once, also across restart)`);
const status = run(["dist/index.js", "--money-lab", "status"]);
if (!/Financement propriétaire : 20\.00 USD/.test(status)) fail("/fonds 5 not booked (expected 20.00 USD funding)");
if (!/Revenu confirmé par le fournisseur : 10\.80 USD/.test(status)) fail("Stripe EUR charge not booked as 10.80 USD confirmed revenue");
if (/Autre devise/.test(status)) fail("other-currency charge imported");
const spent = status.match(/dépensé ([\d.]+) USD/);
const total = cacheState.hits + cacheState.misses;
console.log(`  history cache: ${cacheState.hits}/${total} consecutive requests reuse the previous history`);
if (total > 0 && cacheState.hits / total < 0.5) fail(`history cache hit rate too low (${cacheState.hits}/${total})`);
console.log(`  spent per status: ${spent?.[1]} USD over ${log.filter((l) => l.kind === "anthropic").length} Anthropic requests`);
if (/Error|ERROR|FATAL/.test(out)) {
  for (const line of out.split("\n").filter((l) => /ERROR|FATAL|Error:/.test(l)).slice(0, 15)) console.log(`  log: ${line.slice(0, 300)}`);
}
fs.writeFileSync(path.join(HOME, "e2e-run.log"), out);
fs.writeFileSync(path.join(HOME, "e2e-requests.json"), JSON.stringify(log, null, 1));
console.log(`Logs: ${HOME}/e2e-run.log, ${HOME}/e2e-requests.json`);
for (const p of [SITE_PORT, PORT2]) { try { execFileSync("pkill", ["-f", `http.server ${p}`]); } catch {} }
server.close();
console.log(findings.length ? `\nFAILED: ${findings.length} finding(s)` : "\nPASS: no findings");
process.exit(findings.length ? 1 : 0);
