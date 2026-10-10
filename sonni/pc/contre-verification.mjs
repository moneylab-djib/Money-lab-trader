#!/usr/bin/env node
/**
 * Counter-verification of the deployment tools on FICTITIOUS databases (2026-10-10). The owner's Windows agent
 * runs it on the PC (mission in the agent-reports branch) to check, outside the laboratory where the tools were
 * written, that the backup, restore, audit, gate and pause tools of sonni/vps give the expected exit codes and
 * messages. It never reads production data: every database is built here, by Sonni's own compiled code
 * (dist/: schema, paper broker), in a new temporary folder that holds the fake HOME, TEMP and the copies.
 * No network, no inference, no Telegram, no systemctl (a fake one on Linux and macOS; Windows uses
 * --sans-systemd). C:\Sonni, ~/.automaton and the VPS are never touched: HOME, USERPROFILE, TEMP, TMP and TMPDIR
 * of every tool point into the temporary folder, and every path the script passes is checked to be inside it.
 *
 * Each case runs one tool in a child process, as the owner runs it, and compares its exit code and the
 * substrings it must print. It also checks that a copy given to a read-only tool is byte for byte unchanged and
 * that the tool left nothing in its temporary folder. A case that only makes sense on Linux (file modes, the
 * systemctl check) is reported "non applicable" elsewhere.
 *
 * Output: a Markdown report (French, no secret, no production data; the temporary paths are shown as <tmp>),
 * written to --rapport (default contre-verification-<horodatage>.md in the current folder), and a summary on
 * stdout ending with `RÉSULTAT : code=<n> cas=<n> ok=<n> ecarts=<n> non_applicables=<n>`.
 * Exit codes: 0 every case as expected; 1 at least one ÉCART; 2 usage error; 3 technical error (dist missing:
 * run `pnpm install --frozen-lockfile` then `pnpm run build` first).
 *
 * Usage: node sonni/pc/contre-verification.mjs [--dist <dossier dist>] [--rapport <fichier.md>] [--garder]
 *   --garder keeps the temporary folder (fictitious data only) to look at it; it is removed by default.
 */

import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, "..", "..");
const VPS = path.join(REPO, "sonni", "vps");
const USAGE = "Usage : node sonni/pc/contre-verification.mjs [--dist <dossier dist>] [--rapport <fichier.md>] [--garder]";
const ASSETS = [{ symbol: "BTC", krakenPair: "XBTEUR" }, { symbol: "USDC", krakenPair: "USDCEUR" }, { symbol: "PUMP", krakenPair: "PUMPEUR" }];
const THESIS = "Contre-vérification : position fictive pour donner au courtier virtuel un état réaliste.";
const IS_WINDOWS = process.platform === "win32";

/** Loads the functions that build the fictitious databases from Sonni's compiled code (dist/). */
export async function loadDistApi(dist) {
  const load = (rel) => import(pathToFileURL(path.join(dist, rel)).href);
  for (const rel of ["state/database.js", "money-lab/journal.js", "trader/config.js", "trader/schema.js", "trader/prices.js", "trader/portfolio.js"]) {
    if (!fs.existsSync(path.join(dist, rel))) {
      const err = new Error(`${path.join(dist, rel)} introuvable : lance d'abord pnpm install --frozen-lockfile puis pnpm run build.`);
      err.exitCode = 3;
      throw err;
    }
  }
  const [database, journal, config, schema, prices, portfolio] = await Promise.all([
    load("state/database.js"), load("money-lab/journal.js"), load("trader/config.js"), load("trader/schema.js"), load("trader/prices.js"), load("trader/portfolio.js"),
  ]);
  return {
    createDatabase: database.createDatabase, ensureMoneyLabSchema: journal.ensureMoneyLabSchema, pause: journal.pause,
    parseTraderConfig: config.parseTraderConfig, ensureTraderSchema: schema.ensureTraderSchema, isoSeconds: prices.isoSeconds,
    brokerTick: portfolio.brokerTick, placeOrder: portfolio.placeOrder,
  };
}

