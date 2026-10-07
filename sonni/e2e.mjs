// End-to-end check of Sonni's first slice: runs the real built process
// (dist/index.js --run) as on the VPS, against fake Kraken, Anthropic and
// Telegram servers. No real network, no API key, no cost. About 2 minutes.
//
//   pnpm run build && node sonni/e2e.mjs
//
// It checks: prices collected at start and again one interval later;
// prices kept across a restart; a decision session that reads the memory
// pack and records a prediction linked to the owner's hypothesis; Money
// Lab's web-business tools not offered; daily history fetched and the
// intake run on the stronger model with code's historical verdict;
// headlines digested by a (fake) free reader into an observation shown in
// the pack; data sources polled into indicators; a watch and a reflection
// written by the model; a self-wake on a large price move; /statut,
// /identite, /sources and /bilan answered in French.
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

// Intake wake (once history is stored): propose one hypothesis with a rule, read code's verdict.
const intake = { requests: 0, model: null, proposed: false, batches: 0, verdict: null };
function intakeModel(body, results) {
  intake.requests++;
  intake.model ??= body.model;
  intake.verdict ??= results.find((r) => /Hypothesis h_\w+ recorded \(prior\)\. history/.test(r)) ?? null;
  // Three turns of 10 hypotheses (the runtime runs at most 10 tool calls per turn), the first with a rule.
  if (intake.batches < 3) {
    const n = intake.batches++;
    intake.proposed = true;
    return reply(Array.from({ length: 10 }, (_, i) => n === 0 && i === 0
      ? use("propose_hypothesis", {
          statement: "BTC rebounds the day after a drop of 3 % or more",
          test_rule: { claim: "more_often_than_usual", when: [{ kind: "return", asset: "BTC", days: 1, op: "<=", value: -3 }],
            then: { kind: "forward_return", asset: "BTC", days: 1, op: ">", value: 0 } },
        })
      : use("propose_hypothesis", { statement: `Prior belief number ${n * 10 + i} about crypto markets` })));
  }
  intake.done = true;
  return reply([use("sleep", { duration_seconds: 3600, reason: "intake done" })]);
}

