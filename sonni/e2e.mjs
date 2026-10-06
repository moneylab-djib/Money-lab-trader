// End-to-end check of Sonni's first slice: runs the real built process
// (dist/index.js --run) as on the VPS, against fake Kraken, Anthropic and
// Telegram servers. No real network, no API key, no cost. About 2 minutes.
//
//   pnpm run build && node sonni/e2e.mjs
//
// It checks: prices collected at start and again one interval later;
// prices kept across a restart; a decision session that reads the memory
// pack and records a prediction linked to the owner's hypothesis; Money
// Lab's web-business tools not offered; /statut answered in French.
import http from "http";
import { spawn, execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { validate } from "../money-lab/e2e/validate.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(HERE, "..");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "sonni-e2e-"));
const OWNER = 6151371036;

const findings = [];
const fail = (msg) => { findings.push(msg); console.log(`  ✗ ${msg}`); };
const ok = (msg) => console.log(`  ✓ ${msg}`);

// ─── Scripted model ───
let step = 0;
let msgId = 0;
let useSeq = 0;
let hypothesisId = null;
const toolResults = (body) => body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
  .filter((b) => b.type === "tool_result")
  .map((b) => (typeof b.content === "string" ? b.content : JSON.stringify(b.content)));
const use = (name, input) => ({ type: "tool_use", id: `toolu_${step}_${++useSeq}`, name, input });
const reply = (content, stop = "tool_use") => ({
  id: `msg_${++msgId}`, type: "message", role: "assistant", model: "claude-sonnet-5-5",
  content: [{ type: "thinking", thinking: "", signature: "sig" }, ...content],
  stop_reason: stop, stop_sequence: null,
  usage: { input_tokens: 800, cache_read_input_tokens: 8000, cache_creation_input_tokens: 0, output_tokens: 150 },
});

function model(body) {
  const results = toolResults(body);
  const system = (body.system ?? []).map((b) => b.text).join("") + JSON.stringify(body.messages.filter((m) => m.role === "system"));
  switch (step) {
    case 0: {
      system.includes("## Sonni Mission") ? ok("Sonni mission in the system prompt") : fail("Sonni mission missing");
      if (system.includes("## Money Lab Mission")) fail("Money Lab mission still in the prompt");
      const offered = new Set(body.tools.map((t) => t.name));
      for (const t of ["sonni_memory", "record_prediction", "message_owner", "sleep"]) if (!offered.has(t)) fail(`tool ${t} not offered`);
      for (const t of ["record_experiment", "idea", "post_social", "check_domain", "spawn_child"]) if (offered.has(t)) fail(`tool ${t} offered`);
      step++;
      return reply([use("sonni_memory", {})]);
    }
    case 1: {
      const pack = results.find((r) => r.includes("MEMORY PACK")) ?? "";
      hypothesisId = pack.match(/h_[0-9A-Z]+/)?.[0] ?? null;
      /BTC: \d+\.\d\d EUR/.test(pack) ? ok("memory pack shows the collected BTC price") : fail("memory pack has no BTC price");
      hypothesisId ? ok("memory pack lists the owner's hypothesis") : fail("no hypothesis in the memory pack");
      step++;
      return reply([use("record_prediction", {
        asset: "BTC", direction: "above", threshold: 59000, horizon_hours: 24, probability: 0.7,
        hypothesis_id: hypothesisId ?? "h_missing", statement: "BTC above 59,000 EUR tomorrow",
        rationale: "Quiet market, price well above the threshold",
      })]);
    }
    case 2: {
      results.some((r) => /Prediction p_\w+ recorded/.test(r)) ? ok("prediction recorded through the agent loop") : fail(`prediction not recorded: ${results.at(-1)}`);
      step++;
      return reply([use("sleep", { duration_seconds: 3600, reason: "next session" })]);
    }
    default:
      step++;
      return reply([{ type: "text", text: "Rien de nouveau, je dors." }], "end_turn");
  }
}

// ─── Fake servers ───
const tgQueue = [];
const tgOutbox = [];
let updateId = 100;
const tgSend = (text) => tgQueue.push({
  update_id: ++updateId,
  message: { message_id: updateId, date: Math.floor(Date.now() / 1000), chat: { id: OWNER, type: "private" }, from: { id: OWNER, is_bot: false, first_name: "Owner" }, text },
});
const krakenCalls = [];
let tick = 0;

const server = http.createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  const send = (status, obj) => { res.writeHead(status, { "content-type": "application/json", "request-id": "req_e2e" }); res.end(JSON.stringify(obj)); };
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/anthropic/v1/messages")) {
    const body = JSON.parse(raw);
    const errs = validate(body);
    if (errs.length) {
      fail(`Anthropic would reject request (step ${step}): ${errs.join("; ")}`);
      return send(400, { type: "error", error: { type: "invalid_request_error", message: errs[0] } });
    }
    return send(200, model(body));
  }
  if (url.pathname.startsWith("/kraken/0/public/Ticker")) {
    const pair = url.searchParams.get("pair");
    krakenCalls.push({ at: Date.now(), pair });
    const price = pair === "XBTEUR" ? 60000 + 10 * ++tick : 2400 + tick;
    return send(200, { error: [], result: { [`X${pair}Z`]: { c: [String(price), "0.01"] } } });
  }
  if (url.pathname.startsWith("/telegram/")) {
    const method = url.pathname.split("/").pop();
    const params = raw ? JSON.parse(raw) : {};
    if (method === "getUpdates") {
      const offset = Number(params.offset || 0);
      return send(200, { ok: true, result: tgQueue.filter((u) => u.update_id >= offset) });
    }
    if (method === "sendMessage") {
      tgOutbox.push(params);
      return send(200, { ok: true, result: { message_id: 1, date: 0, chat: { id: params.chat_id }, text: params.text } });
    }
    return send(200, { ok: true, result: true });
  }
  send(404, { error: "unknown" });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;

