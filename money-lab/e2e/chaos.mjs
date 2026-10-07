// Chaos run of the self-hosted runtime: the real built process against fake
// services that fail on purpose. No real network, no API key, no cost.
//
//   pnpm run build && node money-lab/e2e/chaos.mjs
//
// Anthropic is overloaded (529) for a while, then answers with a broken
// body, then with 12 tool calls in one turn; Telegram is down while the
// owner writes. The runtime must survive, alert the owner once Telegram is
// back, deliver the reply to a command sent during the outage, read the
// owner's message, and keep every request valid.
import http from "http";
import { spawn, execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { validate } from "./validate.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(HERE, "..", "..");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ml-chaos-"));
const OWNER = 6151371036;
const findings = [];
const fail = (msg) => { findings.push(msg); console.log(`  ✗ ${msg}`); };
const ok = (msg) => console.log(`  ✓ ${msg}`);

let phase = "overloaded";
let overloadedLeft = 18; // HTTP attempts answered 529 (the SDK retries each call)
let requests = 0;
let msgId = 0;
let ownerRead = false;
let parallelDone = false;
const reply = (content, stop = "tool_use") => ({
  id: `msg_${++msgId}`, type: "message", role: "assistant", model: "claude-sonnet-5-5",
  content, stop_reason: stop, stop_sequence: null,
  usage: { input_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 50 },
});

function anthropic(body) {
  requests++;
  if (overloadedLeft > 0) {
    overloadedLeft--;
    return { status: 529, body: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } };
  }
  if (phase === "overloaded") {
    phase = "broken";
    return { status: 200, raw: "{\"id\": \"msg_x\", \"type\": \"message\", \"content\": [" };
  }
  const errs = validate(body);
  if (errs.length) {
    fail(`request the API would reject: ${errs.join("; ")}`);
    return { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: errs[0] } } };
  }
  const text = JSON.stringify(body.messages);
  if (/Vérifie le serveur/.test(text)) ownerRead = true;
  if (ownerRead && !parallelDone) {
    parallelDone = true;
    const uses = Array.from({ length: 12 }, (_, i) => ({ type: "tool_use", id: `toolu_p_${i}`, name: "exec", input: { command: `echo part-${i}` } }));
    return { status: 200, body: reply([{ type: "text", text: "Je vérifie tout en parallèle." }, ...uses]) };
  }
  return { status: 200, body: reply([{ type: "text", text: "Rien d'autre à faire." }], "end_turn") };
}

let telegramDown = true;
const tgQueue = [];
const tgOutbox = [];
let updateId = 500;
const tgSend = (text) => tgQueue.push({
  update_id: ++updateId,
  message: { message_id: updateId, date: Math.floor(Date.now() / 1000), chat: { id: OWNER, type: "private" }, from: { id: OWNER, is_bot: false, first_name: "Malik" }, text },
});

const server = http.createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  const send = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(typeof obj === "string" ? obj : JSON.stringify(obj)); };
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/anthropic/v1/messages")) {
    const out = anthropic(JSON.parse(raw));
    return out.raw ? send(out.status, out.raw) : send(out.status, out.body);
  }
  if (url.pathname.startsWith("/telegram/")) {
    const method = url.pathname.split("/").pop();
    const params = raw ? JSON.parse(raw) : {};
    if (method === "getUpdates") {
      return send(200, { ok: true, result: tgQueue.filter((u) => u.update_id >= Number(params.offset || 0)) });
    }
    if (method === "sendMessage") {
      if (telegramDown) return send(502, { ok: false, description: "Bad Gateway" });
      tgOutbox.push(params);
      return send(200, { ok: true, result: { message_id: 1, date: 0, chat: { id: params.chat_id }, text: params.text } });
    }
    return send(200, { ok: true, result: true });
  }
  send(404, { error: "unknown" });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;

const env = { PATH: process.env.PATH, HOME, LANG: "C.UTF-8" };
const run = (args) => execFileSync("node", args, { cwd: REPO, env, encoding: "utf-8" });
run(["money-lab/vps/configure.mjs", "--chat-id", String(OWNER), "--daily-budget", "2", "--no-stripe"]);
run(["dist/index.js", "--money-lab", "ledger-add", "owner_funding", "1500", "depot-chaos"]);

let out = "";
const child = spawn("node", ["dist/index.js", "--run"], {
  cwd: REPO,
  env: { ...env, ANTHROPIC_API_KEY: "sk-ant-chaos", TELEGRAM_BOT_TOKEN: "123:chaos", E2E_PORT: String(PORT),
    NODE_OPTIONS: `--import ${path.join(HERE, "preload.mjs")}` },
  stdio: ["ignore", "pipe", "pipe"],
});
let exited = null;
child.on("exit", (code) => { exited = code; });
child.stdout.on("data", (d) => { out += d; });
child.stderr.on("data", (d) => { out += d; });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await wait(500); } return false; };

// While Anthropic is overloaded and Telegram is down, the owner writes.
await wait(4000);
tgSend("/statut");
await until(() => /consecutive errors|5 erreurs|enchaîné/.test(out), 120_000)
  ? ok("five failed turns are detected") : fail("repeated errors were not detected");
tgSend("Vérifie le serveur s'il te plaît.");
await wait(15_000);
telegramDown = false;
await until(() => tgOutbox.some((m) => /ÉTAT MONEY LAB/.test(m.text)), 60_000)
  ? ok("the /statut reply sent during the outage arrives once Telegram is back")
  : fail("the /statut reply was lost during the Telegram outage");
await until(() => tgOutbox.some((m) => /enchaîné/.test(m.text)), 30_000)
  ? ok("the owner is alerted about the repeated errors") : fail("no error alert reached the owner");
await until(() => ownerRead, 120_000)
  ? ok("the owner's message sent during the outage is read") : fail("the owner's message was never read");
await until(() => parallelDone && requests > 0 && /part-9/.test(out), 60_000)
  ? ok("a turn with 12 tool calls runs (10 executed)") : fail("the 12-call turn did not run");
await wait(8000);
exited === null ? ok("the runtime survived every failure") : fail(`the runtime exited with code ${exited}`);
if (tgOutbox.some((m) => /123:chaos|sk-ant-chaos/.test(m.text))) fail("a secret leaked into Telegram");
const statusOwner = tgOutbox.filter((m) => /ÉTAT MONEY LAB/.test(m.text)).length;
if (statusOwner !== 1) fail(`/statut answered ${statusOwner} times`);
child.kill("SIGTERM");
await wait(1500);
fs.writeFileSync(path.join(HOME, "chaos-run.log"), out);
console.log(`Log: ${HOME}/chaos-run.log (${requests} Anthropic requests)`);
server.close();
console.log(findings.length ? `\nFAILED: ${findings.length} finding(s)` : "\nPASS: no findings");
process.exit(findings.length ? 1 : 0);
