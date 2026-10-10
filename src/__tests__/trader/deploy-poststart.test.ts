/**
 * Controlled deployment of 2026-10-10: the post-start check of the LIVE database
 * (sonni/vps/controle-apres-demarrage.mjs) and the Telegram report sender (sonni/vps/envoi-telegram.mjs).
 * The scripts run as the owner runs them, in a child process with a temporary HOME. The live database is a WAL
 * database this process keeps open (as Sonni does), the repository a temporary folder with a fake `git` on PATH
 * and the compiled files the check looks for, and Telegram a local HTTP server on 127.0.0.1. No network beyond
 * 127.0.0.1, no inference, no real Telegram, no systemctl.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";
import { pathToFileURL } from "url";
import { spawn, spawnSync } from "child_process";
import { createDatabase } from "../../state/database.js";
import { ensureMoneyLabSchema } from "../../money-lab/journal.js";
import { recordHealthEvent } from "../../money-lab/health.js";
import type { AutomatonDatabase } from "../../types.js";
import { parseTraderConfig, type TraderConfig } from "../../trader/config.js";
import { ensureTraderSchema } from "../../trader/schema.js";
import { isoSeconds } from "../../trader/prices.js";
import { brokerTick, placeOrder } from "../../trader/portfolio.js";
import { recordIncident } from "../../trader/incidents.js";

const ROOT = path.join(__dirname, "..", "..", "..");
const CONTROLE = path.join(ROOT, "sonni", "vps", "controle-apres-demarrage.mjs");
const ENVOI = path.join(ROOT, "sonni", "vps", "envoi-telegram.mjs");
const EXAMPLE = JSON.parse(fs.readFileSync(path.join(ROOT, "sonni", "automaton.sonni.example.json"), "utf-8"));
/** The owner's configuration on the VPS, with two followed assets. */
const CONFIG = {
  ...EXAMPLE,
  trader: { ...EXAMPLE.trader, assets: [{ symbol: "BTC", krakenPair: "XBTEUR" }, { symbol: "ETH", krakenPair: "ETHEUR" }] },
};
const TRADER: TraderConfig = parseTraderConfig(CONFIG.trader)!;
const THESIS = "Test du contrôle après démarrage : petite position pour que la base porte un ordre et une position.";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const OTHER_COMMIT = "fedcba9876543210fedcba9876543210fedcba98";
/** Shaped like a real bot token; it must never appear in any output. */
const TOKEN = "123456789:AAH_test-TOKEN-secret0123456789abcdef";
const SECRET_PART = TOKEN.split(":")[1];

let tmpDirs: string[] = [];
let openDbs: AutomatonDatabase[] = [];
let servers: http.Server[] = [];
function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
beforeEach(() => {
  tmpDirs = [];
  openDbs = [];
  servers = [];
});
afterEach(async () => {
  for (const db of openDbs) {
    try { db.close(); } catch { /* already closed */ }
  }
  for (const s of servers) {
    // A test server that never answers keeps its connection open: close it too.
    s.closeAllConnections();
    await new Promise((resolve) => s.close(resolve));
  }
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const sha = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const lastLine = (out: string) => out.trimEnd().split("\n").at(-1) ?? "";
/** Every time in the reports reads "10/10/2026 04:21 UTC" (never a raw ISO string). */
const WHEN = String.raw`\d{2}/\d{2}/\d{4} \d{2}:\d{2} UTC`;
const RAW_ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
/** Today's UTC day as the report writes it ("10/10/2026"). */
const todayFr = () => new Date().toISOString().slice(0, 10).split("-").reverse().join("/");

type Run = { status: number | null; stdout: string; stderr: string };
/** The script in a child process while this process keeps running (a local server can answer it). */
function runAsync(script: string, args: string[], env: NodeJS.ProcessEnv, input?: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input ?? "");
  });
}

// ─── The live database, the repository and the configuration ─────────────

/** A temporary HOME with ~/.automaton, as the sonni user has on the VPS. */
function home(): string {
  const h = tmp("sonni-poststart-home-");
  fs.mkdirSync(path.join(h, ".automaton"), { mode: 0o700 });
  return h;
}

function storePrice(db: AutomatonDatabase, asset: string, at: Date, price: number) {
  db.raw.prepare("INSERT INTO trader_prices (asset, ts, price, source) VALUES (?, ?, ?, 'test')").run(asset, isoSeconds(at), price);
}

interface Live { h: string; file: string; db: AutomatonDatabase; since: Date; at: (minutes: number) => Date }

/**
 * Sonni running since `since` (ten minutes ago, whole seconds): a funded portfolio with one BTC position bought
 * two hours before the start, prices of both followed assets before and after the start, a broker pass and a
 * paid call after it, nothing unsent. Rows from before the start that the check must ignore: a paid call, a
 * rejected order and a delivered Telegram message. The connection stays open, as Sonni's does: state.db-wal
 * exists.
 */
function healthy(): Live {
  const h = home();
  const file = path.join(h, ".automaton", "state.db");
  const db = createDatabase(file);
  openDbs.push(db);
  ensureMoneyLabSchema(db.raw);
  ensureTraderSchema(db.raw);
  const since = new Date(Math.floor((Date.now() - 10 * 60_000) / 1000) * 1000);
  const at = (minutes: number) => new Date(since.getTime() + minutes * 60_000);
  storePrice(db, "BTC", at(-180), 60_000);
  storePrice(db, "ETH", at(-180), 2_500);
  brokerTick(db.raw, TRADER, at(-180));
  storePrice(db, "BTC", at(-120), 60_050);
  expect(placeOrder(db.raw, TRADER, { asset: "BTC", side: "buy", amountEur: 100, invalidation: 42_000, thesis: THESIS } as any, at(-120)).ok).toBe(true);
  storePrice(db, "BTC", at(-114), 60_100);
  expect(brokerTick(db.raw, TRADER, at(-114)).fills.length).toBe(1);
  for (const m of [1, 6]) {
    storePrice(db, "BTC", at(m), 60_200 + m);
    storePrice(db, "ETH", at(m), 2_510 + m);
  }
  brokerTick(db.raw, TRADER, at(6));
  // The broker pass of the current minute: today's snapshot exists whatever the time of day.
  brokerTick(db.raw, TRADER, new Date());
  const paid = db.raw.prepare(
    `INSERT INTO inference_costs (id, session_id, model, provider, cost_cents, tier, task_type, created_at)
     VALUES (?, 's1', 'claude-sonnet-5-5', 'anthropic', ?, 'normal', 'agent_turn', ?)`,
  );
  paid.run("c1", 35, at(2).toISOString().replace("T", " ").slice(0, 19));
  // Before the start: not counted.
  paid.run("c0", 500, at(-30).toISOString().replace("T", " ").slice(0, 19));
  db.raw.prepare(
    `INSERT INTO trader_orders (id, placed_at, asset, side, kind, quantity, thesis, horizon_until, origin, status, settled_at, note)
     VALUES ('o_old', ?, 'ETH', 'sell', 'market', 1, ?, ?, 'model', 'rejected', ?, 'rejected by code (nothing): there is no position to sell')`,
  ).run(isoSeconds(at(-50)), THESIS, isoSeconds(at(60 * 24)), isoSeconds(at(-40)));
  db.raw.prepare("INSERT INTO money_lab_outbox (id, text, created_at, sent_at) VALUES ('msg_0', 'Bonsoir', ?, ?)")
    .run(at(-80).toISOString(), at(-79).toISOString());
  expect(fs.existsSync(`${file}-wal`)).toBe(true);
  return { h, file, db, since, at };
}