// ─── Set up like the VPS guide, then add the trader block ───
const env = { PATH: process.env.PATH, HOME, LANG: "C.UTF-8" };
const run = (args) => execFileSync("node", args, { cwd: REPO, env, encoding: "utf-8" });
console.log(`HOME=${HOME}`);
run(["money-lab/vps/configure.mjs", "--chat-id", String(OWNER), "--vps-cost-per-month", "0", "--eur-usd", "1.16", "--daily-budget", "2", "--no-stripe"]);
const configPath = path.join(HOME, ".automaton", "automaton.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
const example = JSON.parse(fs.readFileSync(path.join(HERE, "automaton.sonni.example.json"), "utf-8"));
config.trader = { ...example.trader, collectMinutes: 1, staleMinutes: 2 };
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
run(["dist/index.js", "--money-lab", "ledger-add", "owner_funding", "5800", "budget-octobre"]);
console.log(run(["dist/index.js", "--sonni", "idee", "BTC reste au-dessus de 59 000 EUR quand la semaine est calme"]).trim());

let child;
let out = "";
function start() {
  child = spawn("node", ["dist/index.js", "--run"], {
    cwd: REPO,
    env: { ...env, ANTHROPIC_API_KEY: "sk-ant-e2e", TELEGRAM_BOT_TOKEN: "123:e2e", E2E_PORT: String(PORT),
      NODE_OPTIONS: `--import ${path.join(HERE, "e2e-preload.mjs")}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await wait(500); } return false; };
const pricesStored = () => {
  const status = run(["dist/index.js", "--sonni", "statut"]);
  return status;
};

start();
const started = Date.now();
await until(() => krakenCalls.length >= 2, 20000)
  ? ok("prices collected at startup (BTC and ETH)")
  : fail("no price collection at startup");
await until(() => step >= 3, 60000) || fail(`decision session stopped at step ${step}`);

// Second collection one interval (1 min here, 5 min in production) later.
await until(() => krakenCalls.filter((c) => c.pair === "XBTEUR").length >= 2, 80000)
  ? ok(`second BTC collection after ${Math.round((krakenCalls.filter((c) => c.pair === "XBTEUR")[1].at - started) / 1000)} s`)
  : fail("no second collection within the interval");

tgSend("/statut");
await until(() => tgOutbox.some((m) => /SONNI/.test(m.text)), 30000) || fail("/statut got no Sonni answer");
const statut = tgOutbox.find((m) => /SONNI/.test(m.text))?.text ?? "";
/Prédictions ouvertes \(1\)/.test(statut) ? ok("/statut shows the open prediction in French") : fail("/statut lacks the open prediction");
/BTC : 60\s?0\d\d,00 €/.test(statut) ? ok("/statut shows the BTC price in euros") : fail("/statut lacks the BTC price");

// Restart: stored prices and the prediction survive, collection resumes.
child.kill("SIGTERM");
await wait(2000);
const afterStop = pricesStored();
/Prédictions ouvertes \(1\)/.test(afterStop) && /BTC : 60/.test(afterStop)
  ? ok("prices and prediction kept after the process stopped")
  : fail("state lost after stopping the process");
const callsBefore = krakenCalls.length;
start();
await until(() => krakenCalls.length > callsBefore, 20000)
  ? ok("collection resumes after a restart")
  : fail("no collection after restart");
await wait(3000);
child.kill("SIGTERM");
await wait(1500);

if (tgOutbox.some((m) => m.chat_id !== OWNER)) fail("message sent to someone other than the owner");
if (tgOutbox.some((m) => /123:e2e|sk-ant-e2e/.test(m.text))) fail("a secret leaked into Telegram");
if (/blocked network call/.test(out)) fail("the process tried to reach an unexpected host");
fs.writeFileSync(path.join(HOME, "e2e-run.log"), out);
console.log(`Logs: ${HOME}/e2e-run.log`);
server.close();
console.log(findings.length ? `\nFAILED: ${findings.length} finding(s)` : "\nPASS: no findings");
process.exit(findings.length ? 1 : 0);