const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** Builds the fictitious databases. `now` anchors every time so prices are fresh for the gate. */
export function fixtureBuilder(api, now = Date.now()) {
  const example = JSON.parse(fs.readFileSync(path.join(REPO, "sonni", "automaton.sonni.example.json"), "utf-8"));
  const trader = api.parseTraderConfig({ ...example.trader, assets: ASSETS });
  const at = (minutesAgo) => new Date(now - minutesAgo * 60_000);
  const open = (file) => {
    const db = api.createDatabase(file);
    api.ensureMoneyLabSchema(db.raw);
    api.ensureTraderSchema(db.raw);
    return db;
  };
  const price = (db, asset, d, p) => db.raw.prepare("INSERT INTO trader_prices (asset, ts, price, source) VALUES (?, ?, ?, 'contre-verification')").run(asset, api.isoSeconds(d), p);
  const order = (db, minutesAgo, asset, p, o) => {
    price(db, asset, at(minutesAgo), p);
    const placed = api.placeOrder(db.raw, trader, { asset, thesis: THESIS, ...o }, at(minutesAgo));
    if (!placed.ok) throw new Error(`ordre fictif refusé : ${placed.error}`);
    return placed.value.id;
  };
  const fill = (db, minutesAgo, asset, p) => {
    price(db, asset, at(minutesAgo), p);
    return api.brokerTick(db.raw, trader, at(minutesAgo));
  };
  /**
   * The clean base: capital, a BTC position with its stop at 42,000 EUR, a USDC position under 1 EUR, prices
   * 3 minutes old, asleep for two hours. Options: paused, a pending BTC limit buy, a crossed BTC stop, a corrupt
   * PUMP position (pre-0.3: infinite quantity, zero average cost).
   */
  function build(file, { paused = true, pendingBuy = false, crossedStop = false, corrupt = false, keepOpen = false } = {}) {
    const db = open(file);
    fill(db, 180, "BTC", 60_000);
    order(db, 120, "BTC", 60_000, { side: "buy", amountEur: 100, invalidation: 42_000 });
    fill(db, 119, "BTC", 60_100);
    order(db, 90, "USDC", 0.87, { side: "buy", amountEur: 50, invalidation: 0.8 });
    fill(db, 89, "USDC", 0.87);
    if (pendingBuy) order(db, 30, "BTC", 60_150, { side: "buy", kind: "limit", limitPrice: 50_000, amountEur: 40, invalidation: 40_000 });
    price(db, "BTC", at(3), crossedStop ? 41_000 : 60_200);
    price(db, "USDC", at(3), 0.871);
    if (corrupt) {
      const t = api.isoSeconds(at(60));
      db.raw.prepare("INSERT INTO trader_ledger (id, at, kind, asset, quantity, price, amount_eur, fee_eur, order_id, note) VALUES ('l_pump', ?, 'buy', 'PUMP', 9e999, 0, -50, 0.4, 'o_pump', NULL)").run(t);
      db.raw.prepare("INSERT INTO trader_positions (asset, quantity, avg_cost, opened_at, open_order_id, invalidation, horizon_until, thesis, updated_at) VALUES ('PUMP', 9e999, 0, ?, 'o_pump', NULL, NULL, ?, ?)").run(t, THESIS, t);
    }
    db.setAgentState("sleeping");
    db.setKV("sleep_until", new Date(now + 2 * 3_600_000).toISOString());
    // The pause as `--money-lab pause` records it, dated before the simulated start of the old version.
    if (paused) db.setKV("money_lab.paused", JSON.stringify({ at: at(150).toISOString(), reason: "contre-vérification", by: "operator" }));
    if (keepOpen) return db;
    db.close();
    return null;
  }
  return { build };
}

/** A fake systemctl printing `state` (Linux and macOS only: Windows refuses to spawn a script without a shell). */
function fakeSystemctl(dir, state) {
  const bin = path.join(dir, `systemctl-${state}`);
  fs.writeFileSync(bin, `#!/bin/sh\necho ${state}\n[ "${state}" = active ] && exit 0 || exit 3\n`, { mode: 0o755 });
  return bin;
}

