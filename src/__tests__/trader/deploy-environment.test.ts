/**
 * Controlled deployment of 2026-10-10: the tools run BEFORE anything is installed on the VPS, from a private
 * folder holding only the approved commit's sonni/vps (git archive) and a node_modules link to Sonni's own
 * dependencies (sonni/GUIDE-VPS.fr.md, Phase 2). These tests rebuild that folder from this checkout and run the
 * read-only preflight (sonni/vps/verification-environnement.mjs) and the whole pre-install sequence from it, in
 * child processes with a temporary HOME and TMPDIR and a fake systemctl. No network, no inference.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import Database from "better-sqlite3";
import { createDatabase } from "../../state/database.js";
import { ensureMoneyLabSchema, pause } from "../../money-lab/journal.js";
import { parseTraderConfig, type TraderConfig } from "../../trader/config.js";
import { ensureTraderSchema } from "../../trader/schema.js";
import { isoSeconds } from "../../trader/prices.js";
import { brokerTick, placeOrder } from "../../trader/portfolio.js";

const ROOT = path.join(__dirname, "..", "..", "..");
const EXAMPLE = JSON.parse(fs.readFileSync(path.join(ROOT, "sonni", "automaton.sonni.example.json"), "utf-8"));
EXAMPLE.trader.assets = [{ symbol: "BTC", krakenPair: "XBTEUR" }];
const TRADER: TraderConfig = parseTraderConfig(EXAMPLE.trader)!;
const ROOT_USER = typeof process.getuid === "function" && process.getuid() === 0;

let tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
beforeEach(() => { tmpDirs = []; });
afterEach(() => { for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true }); });

/** The guide's /home/sonni/outils-deploiement: sonni/vps only, and (unless `link` is false) node_modules -> Sonni's. */
function isolatedTools(link = true): string {
  const dir = tmp("sonni-outils-");
  fs.cpSync(path.join(ROOT, "sonni", "vps"), path.join(dir, "sonni", "vps"), { recursive: true });
  if (link) fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"), "dir");
  expect(fs.existsSync(path.join(dir, "dist")) || fs.existsSync(path.join(dir, "src")) || fs.existsSync(path.join(dir, "package.json"))).toBe(false);
  return dir;
}
/** A fake systemctl answering `state` to `is-active sonni`. */
function fakeSystemctl(state: string): string {
  const bin = path.join(tmp("sonni-faux-systemctl-"), "systemctl");
  fs.writeFileSync(bin, `#!/bin/sh\necho ${state}\n[ "${state}" = active ] && exit 0 || exit 3\n`, { mode: 0o755 });
  return bin;
}
/**
 * Sonni's HOME with a stopped, closed, paused database: capital, a BTC position bought by the new broker with its
 * stop, prices up to 3 minutes ago, asleep for two hours (a restart would not pay a cycle).
 */
function sonniHome(): string {
  const home = tmp("sonni-home-");
  fs.mkdirSync(path.join(home, ".automaton"), { mode: 0o700 });
  const db = createDatabase(path.join(home, ".automaton", "state.db"));
  ensureMoneyLabSchema(db.raw);
  ensureTraderSchema(db.raw);
  const now = Date.now();
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000);
  const price = (d: Date, p: number) => db.raw.prepare("INSERT INTO trader_prices (asset, ts, price, source) VALUES ('BTC', ?, ?, 'test')").run(isoSeconds(d), p);
  price(at(120), 60_000);
  brokerTick(db.raw, TRADER, at(120));
  price(at(60), 60_050);
  const placed = placeOrder(db.raw, TRADER, { asset: "BTC", side: "buy", amountEur: 100, invalidation: 42_000, thesis: "Test des outils isolés : petite position avec un stop pour un état réaliste du courtier virtuel." } as any, at(60));
  expect(placed.ok, JSON.stringify(placed)).toBe(true);
  price(at(59), 60_100);
  expect(brokerTick(db.raw, TRADER, at(59)).fills.length).toBe(1);
  price(at(3), 60_200);
  brokerTick(db.raw, TRADER, at(3));
  db.setAgentState("sleeping");
  db.setKV("sleep_until", new Date(now + 2 * 3_600_000).toISOString());
  pause(db.raw, "test", "operator");
  db.close();
  expect(fs.existsSync(path.join(home, ".automaton", "state.db-wal"))).toBe(false);
  return home;
}
function run(tools: string, script: string, args: string[], home: string, extra: NodeJS.ProcessEnv = {}) {
  const tmpRoot = tmp("sonni-outils-tmp-");
  // cwd is the tools folder, as in the guide (cd /home/sonni/outils-deploiement).
  const r = spawnSync(process.execPath, [path.join("sonni", "vps", script), ...args], {
    cwd: tools, encoding: "utf-8", env: { ...process.env, HOME: home, TMPDIR: tmpRoot, ...extra },
  });
  expect(fs.readdirSync(tmpRoot), `${script}: temporary folder left`).toEqual([]);
  const last = r.stdout.trimEnd().split("\n").pop() ?? "";
  expect(last, `${script}\n${r.stdout}${r.stderr}`).toMatch(/^RÉSULTAT : code=\d+/);
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, last };
}
/** The preflight's ÉCHEC lines, without the one expected when the tests run as root. */
const failures = (stdout: string) => stdout.split("\n").filter((l) => l.startsWith("- ÉCHEC") && !(ROOT_USER && l.includes("lancé en root")));