function writeConfig(h: string, config: unknown = CONFIG): string {
  const file = path.join(h, ".automaton", "automaton.json");
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  return file;
}

/**
 * A checkout as on the VPS: dist/trader/portfolio.js and incidents.js (step 0.3 or not), and a fake git that
 * answers `git -C <depot> rev-parse HEAD` with `commit`. Returns the folder and the PATH that finds the fake git.
 */
function depot(opts: { commit?: string; portfolio?: string | null; incidents?: string | null } = {}): { dir: string; PATH: string } {
  const dir = tmp("sonni-poststart-depot-");
  fs.mkdirSync(path.join(dir, "dist", "trader"), { recursive: true });
  const portfolio = opts.portfolio === undefined ? "export function positionProblem(p) {\n  return null;\n}\n" : opts.portfolio;
  const incidents = opts.incidents === undefined ? 'export const INCIDENT_KINDS = ["pause", "cap", "backup", "broker"];\n' : opts.incidents;
  if (portfolio !== null) fs.writeFileSync(path.join(dir, "dist", "trader", "portfolio.js"), portfolio);
  if (incidents !== null) fs.writeFileSync(path.join(dir, "dist", "trader", "incidents.js"), incidents);
  const bin = tmp("sonni-poststart-bin-");
  fs.writeFileSync(path.join(bin, "git"),
    `#!/bin/sh\nif [ "$1" = "-C" ] && [ "$2" = '${dir}' ] && [ "$3" = "rev-parse" ] && [ "$4" = "HEAD" ]; then\n  echo ${opts.commit ?? COMMIT}\n  exit 0\nfi\necho "fatal: unexpected git call" >&2\nexit 128\n`,
    { mode: 0o755 });
  return { dir, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` };
}

const checkEnv = (h: string, PATH: string) => ({ ...process.env, HOME: h, TMPDIR: tmp("sonni-poststart-tmp-"), PATH });
function control(live: Live, args: string[] = [], d = depot()): Run {
  const config = writeConfig(live.h);
  const r = spawnSync(process.execPath, [
    CONTROLE, "--depuis", live.since.toISOString().replace(".000Z", "Z"), "--commit-attendu", COMMIT.slice(0, 7),
    "--config", config, "--depot", d.dir, ...args,
  ], { encoding: "utf-8", env: checkEnv(live.h, d.PATH) });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("Post-start check of the live database (sonni/vps/controle-apres-demarrage.mjs)", () => {
  it("finds nothing wrong with a healthy start, and reads the live database without changing a byte", () => {
    const live = healthy();
    const before = { db: sha(live.file), wal: sha(`${live.file}-wal`) };
    const today = todayFr();
    const r = control(live);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("Contrôle après démarrage de Sonni — base active lue sans rien écrire");
    expect(r.stdout).toMatch(new RegExp(`\nDémarrage : ${WHEN} \\(il y a 10 min\\)\n`));
    expect(r.stdout).toContain(`1. Version : OK\n   - OK : commit en place : ${COMMIT}, celui attendu\n   - OK : programme compilé : la nouvelle version (étape 0.3) est dans dist/`);
    expect(r.stdout).toMatch(new RegExp(`2\\. Prix depuis le démarrage : OK\\n {3}- OK : BTC : 2 prix depuis le démarrage, dernier 60\\s206,00 € le ${WHEN}\\n {3}- OK : ETH : 2 prix depuis le démarrage`));
    // The paid call, the rejected order and the delivered message from before the start are not counted.
    expect(r.stdout).toContain("3. Appels payés depuis le démarrage : INFO\n   - INFO : 1 appel payé depuis le démarrage, 0,35 $");
    expect(r.stdout).toContain("4. Incidents depuis le démarrage : OK\n   - OK : aucun incident depuis le démarrage");
    expect(r.stdout).toContain("5. Ordres réglés depuis le démarrage : OK\n   - OK : aucun ordre refusé depuis le démarrage");
    expect(r.stdout).toMatch(/6\. Portefeuille : OK\n {3}- OK : 1 position ouverte, évaluable ; trésorerie 900,\d\d €/);
    expect(r.stdout).toContain("7. Messages Telegram : OK\n   - OK : aucun message en attente depuis plus de 10 min");
    expect(r.stdout).toContain("8. Santé (pannes enregistrées) : OK\n   - OK : aucune panne enregistrée depuis le démarrage");
    expect(r.stdout).toMatch(new RegExp(`9\\. Instantané du jour : INFO\\n {3}- INFO : instantané du ${today} présent \\(valeur [\\d\\s]+,\\d\\d €, pris le ${WHEN}\\)`));
    expect(r.stdout).toContain("Conclusion : aucune alerte.");
    expect(r.stdout).toContain("Rien n'a été écrit : la base active a été ouverte en lecture seule.");
    expect(lastLine(r.stdout)).toBe("RÉSULTAT : code=0 alertes=0");
    expect(r.stdout).not.toMatch(/\b(the|and|price|order|error)\b/);
    expect(r.stdout).not.toMatch(RAW_ISO);
    // Neither the database nor its WAL changed: nothing was written or checkpointed.
    expect(sha(live.file)).toBe(before.db);
    expect(sha(`${live.file}-wal`)).toBe(before.wal);
    // Sonni's own connection still writes: the check left no lock behind.
    storePrice(live.db, "BTC", live.at(9), 60_300);
  });

  it("opens the live database read-only only: the connection cannot write, and no writable open exists in the script", async () => {
    const live = healthy();
    const mod = await import(pathToFileURL(CONTROLE).href);
    const ro = mod.openLive(live.file);
    try {
      expect(ro.readonly).toBe(true);
      expect(() => ro.prepare("INSERT INTO kv (key, value) VALUES ('x', 'y')").run()).toThrow();
      expect(() => ro.exec("PRAGMA query_only = OFF; INSERT INTO kv (key, value) VALUES ('x', 'y')")).toThrow();
    } finally {
      ro.close();
    }
    const source = fs.readFileSync(CONTROLE, "utf-8");
    const opens = source.match(/new Database\([^)]*\)/g) ?? [];
    expect(opens).toEqual(["new Database(base, { readonly: true, fileMustExist: true })"]);
    // No statement that writes, no journal change, and query_only is the only pragma.
    expect(source).not.toMatch(/\bdb\.exec\(|\.run\(|journal_mode|wal_checkpoint|\.backup\(/);
    expect(source.match(/\.pragma\([^)]*\)/g)).toEqual(['.pragma("query_only = ON")']);
    expect(live.db.raw.prepare("SELECT COUNT(*) AS n FROM kv WHERE key = 'x'").get()).toEqual({ n: 0 });
  });

  const alerts: { name: string; setup?: (live: Live) => void; depot?: () => ReturnType<typeof depot>; expected: RegExp }[] = [
    { name: "the commit in place is not the approved one", depot: () => depot({ commit: OTHER_COMMIT }),
      expected: new RegExp(`1\\. Version : ALERTE\\n {3}- ALERTE : le commit en place \\(${OTHER_COMMIT}\\) n'est pas celui attendu \\(0123456\\)`) },
    { name: "the compiled program is the old version (no positionProblem)", depot: () => depot({ portfolio: "export function valuation() {}\n" }),
      expected: /ALERTE : le programme compilé n'est pas la nouvelle version \(dist\/trader\/portfolio\.js sans positionProblem\)/ },
    { name: "the compiled program is missing (no dist/trader/incidents.js)", depot: () => depot({ incidents: null }),
      expected: /ALERTE : le programme compilé n'est pas la nouvelle version \(dist\/trader\/incidents\.js absent\)/ },
    { name: "a followed asset has no price since the start",
      setup: ({ db, at }) => {
        // Sonni chose to follow PAXG (universe log): it is followed although the owner's config does not list it.
        db.raw.prepare("INSERT INTO trader_universe (id, asset, kraken_pair, action, reason, recorded_at) VALUES ('u1', 'PAXG', 'PAXGEUR', 'follow', 'or tokenisé', ?)").run(at(-200).toISOString());
        storePrice(db, "PAXG", at(-60), 3_500);
      },
      expected: new RegExp(`2\\. Prix depuis le démarrage : ALERTE\\n {3}- ALERTE : aucun prix de PAXG depuis le démarrage \\(dernier prix : ${WHEN}\\)`) },
    { name: "a virtual broker incident", setup: ({ db, at }) => recordIncident(db.raw, "broker", "ordre o_x (achat PUMP) refusé par le courtier virtuel : prix d'exécution nul.", at(3)),
      expected: new RegExp(`4\\. Incidents depuis le démarrage : ALERTE\\n {3}- ALERTE : courtier virtuel le ${WHEN} : ordre o_x \\(achat PUMP\\) refusé par le courtier virtuel`) },
    { name: "a rejected order placed after the start",
      setup: ({ db, at }) => {
        db.raw.prepare(
          `INSERT INTO trader_orders (id, placed_at, asset, side, kind, quantity, thesis, horizon_until, origin, status, settled_at, note)
           VALUES ('o_rej', ?, 'ETH', 'sell', 'market', 1, ?, ?, 'model', 'rejected', ?, 'rejected by code (nothing): there is no position to sell')`,
        ).run(isoSeconds(at(2)), THESIS, isoSeconds(at(60 * 24)), isoSeconds(at(3)));
      },
      expected: new RegExp(`5\\. Ordres réglés depuis le démarrage : ALERTE\\n {3}- ALERTE : ordre o_rej \\(vente ETH\\) refusé le ${WHEN} : aucune position à vendre\\n`) },
    { name: "a corrupt position (infinite quantity, average cost 0)",
      setup: ({ db, at }) => {
        db.raw.prepare("INSERT INTO trader_positions (asset, quantity, avg_cost, opened_at, open_order_id, invalidation, horizon_until, thesis, updated_at) VALUES ('PUMP', 9e999, 0, ?, 'o_pump', NULL, NULL, ?, ?)")
          .run(isoSeconds(at(-300)), THESIS, isoSeconds(at(-300)));
      },
      expected: /6\. Portefeuille : ALERTE\n {3}- ALERTE : valeur du portefeuille non fiable : position PUMP invalide \(quantité non finie ou invalide ; quantité non finie, coût moyen 0,00 €\)/ },
    { name: "an owner message stuck in the Telegram outbox",
      setup: ({ db }) => {
        db.raw.prepare("INSERT INTO money_lab_outbox (id, text, created_at) VALUES ('msg_1', 'Bonjour', ?)").run(new Date(Date.now() - 20 * 60_000).toISOString());
      },
      expected: /7\. Messages Telegram : ALERTE\n {3}- ALERTE : messages Telegram en attente : 1 message non envoyé depuis plus de 10 min \(le plus ancien du .*\)/ },
    { name: "agent turns fail again and again since the start (5, the runtime's own problem threshold)",
      setup: ({ db, at }) => { for (let m = 3; m < 8; m++) recordHealthEvent(db.raw, "turn", `Anthropic API error 529 overloaded (${m})`, at(m)); },
      expected: new RegExp(`8\\. Santé \\(pannes enregistrées\\) : ALERTE\\n {3}- ALERTE : tour de l'agent en échec 5 fois depuis le démarrage \\(dernière fois le ${WHEN}\\) : « Anthropic API error 529 overloaded \\(7\\) »\\n`) },
    { name: "a background task fails three times since the start",
      setup: ({ db, at }) => { for (let m = 3; m < 6; m++) recordHealthEvent(db.raw, "Sonni résolution", "SqliteError: no such column: x", at(m)); },
      expected: new RegExp(`8\\. Santé \\(pannes enregistrées\\) : ALERTE\\n {3}- ALERTE : tâche Sonni résolution en échec 3 fois depuis le démarrage \\(dernière fois le ${WHEN}\\) : « SqliteError: no such column: x »\\n`) },
    { name: "Telegram fails for five minutes (30 failures of its 10-second tick)",
      setup: ({ db, at }) => { for (let i = 0; i < 30; i++) recordHealthEvent(db.raw, "Telegram", "fetch failed", new Date(at(2).getTime() + i * 10_000)); },
      expected: /8\. Santé \(pannes enregistrées\) : ALERTE\n {3}- ALERTE : tâche Telegram en échec 30 fois depuis le démarrage/ },
  ];
  for (const a of alerts) {
    it(`raises one ALERTE and exits 1 when ${a.name}`, () => {
      const live = healthy();
      a.setup?.(live);
      const before = sha(live.file);
      const r = control(live, [], a.depot?.());
      expect(r.status, r.stdout + r.stderr).toBe(1);
      expect(r.stdout).toMatch(a.expected);
      expect(r.stdout).toContain("Conclusion : 1 alerte. Ce sont des déclencheurs de retour arrière");
      expect(lastLine(r.stdout)).toBe("RÉSULTAT : code=1 alertes=1");
      expect(sha(live.file)).toBe(before);
    });
  }

  it("reports, without alerting, incidents of other kinds, fills, failures that do not repeat, an older failure and recent unsent messages", () => {
    const live = healthy();
    recordIncident(live.db.raw, "pause", "pause automatique : 3 erreurs de suite", live.at(4));
    recordIncident(live.db.raw, "broker", "ancien incident d'avant le démarrage", live.at(-30));
    recordHealthEvent(live.db.raw, "collect", "Kraken XBTEUR: timeout", live.at(-30));
    // Passing failures right after the start, as src/money-lab/health.ts rates them: Telegram hiccups, one
    // overloaded turn, a background task that failed twice. None is a rollback trigger.
    for (const m of [1, 2, 3]) recordHealthEvent(live.db.raw, "Telegram", "fetch failed", live.at(m));
    recordHealthEvent(live.db.raw, "turn", "Anthropic API error 529 overloaded", live.at(2));
    for (const m of [1, 4]) recordHealthEvent(live.db.raw, "Sonni calendrier", "FRED: timeout", live.at(m));
    live.db.raw.prepare("INSERT INTO money_lab_outbox (id, text, created_at) VALUES ('msg_2', 'Rapport', ?)").run(new Date(Date.now() - 60_000).toISOString());
    storePrice(live.db, "ETH", live.at(7), 2_520);
    expect(placeOrder(live.db.raw, TRADER, { asset: "ETH", side: "buy", amountEur: 50, invalidation: 2_000, thesis: THESIS } as any, live.at(7)).ok).toBe(true);
    storePrice(live.db, "ETH", live.at(8), 2_521);
    expect(brokerTick(live.db.raw, TRADER, live.at(8)).fills.length).toBe(1);
    const r = control(live);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/4\. Incidents depuis le démarrage : OK\n {3}- OK : aucun incident « courtier virtuel » ni « sauvegarde »\n {3}- INFO : pause automatique le .* : pause automatique : 3 erreurs de suite/);
    expect(r.stdout).not.toContain("ancien incident");
    expect(r.stdout).toMatch(/- INFO : ordre o_\w+ \(achat ETH\) exécuté à 2\s5\d\d,\d\d € le /);
    expect(r.stdout).toContain("- INFO : 1 message de moins de 10 min pas encore envoyé");
    expect(r.stdout).not.toContain("Kraken XBTEUR");
    expect(r.stdout).toMatch(new RegExp([
      "8\\. Santé \\(pannes enregistrées\\) : OK",
      "   - OK : aucune panne répétée depuis le démarrage",
      `   - INFO : tâche Telegram en échec 3 fois depuis le démarrage \\(dernière fois le ${WHEN}\\) : « fetch failed » ; passager, alerte à partir de 30 échecs`,
      `   - INFO : tour de l'agent en échec 1 fois depuis le démarrage \\(dernière fois le ${WHEN}\\) : « Anthropic API error 529 overloaded » ; passager, alerte à partir de 5 échecs`,
      `   - INFO : tâche Sonni calendrier en échec 2 fois depuis le démarrage \\(dernière fois le ${WHEN}\\) : « FRED: timeout » ; passager, alerte à partir de 3 échecs`,
    ].join("\\n")));
    expect(lastLine(r.stdout)).toBe("RÉSULTAT : code=0 alertes=0");
    const short = control(live, ["--resume"]);
    expect(short.stdout).toContain("8. Santé : OK — 6 échecs passagers, aucune panne répétée");
    expect(lastLine(short.stdout)).toBe("RÉSULTAT : code=0 alertes=0");
  });

  it("an order rejection the pre-deployment check announced: an ALERTE that says how to accept it, INFO once the owner names it", () => {
    const live = healthy();
    // A sell left pending before the stop, on an asset Sonni no longer holds: the gate announces "refusé (rien à
    // vendre)" (À DÉCIDER), the owner accepts, and the first broker pass of the new version rejects it.
    live.db.raw.prepare(
      `INSERT INTO trader_orders (id, placed_at, asset, side, kind, quantity, thesis, horizon_until, origin, status)
       VALUES ('o_acc', ?, 'ETH', 'sell', 'market', 1, ?, ?, 'model', 'pending')`,
    ).run(isoSeconds(live.at(-20)), THESIS, isoSeconds(live.at(60 * 24)));
    expect(brokerTick(live.db.raw, TRADER, live.at(7)).rejected.map((o) => o.id)).toEqual(["o_acc"]);
    const r = control(live);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toMatch(new RegExp(`- ALERTE : ordre o_acc \\(vente ETH\\) refusé le ${WHEN} : aucune position à vendre\\. Si le contrôle avant déploiement avait annoncé ce refus et que tu l'avais accepté, ce n'est pas un défaut de la nouvelle version : relance le contrôle avec --ordres-acceptes o_acc\\n`));
    expect(r.stdout).toMatch(new RegExp(`- ALERTE : courtier virtuel le ${WHEN} : ordre o_acc \\(vente ETH\\) refusé par le courtier virtuel`));
    expect(lastLine(r.stdout)).toBe("RÉSULTAT : code=1 alertes=2");

    // Accepted: both lines become INFO. o_old (rejected before the start) and a typo match no rejection to accept.
    const accepted = control(live, ["--ordres-acceptes", "o_acc,o_old,o_faute"]);
    expect(accepted.status, accepted.stdout + accepted.stderr).toBe(0);
    expect(accepted.stdout).toContain("Refus acceptés (--ordres-acceptes) : o_acc, o_old, o_faute");
    expect(accepted.stdout).toMatch(new RegExp(`4\\. Incidents depuis le démarrage : OK\\n {3}- OK : aucun incident « courtier virtuel » ni « sauvegarde » en dehors des refus acceptés\\n {3}- INFO : courtier virtuel le ${WHEN} : ordre o_acc .*\\(refus accepté avec --ordres-acceptes\\)\\n`));
    expect(accepted.stdout).toMatch(new RegExp(`5\\. Ordres réglés depuis le démarrage : OK\\n {3}- OK : aucun refus imprévu depuis le démarrage\\n {3}- INFO : ordre o_acc \\(vente ETH\\) refusé le ${WHEN} : aucune position à vendre ; refus annoncé par le contrôle avant déploiement et accepté \\(--ordres-acceptes\\)\\n`));
    expect(accepted.stdout).toContain("- INFO : sans effet, --ordres-acceptes o_old,o_faute : aucun ordre de ce nom passé avant le démarrage et refusé depuis");
    expect(lastLine(accepted.stdout)).toBe("RÉSULTAT : code=0 alertes=0");
    const short = control(live, ["--resume", "--ordres-acceptes", "o_acc"]);
    expect(short.stdout).toContain("5. Ordres : OK — 1 refus accepté ; 0 exécuté(s), 0 expiré(s), 0 en attente");

    // A rejection of an order placed after the start was never announced: naming it changes nothing.
    live.db.raw.prepare(
      `INSERT INTO trader_orders (id, placed_at, asset, side, kind, quantity, thesis, horizon_until, origin, status)
       VALUES ('o_new', ?, 'ETH', 'sell', 'market', 1, ?, ?, 'model', 'pending')`,
    ).run(isoSeconds(live.at(7)), THESIS, isoSeconds(live.at(60 * 24)));
    storePrice(live.db, "ETH", live.at(8), 2_530);
    expect(brokerTick(live.db.raw, TRADER, live.at(8)).rejected.map((o) => o.id)).toEqual(["o_new"]);
    const late = control(live, ["--ordres-acceptes", "o_acc,o_new"]);
    expect(late.status).toBe(1);
    expect(late.stdout).toMatch(new RegExp(`- ALERTE : ordre o_new \\(vente ETH\\) refusé le ${WHEN} : aucune position à vendre\\n`));
    expect(late.stdout).toContain("- INFO : sans effet, --ordres-acceptes o_new");
    expect(lastLine(late.stdout)).toBe("RÉSULTAT : code=1 alertes=2");
  });

  it("refuses a database without -wal or -shm (Sonni stopped) and creates neither beside it", () => {
    const live = healthy();
    live.db.close();
    expect(fs.existsSync(`${live.file}-wal`)).toBe(false);
    const before = sha(live.file);
    const r = control(live);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Sonni ne semble pas tourner : la base n'a pas de journal WAL ; ce contrôle se lance pendant qu'il tourne");
    expect(lastLine(r.stdout)).toBe("RÉSULTAT : code=2 alertes=0");
    expect(fs.existsSync(`${live.file}-wal`)).toBe(false);
    expect(fs.existsSync(`${live.file}-shm`)).toBe(false);
    expect(sha(live.file)).toBe(before);
    // A -wal left by an unclean stop but no -shm: still refused, and SQLite is not given the chance to create one.
    fs.writeFileSync(`${live.file}-wal`, "");
    const r2 = control(live);
    expect(r2.status).toBe(2);
    expect(r2.stderr).toContain("Sonni ne semble pas tourner : la base a un journal WAL mais pas de fichier -shm");
    expect(fs.existsSync(`${live.file}-shm`)).toBe(false);
    expect(sha(live.file)).toBe(before);
  });

  it("refuses to run too early after the start, or with a start date in the future, before opening anything", () => {
    const live = healthy();
    live.since = new Date(Math.floor((Date.now() - 60_000) / 1000) * 1000);
    const early = control(live);
    expect(early.status).toBe(2);
    expect(early.stderr).toMatch(/^Trop tôt : relance dans [5-7] min \(Sonni a démarré il y a 1 min/);
    live.since = new Date(Date.now() + 3_600_000);
    const future = control(live);
    expect(future.status).toBe(2);
    expect(future.stderr).toContain("est dans le futur d'après l'horloge du serveur");
    // collectMinutes from the configuration: 1 min of collection, so 3 min are enough.
    live.since = new Date(Math.floor((Date.now() - 4 * 60_000) / 1000) * 1000);
    expect(control(live).status).toBe(2);
    writeConfig(live.h, { ...CONFIG, trader: { ...CONFIG.trader, collectMinutes: 1 } });
    const d = depot();
    const r = spawnSync(process.execPath, [CONTROLE, "--depuis", live.since.toISOString(), "--depot", d.dir], { encoding: "utf-8", env: checkEnv(live.h, d.PATH) });
    expect(r.stdout).toContain("Configuration : " + path.join(live.h, ".automaton", "automaton.json") + " (relevé des prix toutes les 1 min)");
    expect(r.stdout).toContain("Commit attendu : non donné");
    expect(r.stdout).toContain(`- INFO : commit en place : ${COMMIT} (aucun commit attendu donné avec --commit-attendu)`);
  });

  it("refuses usage errors with exit 2: no --depuis, a local time, an unknown option, a bad commit, an unreadable --config", () => {
    const live = healthy();
    const d = depot();
    const run = (args: string[]) => spawnSync(process.execPath, [CONTROLE, ...args], { encoding: "utf-8", env: checkEnv(live.h, d.PATH) });
    for (const args of [
      [],
      ["--depuis", "2026-10-10 14:30:05"],
      ["--depuis", live.since.toISOString(), "--jeton", "x"],
      ["--depuis", live.since.toISOString(), "--commit-attendu", "abc"],
      ["--depuis", live.since.toISOString(), "--config", path.join(live.h, "absent.json")],
      ["--depuis", live.since.toISOString(), "--ordres-acceptes", "o_a;rm"],
    ]) {
      const r = run(args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(lastLine(r.stdout)).toBe("RÉSULTAT : code=2 alertes=0");
    }
    expect(run([]).stderr).toContain("--depuis est obligatoire");
  });

  it("without a configuration, checks the assets priced in the 24 hours before the start, and says so", () => {
    const live = healthy();
    storePrice(live.db, "SOL", live.at(-60), 150);
    const d = depot();
    const r = spawnSync(process.execPath, [CONTROLE, "--depuis", live.since.toISOString(), "--commit-attendu", COMMIT, "--depot", d.dir],
      { encoding: "utf-8", env: checkEnv(live.h, d.PATH) });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toContain("Configuration : valeurs par défaut");
    expect(r.stdout).toMatch(/INFO : configuration .*automaton\.json illisible \(fichier introuvable\) : relevé des prix supposé toutes les 5 min/);
    expect(r.stdout).toMatch(/ALERTE : aucun prix de SOL depuis le démarrage/);
    expect(r.stdout).toMatch(/OK : BTC : 2 prix depuis le démarrage/);
    expect(lastLine(r.stdout)).toBe("RÉSULTAT : code=1 alertes=1");
  });

  it("relies on the compiled program when git is missing, and says so", () => {
    const live = healthy();
    const d = depot();
    const r = control(live, [], { dir: d.dir, PATH: tmp("sonni-poststart-nogit-") });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("- INFO : git est introuvable sur ce serveur : la version est contrôlée par le programme compilé seulement (commit attendu 0123456 non vérifié)");
    expect(r.stdout).toContain("- OK : programme compilé : la nouvelle version (étape 0.3) est dans dist/");
  });

  it("refuses a file that is not Sonni's memory (exit 3)", () => {
    const h = home();
    const file = path.join(h, ".automaton", "state.db");
    fs.writeFileSync(file, "pas une base");
    fs.writeFileSync(`${file}-wal`, "");
    fs.writeFileSync(`${file}-shm`, "");
    const d = depot();
    const since = new Date(Date.now() - 10 * 60_000).toISOString();
    const r1 = spawnSync(process.execPath, [CONTROLE, "--depuis", since, "--depot", d.dir], { encoding: "utf-8", env: checkEnv(h, d.PATH) });
    expect(r1.status).toBe(3);
    expect(r1.stderr).toContain("Contrôle impossible : ce fichier n'est pas une base SQLite");
    const other = path.join(h, "autre.db");
    const db = createDatabase(other);
    openDbs.push(db);
    const r2 = spawnSync(process.execPath, [CONTROLE, "--depuis", since, "--base", other, "--depot", d.dir], { encoding: "utf-8", env: checkEnv(h, d.PATH) });
    expect(r2.status).toBe(3);
    expect(r2.stderr).toContain("Cette base ne contient pas la mémoire de Sonni");
  });

  it("a damaged live database: exit 1 with one alert, and the message says the remedy is restoring the copy (R1), not rolling back the code", () => {
    const h = home();
    const file = path.join(h, ".automaton", "state.db");
    const db = createDatabase(file);
    ensureMoneyLabSchema(db.raw);
    ensureTraderSchema(db.raw);
    for (let i = 0; i < 50; i++) storePrice(db, "BTC", new Date(Date.now() - (60 - i) * 60_000), 60_000 + i);
    // The pages of trader_prices (table and indexes) overwritten: SQLite opens the file, then finds them corrupt.
    const pages = (db.raw.prepare("SELECT rootpage FROM sqlite_master WHERE tbl_name = 'trader_prices' AND rootpage > 1").all() as { rootpage: number }[]).map((r) => r.rootpage);
    const pageSize = db.raw.pragma("page_size", { simple: true }) as number;
    db.close();
    expect(pages.length).toBeGreaterThan(0);
    const fd = fs.openSync(file, "r+");
    for (const page of pages) fs.writeSync(fd, Buffer.alloc(pageSize, 0xff), 0, pageSize, (page - 1) * pageSize);
    fs.closeSync(fd);
    // As while Sonni runs: the -wal and -shm files beside it.
    fs.writeFileSync(`${file}-wal`, "");
    fs.writeFileSync(`${file}-shm`, "");
    const d = depot();
    const since = new Date(Date.now() - 10 * 60_000).toISOString();
    for (const resume of [false, true]) {
      const r = spawnSync(process.execPath, [CONTROLE, "--depuis", since, "--depot", d.dir, ...(resume ? ["--resume"] : [])], { encoding: "utf-8", env: checkEnv(h, d.PATH) });
      expect(r.status, r.stdout + r.stderr).toBe(1);
      const message = "Contrôle impossible : base abîmée (SQLite la dit corrompue) (SQLITE_CORRUPT";
      const remedy = "Le retour arrière du code ne répare pas la base : la remettre en état, c'est restaurer la copie d'avant le déploiement " +
        "(guide, « Retour arrière », étape R1 : restauration.mjs --restaurer COPIE --confirmer), sur ta décision.";
      expect(r.stderr).toContain(message);
      expect(r.stderr).toContain(remedy);
      expect(r.stdout).toContain(resume ? `Sonni — contrôle après démarrage impossible : ${message}` : `ALERTE : ${message}`);
      expect(r.stdout).toContain(remedy);
      expect(lastLine(r.stdout)).toBe("RÉSULTAT : code=1 alertes=1");
    }
  });

  it("never shows the runtime's English: unknown rejection notes and unexpected errors are named in French", async () => {
    const mod = await import(pathToFileURL(CONTROLE).href);
    expect(mod.rejectionFr("rejected by code (nothing): there is no position to sell")).toBe("aucune position à vendre");
    expect(mod.rejectionFr("rejected by code (price): the fill price is not a positive number [fill_price=0]")).toBe("prix d'exécution nul, négatif ou non fini (prix d'exécution = 0)");
    expect(mod.rejectionFr("insufficient cash for this order")).toBe("motif non reconnu (voir /portefeuille)");
    expect(mod.rejectionFr(null)).toBe("sans motif noté");
    expect(mod.technicalFr(new TypeError("Cannot read properties of undefined (reading 'price')"))).toBe("erreur technique inattendue (TypeError)");
    expect(mod.technicalFr(Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR_READ" }))).toBe("erreur de lecture sur le disque (SQLITE_IOERR_READ)");
    expect(mod.when("2026-10-10T04:24:03.563Z")).toBe("10/10/2026 04:24 UTC");
    expect(mod.when("pas une date")).toBe("pas une date");
  });

  it("--resume: a short French report for Telegram, at most 3,500 characters even with many long alerts", () => {
    const live = healthy();
    const ok = control(live, ["--resume"]);
    expect(ok.status).toBe(0);
    const lines = ok.stdout.trimEnd().split("\n");
    expect(lines[0]).toBe("Sonni — contrôle après démarrage : aucune alerte");
    expect(lines[1]).toBe(`Commit : ${COMMIT.slice(0, 12)} (attendu 0123456)`);
    expect(lines[2]).toMatch(new RegExp(`^Démarrage : ${WHEN} \\(il y a 10 min\\)$`));
    expect(lines.slice(3, 12).map((l) => l.replace(/ : .*/, ""))).toEqual([
      "1. Version", "2. Prix", "3. Appels payés", "4. Incidents", "5. Ordres", "6. Portefeuille", "7. Telegram", "8. Santé", "9. Instantané du jour",
    ]);
    expect(lines[4]).toBe("2. Prix : OK — 2 actif(s) sur 2 avec des prix depuis le démarrage");
    expect(lines[5]).toBe("3. Appels payés : INFO — 1 appel, 0,35 $");
    expect(lines[8]).toBe("6. Portefeuille : OK — 1 position ouverte, évaluable");
    expect(lines.at(-1)).toBe("RÉSULTAT : code=0 alertes=0");
    expect(lines).toHaveLength(13);

    const long = "x".repeat(400);
    for (let i = 0; i < 40; i++) recordIncident(live.db.raw, "broker", `ordre o_${i} refusé ${long}`, live.at(3));
    // Thirty background tasks that each failed three times: 30 alerts (one line per task).
    for (let k = 0; k < 3; k++) for (let i = 0; i < 30; i++) recordHealthEvent(live.db.raw, `tâche_${i}`, `échec ${long}`, live.at(4));
    live.db.raw.prepare("INSERT INTO trader_positions (asset, quantity, avg_cost, opened_at, open_order_id, invalidation, horizon_until, thesis, updated_at) VALUES ('PUMP', 9e999, 0, ?, 'o_pump', NULL, NULL, ?, ?)")
      .run(isoSeconds(live.at(-300)), THESIS, isoSeconds(live.at(-300)));
    const bad = control(live, ["--resume"], depot({ commit: OTHER_COMMIT, incidents: null }));
    expect(bad.status).toBe(1);
    expect(bad.stdout.length).toBeLessThanOrEqual(3500);
    const b = bad.stdout.trimEnd().split("\n");
    expect(b[0]).toBe("Sonni — contrôle après démarrage : 73 alertes, retour arrière à décider");
    expect(b[1]).toBe(`Commit : ${OTHER_COMMIT.slice(0, 12)} (attendu 0123456)`);
    expect(b[3]).toMatch(/^1\. Version : ALERTE — le commit en place \(fedcba9876543210fedcba9876543210fedcba98\) n'est pas celui attendu \(0123456\) \(\+1 autre alerte\)$/);
    expect(b[6]).toMatch(/^4\. Incidents : ALERTE — courtier virtuel le .*…$/);
    expect(b[8]).toMatch(/^6\. Portefeuille : ALERTE — valeur du portefeuille non fiable : position PUMP invalide/);
    expect(b[10]).toMatch(/^8\. Santé : ALERTE — tâche tâche_0 en échec 3 fois depuis le démarrage /);
    expect(bad.stdout).not.toMatch(RAW_ISO);
    expect(b.at(-1)).toBe("RÉSULTAT : code=1 alertes=73");
    // The full report keeps every alert line within 12 per check and counts the rest.
    const full = control(live, [], depot({ commit: OTHER_COMMIT, incidents: null }));
    expect(full.stdout).toContain("   - … et 28 autre(s), dont 28 alertes");
    expect(full.stdout).toContain("   - … et 18 autre(s), dont 18 alertes");
  });

  it("--resume says why there is no check when it is refused", () => {
    const live = healthy();
    live.since = new Date(Math.floor((Date.now() - 60_000) / 1000) * 1000);
    const r = control(live, ["--resume"]);
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/^Sonni — contrôle après démarrage impossible : Trop tôt : relance dans \d+ min/);
    expect(lastLine(r.stdout)).toBe("RÉSULTAT : code=2 alertes=0");
    const d = depot();
    const usage = spawnSync(process.execPath, [CONTROLE, "--resume", "--depuis", "hier"], { encoding: "utf-8", env: checkEnv(live.h, d.PATH) });
    expect(usage.status).toBe(2);
    expect(usage.stdout).toMatch(/^Sonni — contrôle après démarrage impossible : --depuis attend la date du démarrage en UTC/);
  });
});

// ─── Telegram ────────────────────────────────────────────────────────────

interface FakeTelegram { url: string; requests: { method?: string; url?: string; body: any }[] }
/** A local Telegram Bot API: records each request and answers with `reply`. */
async function fakeTelegram(reply: () => { status: number; body: unknown } = () => ({ status: 200, body: { ok: true, result: { message_id: 1 } } })): Promise<FakeTelegram> {
  const requests: FakeTelegram["requests"] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, body: JSON.parse(body || "null") });
      const r = reply();
      res.writeHead(r.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(r.body));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

/** A port nothing listens on (a server opened then closed). */
async function closedPort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const port = (s.address() as AddressInfo).port;
  await new Promise((resolve) => s.close(resolve));
  return port;
}

/** /etc/sonni.env and Sonni's configuration as root reads them; the chat ends in 242. */
function secrets(opts: { envText?: string; config?: unknown } = {}): { envFile: string; config: string } {
  const dir = tmp("sonni-telegram-");
  const envFile = path.join(dir, "sonni.env");
  fs.writeFileSync(envFile, opts.envText ?? `# Secrets de Sonni\nANTHROPIC_API_KEY=sk-ant-REPLACE_ME\nTELEGRAM_BOT_TOKEN=${TOKEN}\n`, { mode: 0o600 });
  const config = path.join(dir, "automaton.json");
  fs.writeFileSync(config, JSON.stringify(opts.config ?? { ...CONFIG, moneyLab: { ...CONFIG.moneyLab, telegram: { botTokenEnv: "TELEGRAM_BOT_TOKEN", ownerChatId: 987654242 } } }));
  return { envFile, config };
}

function send(input: string, s: { envFile: string; config: string }, api: string | undefined, extra: string[] = []): Promise<Run> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: tmp("sonni-telegram-home-"), TELEGRAM_BOT_TOKEN: "" };
  delete env.SONNI_TELEGRAM_API;
  if (api !== undefined) env.SONNI_TELEGRAM_API = api;
  return runAsync(ENVOI, ["--env", s.envFile, "--config", s.config, ...extra], env, input);
}
const noToken = (r: Run) => {
  expect(r.stdout + r.stderr).not.toContain(TOKEN);
  expect(r.stdout + r.stderr).not.toContain(SECRET_PART);
};