/** Runs every case; returns { results, code }. Never throws for a failed case. */
export async function runCounterCheck({ api, keep = false, log = () => {} }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sonni-contre-verif-")));
  const inside = (p) => path.resolve(p).startsWith(root + path.sep);
  const dir = (name) => {
    const d = path.join(root, name);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  const results = [];
  const openDbs = [];
  const fx = fixtureBuilder(api);

  /** A fake HOME with ~/.automaton; `base` builds its state.db (or a function writes it). */
  const home = (name, base) => {
    const h = dir(name);
    fs.mkdirSync(path.join(h, ".automaton"), { recursive: true });
    const file = path.join(h, ".automaton", "state.db");
    if (typeof base === "function") base(file);
    else if (base) {
      const db = fx.build(file, base);
      if (db) openDbs.push(db);
    }
    return { h, file };
  };
  const copyOf = (name, options) => {
    const file = path.join(dir("copies"), `${name}.db`);
    fx.build(file, options);
    return file;
  };

  function run(c) {
    const { name, script, args, homeDir, expect, contains = [], unchanged = [], linuxOnly = false, extraEnv = {}, resultLine = true } = c;
    if (linuxOnly && IS_WINDOWS) {
      results.push({ name, script, args, expect, status: "NON APPLICABLE", note: "comportement propre à Linux (droits de fichiers ou systemctl)" });
      return null;
    }
    for (const a of args) if ((path.isAbsolute(a) || a.includes(path.sep)) && !inside(a) && a !== REPO) throw new Error(`chemin hors du dossier temporaire refusé : ${a}`);
    const tmpDir = dir(`tmp-${results.length + 1}`);
    const before = unchanged.map((f) => [f, sha(f)]);
    const env = {
      ...process.env, HOME: homeDir, USERPROFILE: homeDir, TMPDIR: tmpDir, TEMP: tmpDir, TMP: tmpDir,
      TELEGRAM_BOT_TOKEN: "", SONNI_TELEGRAM_API: "", ...extraEnv,
    };
    const started = Date.now();
    const r = spawnSync(process.execPath, [path.join(VPS, script), ...args], { cwd: REPO, env, encoding: "utf-8", timeout: 120_000 });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    const problems = [];
    if (r.error) problems.push(`lancement impossible : ${r.error.code ?? r.error.message}`);
    if (r.status !== expect) problems.push(`code ${r.status} au lieu de ${expect}`);
    const last = String(r.stdout ?? "").trimEnd().split("\n").pop() ?? "";
    if (resultLine && !/^RÉSULTAT : code=\d+/.test(last)) problems.push("pas de ligne RÉSULTAT finale");
    for (const s of contains) if (!out.includes(s)) problems.push(`texte attendu absent : « ${s} »`);
    for (const [f, h] of before) if (!fs.existsSync(f) || sha(f) !== h) problems.push(`${path.basename(f)} a changé`);
    let left = [];
    try {
      left = fs.readdirSync(tmpDir);
    } catch { /* removed */ }
    if (left.length) problems.push(`dossier temporaire non vidé (${left.join(", ")})`);
    const scrub = (s) => s.split(root).join("<tmp>");
    results.push({
      name, script, args: args.map(scrub), expect, got: r.status, ms: Date.now() - started,
      status: problems.length ? "ÉCART" : "OK", problems, tail: problems.length ? scrub(out).split("\n").slice(-25).join("\n") : "",
    });
    log(`${problems.length ? "ÉCART" : "OK   "} ${name}`);
    return { ...r, last };
  }

  try {
    const copie = (r) => /copie=(\S+)$/.exec(r?.last ?? "")?.[1] ?? "";
    const nonSqlite = path.join(dir("copies"), "pas-une-base.db");
    fs.writeFileSync(nonSqlite, "ceci n'est pas une base SQLite\n");
    const propre = copyOf("propre", {});
    const corrompue = copyOf("corrompue", { corrupt: true });
    const stopFranchi = copyOf("stop-franchi", { crossedStop: true });
    const enAttente = copyOf("achat-en-attente", { pendingBuy: true });
    const sansPause = copyOf("sans-pause", { paused: false });
    // The read-only tools' HOME: its "live" database is only a file older than every copy (verifier-pause compares
    // the copy with it by modification time; no tool opens it).
    const lecture = home("home-lecture", (f) => {
      fs.writeFileSync(f, "base active fictive (seule sa date compte)\n");
      fs.utimesSync(f, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
    });
    const H = lecture.h;

    // 1. Price audit (step 0.3, output kept as shipped: no RÉSULTAT line, exit 0 even when it lists points, 1 on an error).
    const audit = { script: "audit-prix.mjs", homeDir: H, resultLine: false };
    run({ ...audit, name: "audit des prix, base propre", args: [propre], expect: 0, contains: ["Conclusion : rien à réparer"], unchanged: [propre] });
    run({ ...audit, name: "audit des prix, position corrompue listée", args: [corrompue], expect: 0, contains: ["PUMP : quantité non finie", "Conclusion : 2 points à examiner"], unchanged: [corrompue] });
    run({ ...audit, name: "audit des prix, fichier non SQLite", args: [nonSqlite], expect: 1, contains: ["n'est pas une base SQLite"], unchanged: [nonSqlite] });

    // 2. Backup: cold (Sonni stopped, no -wal) and hot (a connection keeps the WAL open, as Sonni does).
    const froid = home("home-sauvegarde-froid", {});
    const r1 = run({ name: "sauvegarde à froid", script: "sauvegarde.mjs", args: [], homeDir: froid.h, expect: 0, contains: ["Mode : à froid"], unchanged: [froid.file] });
    const copieFroide = copie(r1);
    if (copieFroide && fs.existsSync(`${copieFroide}.sha256`)) {
      const line = fs.readFileSync(`${copieFroide}.sha256`, "utf-8").trim();
      results.push({ name: "empreinte .sha256 de la sauvegarde", script: "-", args: [], expect: 0, got: 0, status: line.startsWith(sha(copieFroide)) ? "OK" : "ÉCART", problems: line.startsWith(sha(copieFroide)) ? [] : ["l'empreinte du fichier .sha256 ne correspond pas à la copie"] });
    }
    const chaud = home("home-sauvegarde-chaud", { keepOpen: true });
    run({ name: "sauvegarde à chaud (base ouverte en WAL)", script: "sauvegarde.mjs", args: [], homeDir: chaud.h, expect: 0, contains: ["Mode : à chaud"] });
    const pasBase = home("home-sauvegarde-pas-base", (f) => fs.writeFileSync(f, "ceci n'est pas une base SQLite\n"));
    run({ name: "sauvegarde d'un fichier non SQLite", script: "sauvegarde.mjs", args: [], homeDir: pasBase.h, expect: 3, unchanged: [pasBase.file] });

    // 3. Restore: the drill, then a real restore into a fake HOME (never systemd).
    if (copieFroide) {
      run({ name: "essai de restauration", script: "restauration.mjs", args: ["--essai", copieFroide], homeDir: H, expect: 0, unchanged: [copieFroide] });
      const cible = home("home-restauration", { paused: false });
      const avant = sha(cible.file);
      // No systemd here: SONNI_SYSTEMCTL names a command that does not exist, which --sans-systemd allows.
      const noSystemd = { SONNI_SYSTEMCTL: path.join(root, "pas-de-systemctl") };
      run({ name: "restauration refusée sans --confirmer", script: "restauration.mjs", args: ["--restaurer", copieFroide, "--cible", cible.file, "--sans-systemd"], homeDir: cible.h, expect: 2, unchanged: [cible.file], extraEnv: noSystemd });
      run({ name: "restauration refusée sans systemd ni --sans-systemd", script: "restauration.mjs", args: ["--restaurer", copieFroide, "--confirmer", "--cible", cible.file], homeDir: cible.h, expect: 2, unchanged: [cible.file], extraEnv: noSystemd });
      run({ name: "restauration réelle (--sans-systemd)", script: "restauration.mjs", args: ["--restaurer", copieFroide, "--confirmer", "--cible", cible.file, "--sans-systemd"], homeDir: cible.h, expect: 0, unchanged: [copieFroide], extraEnv: noSystemd });
      const quarantaine = fs.readdirSync(path.join(cible.h, ".automaton")).find((n) => n.startsWith("quarantaine-"));
      const restored = fs.existsSync(cible.file) && sha(cible.file) === sha(copieFroide);
      const kept = quarantaine && fs.existsSync(path.join(cible.h, ".automaton", quarantaine, "state.db")) && sha(path.join(cible.h, ".automaton", quarantaine, "state.db")) === avant;
      results.push({ name: "base restaurée identique à la copie, ancienne base en quarantaine", script: "-", args: [], expect: 0, got: 0, status: restored && kept ? "OK" : "ÉCART", problems: [restored ? null : "la base restaurée diffère de la copie", kept ? null : "ancienne base absente de la quarantaine"].filter(Boolean) });
      if (!IS_WINDOWS) {
        const actif = fakeSystemctl(dir("bin"), "active");
        const autre = home("home-restauration-active", { paused: false });
        run({ name: "restauration refusée pendant que Sonni tourne (faux systemctl)", script: "restauration.mjs", args: ["--restaurer", copieFroide, "--confirmer", "--cible", autre.file], homeDir: autre.h, expect: 2, unchanged: [autre.file], extraEnv: { SONNI_SYSTEMCTL: actif } });
      } else {
        run({ name: "restauration refusée pendant que Sonni tourne (faux systemctl)", script: "restauration.mjs", args: [], homeDir: H, expect: 2, linuxOnly: true });
      }
    }
    run({ name: "essai de restauration d'un fichier non SQLite", script: "restauration.mjs", args: ["--essai", nonSqlite], homeDir: H, expect: 3, unchanged: [nonSqlite] });

    // 4. Gate before deployment: BLOQUANT never lifted, À DÉCIDER lifted by its key only.
    run({ name: "contrôle avant déploiement, base propre", script: "controle-predeploiement.mjs", args: [propre], homeDir: H, expect: 0, unchanged: [propre] });
    run({ name: "contrôle avant déploiement, position corrompue (BLOQUANT)", script: "controle-predeploiement.mjs", args: [corrompue], homeDir: H, expect: 1, contains: ["[BLOQUANT]", "Déploiement bloqué"], unchanged: [corrompue] });
    run({ name: "BLOQUANT non levé par --accepter-a-decider", script: "controle-predeploiement.mjs", args: [corrompue, "--accepter-a-decider", "sans-stop:PUMP"], homeDir: H, expect: 1, contains: ["[BLOQUANT]"], unchanged: [corrompue] });
    run({ name: "contrôle avant déploiement, stop franchi (À DÉCIDER)", script: "controle-predeploiement.mjs", args: [stopFranchi], homeDir: H, expect: 1, contains: ["stop-franchi:BTC"], unchanged: [stopFranchi] });
    run({ name: "stop franchi accepté par sa clé", script: "controle-predeploiement.mjs", args: [stopFranchi, "--accepter-a-decider", "stop-franchi:BTC"], homeDir: H, expect: 0, unchanged: [stopFranchi] });
    run({ name: "contrôle avant déploiement, fichier non SQLite", script: "controle-predeploiement.mjs", args: [nonSqlite], homeDir: H, expect: 3, unchanged: [nonSqlite] });

    // 5. Rollback guard: pause, pending buys, sales rounded to the cent (USDC's stop is under 1 EUR), gate BLOQUANT.
    const pause = { script: "verifier-pause.mjs", homeDir: H };
    const usdc = ["--accepter-arrondi", "USDC"];
    run({ ...pause, name: "retour arrière : stop sous 1 € refusé sans GO nommant l'actif", args: ["--copie", propre], expect: 1, contains: ["vente-arrondie:USDC", "ventes_a_risque=1"], unchanged: [propre] });
    run({ ...pause, name: "retour arrière permis : pause, arrondi USDC accepté", args: ["--copie", propre, ...usdc], expect: 0, contains: ["pause=oui", "bloquants=0"], unchanged: [propre] });
    const vieille = home("home-copie-ancienne", (f) => fs.writeFileSync(f, "base active fictive, modifiée après la copie\n"));
    fs.utimesSync(vieille.file, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    run({ ...pause, name: "retour arrière : copie plus ancienne que la base refusée", args: ["--copie", propre, ...usdc], homeDir: vieille.h, expect: 1, contains: ["copie plus ancienne que la base de Sonni"], unchanged: [propre] });
    run({ ...pause, name: "retour arrière : pause absente", args: ["--copie", sansPause, ...usdc], expect: 1, contains: ["aucune pause enregistrée"], unchanged: [sansPause] });
    run({ ...pause, name: "retour arrière : achat en attente pendant la pause", args: ["--copie", enAttente, ...usdc], expect: 1, contains: ["achats_en_attente=1"], unchanged: [enAttente] });
    run({ ...pause, name: "retour arrière : position corrompue (BLOQUANT)", args: ["--copie", corrompue, ...usdc], expect: 1, contains: ["anomalie(s) BLOQUANT"], unchanged: [corrompue] });
    run({ ...pause, name: "retour arrière vérifié sur la base en marche (lecture seule)", args: ["--en-marche", "--depuis", new Date(Date.now() - 30 * 60_000).toISOString().slice(0, 19) + "Z", ...usdc], homeDir: chaud.h, expect: 0, contains: ["achats_depuis=0", "ventes_depuis=0"] });

    // 6. Read-only preflight of the server (a VPS tool: Linux only; as root it reports that one failure).
    const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
    if (IS_WINDOWS) run({ name: "vérification de l'environnement du serveur", script: "verification-environnement.mjs", args: [], homeDir: H, expect: 0, linuxOnly: true });
    else {
      const env = home("home-environnement", {});
      run({
        name: "vérification de l'environnement du serveur", script: "verification-environnement.mjs", args: ["--depot", REPO], homeDir: env.h,
        expect: isRoot ? 1 : 0, contains: ["même module que Sonni", isRoot ? "lancé en root" : "Conclusion : le serveur a ce que les outils demandent"],
        unchanged: [env.file], extraEnv: { SONNI_SYSTEMCTL: fakeSystemctl(dir("bin-env"), "inactive") },
      });
    }
  } finally {
    for (const db of openDbs) {
      try { db.close(); } catch { /* already closed */ }
    }
    if (!keep) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  const ecarts = results.filter((r) => r.status === "ÉCART").length;
  return { results, code: ecarts ? 1 : 0, root: keep ? root : null };
}

function version(dir, pkg) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "node_modules", pkg, "package.json"), "utf-8")).version;
  } catch {
    return "introuvable";
  }
}
function gitHead() {
  const r = spawnSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf-8" });
  return r.status === 0 ? r.stdout.trim() : "inconnu";
}