let wokenByMove = false;
let booted = false;
/** The fake Kraken holds daily history until the startup cycle has slept, so the history wake is exercised. */
let ohlcReleased = false;
function model(body) {
  const results = toolResults(body);
  const lastUser = [...body.messages].reverse().find((m) => m.role === "user");
  const lastUserText = JSON.stringify(lastUser ?? "");
  const inIntake = lastUserText.includes("SONNI INTAKE") || (intake.proposed && !intake.done);
  if (inIntake) return intakeModel(body, results);
  // Startup cycle, before any history: nothing to do yet, sleep (the history then wakes it).
  if (!booted) {
    booted = true;
    return reply([use("sleep", { duration_seconds: 3600, reason: "waiting for history" })]);
  }
  // The self-wake after the price jump: the runtime says why it woke the model.
  if (/Wake-up reason: BTC \+\d/.test(lastUserText) && !wokenByMove) {
    wokenByMove = true;
    ok("woken by code after the BTC move, with the reason in the wake message");
    return reply([use("sleep", { duration_seconds: 3600, reason: "nothing to add after the move" })]);
  }
  const system = (body.system ?? []).map((b) => b.text).join("") + JSON.stringify(body.messages.filter((m) => m.role === "system"));
  switch (step) {
    case 0: {
      system.includes("## Sonni Mission") ? ok("Sonni mission in the system prompt") : fail("Sonni mission missing");
      if (system.includes("## Money Lab Mission")) fail("Money Lab mission still in the prompt");
      if (system.includes("Pay for compute or die")) fail("automaton survival rules still in Sonni's prompt");
      /## Your identity \(version 1/.test(system) ? ok("seed identity in the system prompt") : fail("identity block missing");
      // Everything up to the rules block is cacheable: the rules block must be the last system text.
      const rulesAt = system.indexOf("--- SONNI RULES");
      rulesAt > 0 && system.indexOf("--- AVAILABLE TOOLS ---") < rulesAt ? ok("rules block after the tool list (cached prefix)") : fail("rules block not last in the system prompt");
      const offered = new Set(body.tools.map((t) => t.name));
      for (const t of ["sonni_memory", "record_prediction", "message_owner", "sleep", "write_reflection", "set_watch", "read_page", "manage_source", "follow_asset", "revise_identity", "add_lesson"]) {
        if (!offered.has(t)) fail(`tool ${t} not offered`);
      }
      for (const t of ["record_experiment", "idea", "post_social", "check_domain", "spawn_child", "update_soul", "remember_fact", "distress_signal"]) if (offered.has(t)) fail(`tool ${t} offered`);
      step++;
      return reply([use("sonni_memory", {})]);
    }
    case 1: {
      const pack = results.find((r) => r.includes("MEMORY PACK")) ?? "";
      /news\.example: Spot ETF inflows reach a record/.test(pack) && /UNTRUSTED DATA/.test(pack)
        ? ok("memory pack shows the fetched headline as untrusted data") : fail("headline missing from the memory pack");
      /press\.example: Fed signals patience on rate cuts/.test(pack)
        ? ok("memory pack shows a headline read from an RSS feed") : fail("RSS headline missing from the memory pack");
      /Observations, last 24 h \(1,[^\n]*\n- BTC: 1 item\(s\), mean sentiment \+0\.60\n\s+[^\n]*\[etf\] Record inflows into spot bitcoin ETFs/.test(pack)
        ? ok("memory pack shows the observation the fake reader extracted") : fail("observation from the reader missing from the memory pack");
      /Indicators from your sources[^\n]*\n(- [^\n]*\n)*- Crypto Fear & Greed \(alternative\.me\) index: 27\.00/.test(pack)
        ? ok("memory pack shows the Fear & Greed index polled from the fake source") : fail("source indicator missing from the memory pack");
      /SELF-REPORT \(computed by code/.test(pack) ? ok("memory pack carries the self-report") : fail("self-report missing");
      /Upcoming events[^\n]*\n- \d{4}-\d{2}-\d{2} fomc/.test(pack) ? ok("memory pack shows the next Fed decision") : fail("Fed decision missing from the memory pack");
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
      return reply([
        use("set_watch", { action: "add", kind: "price", asset: "BTC", direction: "above", value: 70000, note: "Si BTC dépasse 70 000, revoir mon hypothèse de marché calme" }),
        use("write_reflection", { kind: "session", content: "Première séance : marché calme, une prédiction prudente à 24 h et une veille au-dessus de 70 000 EUR." }),
      ]);
    }
    case 3: {
      results.some((r) => /Watch set: w_\w+ \[price\] BTC above 70000 EUR/.test(r)) ? ok("watch set through the agent loop") : fail(`watch not set: ${results.at(-1)}`);
      results.some((r) => /Reflection r_\w+ \(session\) recorded/.test(r)) ? ok("reflection written through the agent loop") : fail(`reflection not written: ${results.at(-1)}`);
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
const ohlcCalls = [];
let gdeltCalls = 0;
let feedCalls = 0;
let readerCalls = 0;
const sourceCalls = { fng: 0, coingecko: 0, mempool: 0, depth: 0 };
let tick = 0;
/** Once set, the fake ticker jumps 4 % so code wakes the sleeping agent. */
let jump = false;

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
  if (url.pathname.startsWith("/fed/")) {
    // Next FOMC decision in 9 days, in the page's own markup.
    const d = new Date(Date.now() + 9 * 86_400_000);
    const month = d.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(`<h4>${d.getUTCFullYear()} FOMC Meetings</h4><div class="fomc-meeting__month col-xs-5"><strong>${month}</strong></div>` +
      `<div class="fomc-meeting__date col-xs-4">${d.getUTCDate()}</div>`);
  }
  if (url.pathname.startsWith("/rss/")) {
    // Fake RSS feed (same item for every feed; stored once by URL).
    feedCalls++;
    const pub = new Date(Date.now() - 2_700_000).toUTCString();
    res.writeHead(200, { "content-type": "application/xml" });
    return res.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>feed</title><item><title><![CDATA[Fed signals patience on rate cuts]]></title><link>https://press.example/fed-patience</link><pubDate>${pub}</pubDate></item></channel></rss>`);
  }
  if (url.pathname.startsWith("/gdelt/")) {
    gdeltCalls++;
    const seen = new Date(Date.now() - 1_800_000).toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
    return send(200, { articles: [{ url: "https://news.example/etf", title: "Spot ETF inflows reach a record", domain: "news.example", seendate: seen }] });
  }
  if (url.pathname.startsWith("/gemini/")) {
    // Fake free reader: an OpenAI-compatible completion that digests the single headline.
    readerCalls++;
    if (req.headers.authorization !== "Bearer gem-e2e") fail(`reader called without the sealed key (${req.headers.authorization})`);
    const body = JSON.parse(raw);
    if (body.model !== "gemini-3.5-flash-lite" || body.response_format?.type !== "json_object") fail(`reader request unexpected: ${JSON.stringify(body).slice(0, 200)}`);
    const content = JSON.stringify({ items: [{ i: 0, assets: ["BTC"], kind: "etf", sentiment: 0.6, summary: "Record inflows into spot bitcoin ETFs." }] });
    return send(200, { id: "chatcmpl-e2e", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] });
  }
  if (url.pathname.startsWith("/groq/")) return send(401, { error: { message: "no key" } });
  if (url.pathname.startsWith("/fng/")) {
    sourceCalls.fng++;
    return send(200, { name: "Fear and Greed Index", data: [{ value: "27", value_classification: "Fear", timestamp: String(Math.floor(Date.now() / 1000)) }] });
  }
  if (url.pathname.startsWith("/coingecko/")) {
    sourceCalls.coingecko++;
    return send(200, { data: { total_market_cap: { eur: 2.1e12 }, market_cap_percentage: { btc: 58.2, eth: 12.1 }, market_cap_change_percentage_24h_usd: -1.4 } });
  }
  if (url.pathname.startsWith("/mempool/")) {
    sourceCalls.mempool++;
    return send(200, { fastestFee: 12, halfHourFee: 10, hourFee: 8, economyFee: 4, minimumFee: 2 });
  }
  if (url.pathname.startsWith("/kraken/0/public/Depth")) {
    sourceCalls.depth++;
    return send(200, { error: [], result: { XXBTZEUR: { asks: [["60010.0", "1.000", 1]], bids: [["59990.0", "1.000", 1]] } } });
  }
  if (url.pathname.startsWith("/kraken/0/public/OHLC")) {
    // Held (under the runtime's 20-s fetch timeout) until the startup cycle sleeps.
    const heldUntil = Date.now() + 15000;
    while (!ohlcReleased && Date.now() < heldUntil) await new Promise((r) => setTimeout(r, 200));
    // 400 committed days in a 5-day cycle (+1, -1, +1, -4, +5 %), then the unfinished day.
    const pair = url.searchParams.get("pair");
    ohlcCalls.push(pair);
    const rows = [];
    let close = pair === "XBTEUR" ? 50000 : 2000;
    const start = Math.floor(Date.now() / 86_400_000) * 86_400 - 401 * 86_400;
    for (let i = 0; i < 400; i++) {
      const r = i === 0 ? 0 : [1, -1, 1, -4, 5][(i - 1) % 5];
      const open = close;
      close = open * (1 + r / 100);
      rows.push([start + i * 86_400, String(open), String(Math.max(open, close)), String(Math.min(open, close)), String(close), "0", "100", 10]);
    }
    const last = rows.at(-1)[0];
    rows.push([last + 86_400, "1", "1", "1", "1", "0", "1", 1]);
    return send(200, { error: [], result: { [`X${pair}Z`]: rows, last } });
  }
  if (url.pathname.startsWith("/kraken/0/public/Ticker")) {
    const pair = url.searchParams.get("pair");
    krakenCalls.push({ at: Date.now(), pair });
    const price = pair === "XBTEUR" ? (jump ? 62500 : 60000 + 10 * ++tick) : 2400 + tick;
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

// ─── Set up like sonni/GUIDE-VPS.fr.md, with faster timers ───
const env = { PATH: process.env.PATH, HOME, LANG: "C.UTF-8" };
const run = (args) => execFileSync("node", args, { cwd: REPO, env, encoding: "utf-8" });
console.log(`HOME=${HOME}`);
const configured = run(["sonni/vps/configure.mjs", "--chat-id", String(OWNER), "--monthly-budget-eur", "50", "--eur-usd", "1.16"]);
/Configuration Sonni écrite/.test(configured) && /58\.00 \$, plafond 1\.93 \$\/jour/.test(configured) && /owner_funding 5800/.test(configured)
  ? ok("sonni/vps/configure.mjs writes the config: 50 EUR = 58.00 $/month, 1.93 $/day")
  : fail(`configure output unexpected: ${configured}`);
// Re-running it for an update keeps the config and does not ask for the month's budget again.
const reconfigured = run(["sonni/vps/configure.mjs", "--chat-id", String(OWNER), "--monthly-budget-eur", "50", "--eur-usd", "1.16"]);
/Mise à jour/.test(reconfigured) && !/owner_funding/.test(reconfigured) && /gemini \(clé GEMINI_API_KEY\), groq \(clé GROQ_API_KEY\)/.test(reconfigured)
  ? ok("configure.mjs re-run for an update: readers listed, no second budget asked")
  : fail(`configure re-run output unexpected: ${reconfigured}`);
// Without --chat-id, an update keeps the chat id already configured.
const reconfiguredNoId = run(["sonni/vps/configure.mjs", "--monthly-budget-eur", "50", "--eur-usd", "1.16"]);
new RegExp(`Telegram : chat ${OWNER}\\b`).test(reconfiguredNoId) && /Mise à jour/.test(reconfiguredNoId)
  ? ok("configure.mjs re-run without --chat-id keeps the configured chat id")
  : fail(`configure re-run without --chat-id: ${reconfiguredNoId}`);
const configPath = path.join(HOME, ".automaton", "automaton.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
if (config.moneyLab.stripe !== null || config.moneyLab.resources[0].expectedDailyCostCents !== 0) fail("configure kept Stripe or a VPS cost");
if (fs.existsSync(path.join(HOME, ".automaton", "skills", "money-lab-strategy"))) fail("Money Lab strategy skill installed for Sonni");
// Faster than production (5 / 15 min) so the run fits in two minutes.
config.trader = { ...config.trader, collectMinutes: 1, staleMinutes: 2 };
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
run(["dist/index.js", "--money-lab", "ledger-add", "owner_funding", "5800", "budget-octobre"]);
console.log(run(["dist/index.js", "--sonni", "idee", "BTC reste au-dessus de 59 000 EUR quand la semaine est calme"]).trim());

let child;
let out = "";
function start() {
  child = spawn("node", ["dist/index.js", "--run"], {
    cwd: REPO,
    env: { ...env, ANTHROPIC_API_KEY: "sk-ant-e2e", TELEGRAM_BOT_TOKEN: "123:e2e", GEMINI_API_KEY: "gem-e2e", E2E_PORT: String(PORT),
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
// Release the daily history once the startup cycle has gone to sleep.
void until(() => /Sleeping for \d+s/.test(out), 14000).then(() => { ohlcReleased = true; });
await until(() => krakenCalls.length >= 2, 20000)
  ? ok("prices collected at startup (BTC and ETH)")
  : fail("no price collection at startup");

// Second collection one interval (1 min here, 5 min in production) later.
await until(() => krakenCalls.filter((c) => c.pair === "XBTEUR").length >= 2, 80000)
  ? ok(`second BTC collection after ${Math.round((krakenCalls.filter((c) => c.pair === "XBTEUR")[1].at - started) / 1000)} s`)
  : fail("no second collection within the interval");

// History arrives after the startup cycle slept; code wakes the sleeping agent for its intake.
await until(() => intake.done, 90000) || fail("no intake wake after the history arrived");
/Woken by sonni_history: Historique disponible/.test(out)
  ? ok("the history woke the sleeping agent for its intake (sonni_history wake honoured)")
  : fail("the intake did not come from a sonni_history wake");
ohlcCalls.includes("XBTEUR") && ohlcCalls.includes("ETHEUR") ? ok("daily history fetched for BTC and ETH") : fail("daily history not fetched");
intake.model === "claude-opus-5-5" ? ok("intake runs on the stronger model") : fail(`intake model: ${intake.model}`);
/79\/79 = 100 % vs 60 % on all days.*SUPPORTED/.test(intake.verdict ?? "")
  ? ok("propose_hypothesis returns code's historical verdict")
  : fail(`unexpected intake verdict: ${intake.verdict}`);

readerCalls >= 1 ? ok("headline digested by the fake free reader at startup") : fail("reader never called");
sourceCalls.fng >= 1 && sourceCalls.coingecko >= 1 && sourceCalls.mempool >= 1 && sourceCalls.depth >= 1
  ? ok("default data sources polled at startup") : fail(`sources not polled: ${JSON.stringify(sourceCalls)}`);

// The owner's message wakes Sonni for a normal decision session.
const loopEnds = () => (out.match(/Agent loop finished\. State: sleeping/g) ?? []).length;
const endsBeforeDecision = loopEnds();
tgSend("Bonjour Sonni, regarde le marché.");
await until(() => step >= 4, 60000) || fail(`decision session stopped at step ${step}`);

// A 4 % jump in the next collections: code wakes the sleeping agent (at most one wake per 30 min).
// Wait for the decision cycle itself to end before the jump.
await until(() => loopEnds() > endsBeforeDecision, 20000) || fail("decision cycle did not end in a sleep");
jump = true;
const jumpedAt = Date.now();
await until(() => wokenByMove, 150000)
  ? ok(`self-wake ${Math.round((Date.now() - jumpedAt) / 1000)} s after the 4 % move (collection, trigger, 30-s sleep poll)`)
  : fail("no self-wake after the 4 % move within 150 s");
/\[SONNI\] Réveil : BTC \+\d/.test(out) ? ok("runtime logged the curiosity wake") : fail("curiosity wake not logged");

tgSend("/agenda");
await until(() => tgOutbox.some((m) => /décision de taux de la Fed/.test(m.text)), 30000)
  ? ok("/agenda lists the next Fed decision in French") : fail("/agenda without the Fed decision");
gdeltCalls >= 1 ? ok("headlines fetched from GDELT") : fail("GDELT never called");
feedCalls >= 4 ? ok(`RSS feeds fetched beside GDELT (${feedCalls} calls)`) : fail(`RSS feeds called ${feedCalls} times`);

tgSend("/statut");
await until(() => tgOutbox.some((m) => /SONNI/.test(m.text)), 30000) || fail("/statut got no Sonni answer");
const statut = tgOutbox.find((m) => /SONNI/.test(m.text))?.text ?? "";
/Prédictions ouvertes \(1\)/.test(statut) ? ok("/statut shows the open prediction in French") : fail("/statut lacks the open prediction");
// 62 500 EUR after the jump (narrow no-break space from the French locale).
/BTC : 62\s?500,00 €/.test(statut) ? ok("/statut shows the BTC price in euros") : fail("/statut lacks the BTC price");
/confirmée par l'historique/.test(statut) ? ok("/statut shows the historical verdict in French") : fail("/statut lacks the historical verdict");
/Vie de Sonni : 1 réveil\(s\) sur 6 aujourd'hui/.test(statut) ? ok("/statut counts the self-wake") : fail("/statut does not count the self-wake");

tgSend("/identite");
await until(() => tgOutbox.some((m) => /Identité de Sonni — version 1, écrite par le code/.test(m.text)), 30000)
  ? ok("/identite shows the seed identity in French") : fail("/identite got no answer");
tgSend("/sources");
await until(() => tgOutbox.some((m) => /fear_greed \[active\]/.test(m.text) && /index: 27\.00/.test(m.text)), 30000)
  ? ok("/sources lists the sources and the polled value") : fail("/sources got no answer");
tgSend("/journal");
await until(() => tgOutbox.some((m) => /Première séance : marché calme/.test(m.text)), 30000)
  ? ok("/journal shows the reflection written by the model") : fail("/journal lacks the reflection");
tgSend("/bilan");
await until(() => tgOutbox.some((m) => /BILAN DE SONNI/.test(m.text)), 30000) ? ok("/bilan answers in French") : fail("/bilan got no answer");

// Restart: stored prices and the prediction survive, collection resumes.
child.kill("SIGTERM");
await wait(2000);
const afterStop = pricesStored();
/Prédictions ouvertes \(1\)/.test(afterStop) && /BTC : 62/.test(afterStop)
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
if (tgOutbox.some((m) => /123:e2e|sk-ant-e2e|gem-e2e/.test(m.text))) fail("a secret leaked into Telegram");
if (/gem-e2e/.test(out)) fail("the reader key leaked into the logs");
if (/blocked network call/.test(out)) fail("the process tried to reach an unexpected host");
fs.writeFileSync(path.join(HOME, "e2e-run.log"), out);
console.log(`Logs: ${HOME}/e2e-run.log`);
server.close();
console.log(findings.length ? `\nFAILED: ${findings.length} finding(s)` : "\nPASS: no findings");
process.exit(findings.length ? 1 : 0);