describe("Read-only preflight of the server (sonni/vps/verification-environnement.mjs)", () => {
  it("passes from the isolated tools folder: Node, Sonni's own better-sqlite3, the user, ~/.automaton, disk, commands", () => {
    const tools = isolatedTools();
    const home = sonniHome();
    const before = fs.readdirSync(path.join(home, ".automaton")).sort();
    const r = run(tools, "verification-environnement.mjs", ["--depot", ROOT], home, { SONNI_SYSTEMCTL: fakeSystemctl("inactive") });
    expect(failures(r.stdout), r.stdout).toEqual([]);
    expect(r.status, r.stdout).toBe(ROOT_USER ? 1 : 0);
    expect(r.stdout).toMatch(/OK : Node v\d+/);
    expect(r.stdout).toMatch(/OK : better-sqlite3 11\.10\.0 se charge et copie une base d'essai \(SQLite \d+\.\d+\.\d+\)/);
    expect(r.stdout).toContain(`OK : même module que Sonni (${ROOT}, better-sqlite3 11.10.0)`);
    expect(r.stdout).toMatch(/OK : .*state\.db : [\d,]+ Mo, à .*, droits 0\d{3}/);
    expect(r.stdout).toContain("INFO : pas de fichier -wal : Sonni est arrêté proprement");
    expect(r.stdout).toMatch(/OK : dossier temporaire .* libres, il en faut/);
    expect(r.stdout).toMatch(/OK : git : git version/);
    expect(r.stdout).toContain("INFO : systemctl is-active sonni : inactive");
    // Read-only for Sonni: nothing appeared beside its database.
    expect(fs.readdirSync(path.join(home, ".automaton")).sort()).toEqual(before);
  });

  it("fails without the node_modules link (the tools could not open any database)", () => {
    const r = run(isolatedTools(false), "verification-environnement.mjs", ["--depot", ROOT], sonniHome(), { SONNI_SYSTEMCTL: fakeSystemctl("inactive") });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("ÉCHEC : better-sqlite3 introuvable depuis");
    expect(r.stdout).toContain("Conclusion : ne va pas plus loin ; envoie-moi cette sortie.");
  });

  it("fails when Sonni's folder has no better-sqlite3 (wrong --depot) or the database is missing or a link", () => {
    const tools = isolatedTools();
    const home = sonniHome();
    const sysctl = { SONNI_SYSTEMCTL: fakeSystemctl("active") };
    let r = run(tools, "verification-environnement.mjs", ["--depot", tmp("sonni-pas-de-depot-")], home, sysctl);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("ÉCHEC : better-sqlite3 introuvable dans");
    const base = path.join(home, ".automaton", "state.db");
    const real = path.join(home, "ailleurs.db");
    fs.renameSync(base, real);
    r = run(tools, "verification-environnement.mjs", ["--depot", ROOT], home, sysctl);
    expect(r.stdout).toMatch(/ÉCHEC : .*state\.db : introuvable\./);
    fs.symlinkSync(real, base);
    r = run(tools, "verification-environnement.mjs", ["--depot", ROOT], home, sysctl);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("est un lien symbolique : les outils le refusent.");
  });

  it("fails when systemctl is missing, and refuses an unknown option with exit 2", () => {
    const tools = isolatedTools();
    const home = sonniHome();
    let r = run(tools, "verification-environnement.mjs", ["--depot", ROOT], home, { SONNI_SYSTEMCTL: path.join(tmp("sonni-sans-systemctl-"), "systemctl") });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("absente : la restauration en a besoin pour savoir si Sonni tourne.");
    r = run(tools, "verification-environnement.mjs", ["--inconnue"], home);
    expect(r.status).toBe(2);
    expect(r.last).toBe("RÉSULTAT : code=2 echecs=inconnu");
  });
});

describe("The pre-install sequence of the guide, from the isolated tools folder", () => {
  it("backs up, drills a restore, passes the gate and verifies the pause without /opt/sonni's dist, src or package.json", () => {
    const tools = isolatedTools();
    const home = sonniHome();
    const live = path.join(home, ".automaton", "state.db");
    const liveBefore = fs.readFileSync(live);

    const backup = run(tools, "sauvegarde.mjs", [], home);
    expect(backup.status, backup.stdout + backup.stderr).toBe(0);
    const copy = /copie=(\S+)$/.exec(backup.last)?.[1] ?? "";
    expect(copy.startsWith(path.join(home, ".automaton", "predeploiement"))).toBe(true);
    expect(fs.existsSync(`${copy}.sha256`)).toBe(true);

    const drill = run(tools, "restauration.mjs", ["--essai", copy], home);
    expect(drill.status, drill.stdout + drill.stderr).toBe(0);

    const gate = run(tools, "controle-predeploiement.mjs", [copy], home);
    expect(gate.status, gate.stdout + gate.stderr).toBe(0);
    expect(gate.last).toMatch(/bloquants=0 /);

    const paused = run(tools, "verifier-pause.mjs", ["--copie", copy], home);
    expect(paused.status, paused.stdout + paused.stderr).toBe(0);

    // The live database was never written, and nothing was left beside it.
    expect(fs.readFileSync(live).equals(liveBefore)).toBe(true);
    expect(fs.existsSync(`${live}-wal`) || fs.existsSync(`${live}-shm`)).toBe(false);
  });

  it("stops at the gate on a corrupt position (BLOQUANT, exit 1), before the guide installs anything; no key lifts it", () => {
    const tools = isolatedTools();
    const home = sonniHome();
    const live = path.join(home, ".automaton", "state.db");
    // A pre-0.3 buy at a price rounded to 0: infinite quantity, zero average cost.
    const db = new Database(live);
    const at = isoSeconds(new Date(Date.now() - 30 * 60_000));
    db.prepare("INSERT INTO trader_ledger (id, at, kind, asset, quantity, price, amount_eur, fee_eur, order_id, note) VALUES ('l_pump', ?, 'buy', 'PUMP', 9e999, 0, -50, 0.4, 'o_pump', NULL)").run(at);
    db.prepare("INSERT INTO trader_positions (asset, quantity, avg_cost, opened_at, open_order_id, invalidation, horizon_until, thesis, updated_at) VALUES ('PUMP', 9e999, 0, ?, 'o_pump', NULL, NULL, 'Position corrompue de test.', ?)").run(at, at);
    db.close();
    const backup = run(tools, "sauvegarde.mjs", [], home);
    expect(backup.status, backup.stdout + backup.stderr).toBe(0);
    const copy = /copie=(\S+)$/.exec(backup.last)?.[1] ?? "";
    const gate = run(tools, "controle-predeploiement.mjs", [copy], home);
    expect(gate.status, gate.stdout).toBe(1);
    expect(gate.stdout).toMatch(/\[BLOQUANT\] 1 position ouverte invalide \(PUMP\)/);
    expect(gate.stdout).toContain("Déploiement bloqué : ne démarre pas la nouvelle version");
    const keys = /^Pour accepter exactement ces points : --accepter-a-decider (\S+)$/m.exec(gate.stdout)?.[1] ?? "sans-stop:PUMP";
    const accepted = run(tools, "controle-predeploiement.mjs", [copy, "--accepter-a-decider", keys], home);
    expect(accepted.status).toBe(1);
    // The rollback check refuses the same database too: no version starts on it before a separate repair.
    const paused = run(tools, "verifier-pause.mjs", ["--copie", copy], home);
    expect(paused.status).toBe(1);
    expect(paused.stdout).toMatch(/ÉCHEC : \d+ anomalie\(s\) BLOQUANT du contrôle avant déploiement/);
    expect(paused.stdout).toContain("1 position ouverte invalide (PUMP)");
    expect(paused.last).toMatch(/bloquants=[1-9]/);
  });
});