/** The Markdown report (French). */
export function report(results, code) {
  const n = (s) => results.filter((r) => r.status === s).length;
  const lines = [
    "# Contre-vérification des outils de déploiement (bases fictives)",
    "",
    `- Date : ${new Date().toISOString().slice(0, 19)}Z`,
    `- Système : ${os.type()} ${os.release()} (${process.platform}, ${process.arch})`,
    `- Node : ${process.version} ; better-sqlite3 : ${version(REPO, "better-sqlite3")}`,
    `- Commit : ${gitHead()}`,
    `- Résultat : ${code === 0 ? "tous les cas sont conformes" : "au moins un écart"} — ${results.length} cas, ${n("OK")} conformes, ${n("ÉCART")} écarts, ${n("NON APPLICABLE")} non applicables`,
    "- Données : uniquement des bases fictives créées pour l'occasion ; aucune donnée de production, aucun réseau.",
    "",
    "| # | Cas | Outil | Code attendu | Code obtenu | Statut |",
    "|---|-----|-------|--------------|-------------|--------|",
    ...results.map((r, i) => `| ${i + 1} | ${r.name} | ${r.script} | ${r.expect} | ${r.got ?? "-"} | ${r.status} |`),
  ];
  const ecarts = results.filter((r) => r.status === "ÉCART");
  if (ecarts.length) {
    lines.push("", "## Écarts");
    for (const r of ecarts) {
      lines.push("", `### ${r.name}`, "", `Commande : \`node sonni/vps/${r.script} ${r.args.join(" ")}\``, "", ...r.problems.map((p) => `- ${p}`));
      if (r.tail) lines.push("", "```", r.tail, "```");
    }
  }
  const na = results.filter((r) => r.status === "NON APPLICABLE");
  if (na.length) lines.push("", "## Non applicables", "", ...na.map((r) => `- ${r.name} : ${r.note}`));
  return `${lines.join("\n")}\n`;
}