describe("Telegram report to the owner (sonni/vps/envoi-telegram.mjs)", () => {
  const REPORT = "Sonni — contrôle après démarrage : aucune alerte\n1. Version : OK — commit 0123456789ab\nRÉSULTAT : code=0 alertes=0\n";

  it("sends the piped report to the owner's chat, and never prints the token or the URL", async () => {
    const tg = await fakeTelegram();
    const r = await send(REPORT, secrets(), tg.url);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(tg.requests).toHaveLength(1);
    expect(tg.requests[0].method).toBe("POST");
    expect(tg.requests[0].url).toBe(`/bot${TOKEN}/sendMessage`);
    expect(tg.requests[0].body).toEqual({ chat_id: 987654242, text: REPORT.trimEnd() });
    expect(r.stdout).toContain(REPORT.trimEnd());
    expect(r.stdout).toContain("Rapport envoyé sur Telegram. (chat …242)");
    expect(lastLine(r.stdout)).toBe(`RÉSULTAT : code=0 envoi=fait caractères=${REPORT.trimEnd().length}`);
    expect(r.stdout + r.stderr).not.toContain("/bot");
    noToken(r);
  });

  it("--essai checks everything and sends nothing", async () => {
    const tg = await fakeTelegram();
    const r = await send(REPORT, secrets(), tg.url, ["--essai"]);
    expect(r.status, r.stderr).toBe(0);
    expect(tg.requests).toHaveLength(0);
    expect(r.stdout).toContain(REPORT.trimEnd());
    expect(r.stdout).toContain("Essai : envoi simulé au chat …242 (jeton TELEGRAM_BOT_TOKEN présent, non affiché). Rien n'a été envoyé.");
    expect(lastLine(r.stdout)).toMatch(/^RÉSULTAT : code=0 envoi=simulé caractères=\d+$/);
    noToken(r);
    // Without a test server: still nothing sent, nothing reached.
    expect((await send(REPORT, secrets(), undefined, ["--essai"])).status).toBe(0);
  });

  it("accepts SONNI_TELEGRAM_API only as http://127.0.0.1:<port>", async () => {
    const tg = await fakeTelegram();
    for (const api of ["https://api.telegram.org", "http://localhost:8080", "http://127.0.0.1:80@exemple.org", "http://127.0.0.1:8080/ailleurs", "http://127.0.0.10:8080", "ftp://127.0.0.1:21"]) {
      const r = await send(REPORT, secrets(), api);
      expect(r.status, api).toBe(2);
      expect(r.stderr).toContain("SONNI_TELEGRAM_API ne sert qu'aux tests et doit valoir http://127.0.0.1:<port>");
      expect(lastLine(r.stdout)).toMatch(/^RÉSULTAT : code=2 envoi=aucun/);
      noToken(r);
    }
    expect(tg.requests).toHaveLength(0);
  });

  it("exits 1 with Telegram's status and description when Telegram refuses, without echoing the token", async () => {
    const refused = await fakeTelegram(() => ({ status: 400, body: { ok: false, error_code: 400, description: "Bad Request: chat not found" } }));
    const r = await send(REPORT, secrets(), refused.url);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Telegram a refusé le rapport : HTTP 400 — Bad Request: chat not found.");
    expect(lastLine(r.stdout)).toMatch(/^RÉSULTAT : code=1 envoi=aucun/);
    noToken(r);
    const echo = await fakeTelegram(() => ({ status: 200, body: { ok: false, description: `token ${TOKEN} is not allowed` } }));
    const r2 = await send(REPORT, secrets(), echo.url);
    expect(r2.status).toBe(1);
    expect(r2.stderr).toContain("HTTP 200 — token [jeton masqué] is not allowed");
    noToken(r2);
  });

  it("never sends, and never shows, a message holding the token or anything shaped like a key", async () => {
    const tg = await fakeTelegram();
    for (const leaked of [`${REPORT}TELEGRAM_BOT_TOKEN=${TOKEN}\n`, `${REPORT}ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijkl\n`, `${REPORT}autre 555666777:${"Z".repeat(35)}\n`]) {
      const r = await send(leaked, secrets(), tg.url);
      expect(r.status).toBe(2);
      expect(r.stdout).toContain("[jeton masqué]");
      expect(r.stderr).toContain("Le message contient ce qui ressemble à un jeton ou une clé (masqué ci-dessus) : il n'est pas envoyé.");
      expect(r.stdout + r.stderr).not.toMatch(/sk-ant-api03|Z{35}/);
      noToken(r);
    }
    expect(tg.requests).toHaveLength(0);
  });

  it("exits 3 when Telegram cannot be reached", async () => {
    const r = await send(REPORT, secrets(), `http://127.0.0.1:${await closedPort()}`);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("Telegram injoignable (ECONNREFUSED). Le rapport n'est pas parti.");
    noToken(r);
  });

  it("gives up when Telegram does not answer within the timeout (code 3), never showing the token", async () => {
    const mod = await import(pathToFileURL(ENVOI).href);
    expect(mod.TIMEOUT_MS).toBe(20_000);
    const silent = http.createServer(() => { /* never answers */ });
    servers.push(silent);
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(silent.address() as AddressInfo).port}`;
    const started = Date.now();
    const result = await mod.sendMessage({ base, token: TOKEN, chatId: 987654242, text: REPORT, timeoutMs: 1000 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result).toEqual({ code: 3, message: "Telegram injoignable : pas de réponse en 1 s. Le rapport n'est pas parti." });
  });

  it("an interruption while sending exits 130 and says the report may or may not have left", async () => {
    let arrived = () => {};
    const request = new Promise<void>((resolve) => { arrived = resolve; });
    const silent = http.createServer(() => arrived());
    servers.push(silent);
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const s = secrets();
    const env: NodeJS.ProcessEnv = {
      ...process.env, HOME: tmp("sonni-telegram-home-"), TELEGRAM_BOT_TOKEN: "",
      SONNI_TELEGRAM_API: `http://127.0.0.1:${(silent.address() as AddressInfo).port}`,
    };
    const child = spawn(process.execPath, [ENVOI, "--env", s.envFile, "--config", s.config], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const closed = new Promise<number | null>((resolve) => child.on("close", resolve));
    child.stdin.end(REPORT);
    // The request reached Telegram (the fake one): the script is waiting for its answer.
    await request;
    child.kill("SIGTERM");
    expect(await closed).toBe(130);
    expect(stdout).toContain("Interrompu pendant l'envoi : le rapport a pu partir ou non.");
    expect(lastLine(stdout)).toBe("RÉSULTAT : code=130 envoi=inconnu caractères=0");
    noToken({ status: 130, stdout, stderr });
  });

  it("refuses an empty message (exit 2) and sends nothing", async () => {
    const tg = await fakeTelegram();
    for (const input of ["", "  \n\n"]) {
      const r = await send(input, secrets(), tg.url);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("Aucun message reçu sur l'entrée standard.");
      expect(lastLine(r.stdout)).toBe("RÉSULTAT : code=2 envoi=aucun caractères=0");
    }
    expect(tg.requests).toHaveLength(0);
  });

  it("cuts a long report under 4,000 characters for Telegram and keeps it whole in the terminal", async () => {
    const tg = await fakeTelegram();
    const long = Array.from({ length: 120 }, (_, i) => `${i + 1}. ligne du rapport avec des accents é è à ç — ${"€".repeat(20)}`).join("\n");
    expect(long.length).toBeGreaterThan(5000);
    const r = await send(long, secrets(), tg.url);
    expect(r.status, r.stderr).toBe(0);
    const text: string = tg.requests[0].body.text;
    expect(text.length).toBeLessThan(4000);
    expect(text.startsWith(long.slice(0, 3950))).toBe(true);
    expect(text.endsWith("\n… (rapport coupé, la suite dans le terminal)")).toBe(true);
    expect(r.stdout).toContain(long);
    expect(r.stdout).toContain("Rapport coupé à 3950 caractères pour Telegram : le texte complet est ci-dessus.");
    expect(lastLine(r.stdout)).toBe(`RÉSULTAT : code=0 envoi=fait caractères=${text.length}`);
    // A character outside the basic plane is never split in two.
    const mod = await import(pathToFileURL(ENVOI).href);
    const cut = mod.fitMessage("a".repeat(3949) + "😀".repeat(100)).text;
    expect(cut.startsWith("a".repeat(3949) + "\n…")).toBe(true);
  });

  it("reads the token from the env file under the variable the configuration names (quotes, comments), never from the shell", async () => {
    const mod = await import(pathToFileURL(ENVOI).href);
    expect(mod.parseEnvFile([
      "# commentaire",
      "; commentaire systemd",
      "",
      "A=simple",
      'B="entre guillemets # pas un commentaire"',
      "C='simples guillemets'",
      "D=valeur # commentaire",
      "export E=exporté",
      'F="échappé \\" fin"',
      "G=",
      "  H = espaces  ",
      "pas une ligne",
    ].join("\n"))).toEqual({
      A: "simple", B: "entre guillemets # pas un commentaire", C: "simples guillemets", D: "valeur", E: "exporté", F: 'échappé " fin', G: "", H: "espaces",
    });

    const tg = await fakeTelegram();
    const other = "987654321:BBH_autre-JETON-secret9876543210fedcba";
    const s = secrets({
      envText: `# Sonni\nTELEGRAM_BOT_TOKEN=${other}\nSONNI_BOT="${TOKEN}"   # le bot de Sonni\n`,
      config: { moneyLab: { telegram: { botTokenEnv: "SONNI_BOT", ownerChatId: -100123 } } },
    });
    const r = await send(REPORT, s, tg.url);
    expect(r.status, r.stderr).toBe(0);
    expect(tg.requests[0].url).toBe(`/bot${TOKEN}/sendMessage`);
    expect(tg.requests[0].body.chat_id).toBe(-100123);
    expect(r.stdout).toContain("(chat …123)");
    noToken(r);
    expect(r.stdout + r.stderr).not.toContain(other);

    // The shell's environment is never used: a token only there is "absent".
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: tmp("sonni-telegram-home-"), SONNI_TELEGRAM_API: tg.url, TELEGRAM_BOT_TOKEN: TOKEN };
    const onlyShell = secrets({ envText: "ANTHROPIC_API_KEY=sk-ant-REPLACE_ME\n" });
    const r2 = await runAsync(ENVOI, ["--env", onlyShell.envFile, "--config", onlyShell.config], env, REPORT);
    expect(r2.status).toBe(2);
    expect(r2.stderr).toContain(`TELEGRAM_BOT_TOKEN est absent ou vide dans ${onlyShell.envFile}. Rien n'a été envoyé.`);
    expect(tg.requests).toHaveLength(1);
  });

  it("refuses (exit 2, nothing sent) a missing configuration, chat or env file, a malformed token and any token option", async () => {
    const tg = await fakeTelegram();
    const cases: { s: { envFile: string; config: string }; extra?: string[]; expected: string }[] = [
      { s: { ...secrets(), config: path.join(tmp("sonni-telegram-"), "absent.json") }, expected: "Configuration illisible" },
      { s: secrets({ config: { moneyLab: { telegram: { botTokenEnv: "TELEGRAM_BOT_TOKEN" } } } }), expected: "moneyLab.telegram.ownerChatId manque ou n'est pas un entier" },
      { s: secrets({ config: { moneyLab: {} } }), expected: "Pas de bloc moneyLab.telegram" },
      { s: secrets({ config: { moneyLab: { telegram: { botTokenEnv: "mauvais-nom", ownerChatId: 1 } } } }), expected: "n'est pas un nom de variable" },
      { s: { ...secrets(), envFile: path.join(tmp("sonni-telegram-"), "absent.env") }, expected: "Fichier d'environnement illisible" },
      { s: secrets({ envText: `TELEGRAM_BOT_TOKEN=${TOKEN}/../../autre\n` }), expected: "n'a pas la forme d'un jeton de bot Telegram" },
      { s: secrets(), extra: ["--jeton", TOKEN], expected: "Option inconnue : --jeton" },
    ];
    for (const c of cases) {
      const r = await send(REPORT, c.s, tg.url, c.extra);
      expect(r.status, c.expected).toBe(2);
      expect(r.stderr).toContain(c.expected);
      noToken(r);
    }
    expect(tg.requests).toHaveLength(0);
  });

  it("carries the post-start check's --resume output to the owner's chat (the guide's pipe)", async () => {
    const live = healthy();
    const check = control(live, ["--resume"]);
    expect(check.status).toBe(0);
    const tg = await fakeTelegram();
    const r = await send(check.stdout, secrets(), tg.url);
    expect(r.status, r.stderr).toBe(0);
    const text: string = tg.requests[0].body.text;
    expect(text.startsWith("Sonni — contrôle après démarrage : aucune alerte\n")).toBe(true);
    expect(text.endsWith("RÉSULTAT : code=0 alertes=0")).toBe(true);
    expect(text.length).toBeLessThanOrEqual(3500);
  });
});