async function main() {
  const argv = process.argv.slice(2);
  let dist = path.join(REPO, "dist");
  let out = path.resolve(`contre-verification-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z.md`);
  let keep = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dist" && argv[i + 1]) dist = path.resolve(argv[++i]);
    else if (argv[i] === "--rapport" && argv[i + 1]) out = path.resolve(argv[++i]);
    else if (argv[i] === "--garder") keep = true;
    else {
      process.stderr.write(`Option inconnue ou incomplète : ${argv[i]}. ${USAGE}\n`);
      process.stdout.write("RÉSULTAT : code=2 cas=0 ok=0 ecarts=0 non_applicables=0\n");
      process.exitCode = 2;
      return;
    }
  }
  try {
    const api = await loadDistApi(dist);
    const { results, code, root } = await runCounterCheck({ api, keep, log: (l) => process.stdout.write(`${l}\n`) });
    fs.writeFileSync(out, report(results, code));
    const n = (s) => results.filter((r) => r.status === s).length;
    process.stdout.write(`Rapport : ${out}\n`);
    if (root) process.stdout.write(`Dossier temporaire gardé (données fictives) : ${root}\n`);
    process.stdout.write(`RÉSULTAT : code=${code} cas=${results.length} ok=${n("OK")} ecarts=${n("ÉCART")} non_applicables=${n("NON APPLICABLE")}\n`);
    process.exitCode = code;
  } catch (err) {
    process.stderr.write(`Contre-vérification impossible : ${String(err?.message ?? err)}\n`);
    process.stdout.write("RÉSULTAT : code=3 cas=0 ok=0 ecarts=0 non_applicables=0\n");
    process.exitCode = err?.exitCode ?? 3;
  }
}

const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};
if (process.argv[1] && real(path.resolve(process.argv[1])) === real(fileURLToPath(import.meta.url))) await main();
