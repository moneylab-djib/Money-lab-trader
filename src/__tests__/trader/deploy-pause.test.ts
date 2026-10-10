/**
 * Controlled deployment of 2026-10-10: the pause check before and after a code rollback
 * (sonni/vps/verifier-pause.mjs). A rollback runs a version without the step 0.3 precision fix, so it is only
 * allowed when the pause is really recorded and nothing the old broker fills on its own can damage the history.
 * The script runs as the owner runs it, in a child process with a temporary HOME and TMPDIR, on fictitious
 * databases written by the real broker. No network, no inference.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { createDatabase } from "../../state/database.js";
import { ensureMoneyLabSchema, pause, setKV } from "../../money-lab/journal.js";
import type { AutomatonDatabase } from "../../types.js";
import { parseTraderConfig, type TraderConfig } from "../../trader/config.js";
import { ensureTraderSchema } from "../../trader/schema.js";
import { isoSeconds } from "../../trader/prices.js";
import { brokerTick, placeOrder } from "../../trader/portfolio.js";

const ROOT = path.join(__dirname, "..", "..", "..");
const SCRIPT = path.join(ROOT, "sonni", "vps", "verifier-pause.mjs");
const EXAMPLE = JSON.parse(fs.readFileSync(path.join(ROOT, "sonni", "automaton.sonni.example.json"), "utf-8"));
EXAMPLE.trader.assets = [["BTC", "XBTEUR"], ["USDC", "USDCEUR"], ["PUMP", "PUMPEUR"]].map(([symbol, krakenPair]) => ({ symbol, krakenPair }));
const TRADER: TraderConfig = parseTraderConfig(EXAMPLE.trader)!;
const T0 = new Date("2026-10-07T08:00:00Z");
const hours = (n: number) => new Date(T0.getTime() + n * 3_600_000);
const THESIS = "Test de la vérification de la pause : position modeste pour donner au courtier virtuel un état réaliste.";

let tmpDirs: string[] = [];
let openDbs: AutomatonDatabase[] = [];
function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
beforeEach(() => {
  tmpDirs = [];
  openDbs = [];
});
afterEach(() => {
  for (const db of openDbs) {
    try { db.close(); } catch { /* already closed */ }
  }
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function openDb(file: string): AutomatonDatabase {
  const db = createDatabase(file);
  ensureMoneyLabSchema(db.raw);
  ensureTraderSchema(db.raw);
  return db;
}
function storePrice(db: AutomatonDatabase, asset: string, at: Date, price: number) {
  db.raw.prepare("INSERT INTO trader_prices (asset, ts, price, source) VALUES (?, ?, ?, 'test')").run(asset, isoSeconds(at), price);
}
function place(db: AutomatonDatabase, at: number, asset: string, price: number, order: Record<string, unknown>): string {
  storePrice(db, asset, hours(at), price);
  const placed = placeOrder(db.raw, TRADER, { asset, thesis: THESIS, ...order } as any, hours(at));
  expect(placed.ok, JSON.stringify(placed)).toBe(true);
  return (placed as { ok: true; value: { id: string } }).value.id;
}
function trade(db: AutomatonDatabase, at: number, asset: string, price: number, order: Record<string, unknown>) {
  place(db, at, asset, price, order);
  storePrice(db, asset, hours(at + 0.1), price);
  const out = brokerTick(db.raw, TRADER, hours(at + 0.1));
  expect(out.fills.length, JSON.stringify(out.rejected)).toBeGreaterThan(0);
}
const buy = (amountEur: number, price: number) => ({ side: "buy", amountEur, invalidation: price * 0.7 });

/** Capital, a BTC position and a USDC position (under 1 EUR), written by the new broker; `extra` adds to it. */
function fill(db: AutomatonDatabase, extra?: (db: AutomatonDatabase) => void) {
  storePrice(db, "BTC", T0, 60_000);
  brokerTick(db.raw, TRADER, T0);
  trade(db, 1, "BTC", 60_000, buy(200, 60_000));
  trade(db, 2, "USDC", 0.87, buy(100, 0.87));
  extra?.(db);
}
/** A closed copy (as sauvegarde.mjs writes it) with the given state. */
function copy(opts: { paused?: boolean; extra?: (db: AutomatonDatabase) => void } = {}): string {
  const file = path.join(tmp("sonni-pause-"), "state.db.predeploiement-20261007T180000Z");
  const db = openDb(file);
  fill(db, opts.extra);
  if (opts.paused) pause(db.raw, "retour arrière", "operator");
  db.close();
  expect(fs.existsSync(`${file}-wal`)).toBe(false);
  return file;
}

const sha = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function run(args: string[], home = tmp("sonni-pause-home-")) {
  const tmpRoot = tmp("sonni-pause-tmp-");
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf-8", env: { ...process.env, HOME: home, TMPDIR: tmpRoot } });
  expect(fs.readdirSync(tmpRoot)).toEqual([]);
  const last = r.stdout.trimEnd().split("\n").pop() ?? "";
  expect(last, r.stdout + r.stderr).toMatch(/^RÉSULTAT : code=\d+ pause=/);
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, last };
}
function runCopy(file: string, args: string[] = []) {
  const before = sha(file);
  const r = run(["--copie", file, ...args]);
  expect(sha(file)).toBe(before);
  expect(fs.existsSync(`${file}-wal`) || fs.existsSync(`${file}-shm`)).toBe(false);
  return r;
}

describe("Pause check before a rollback (sonni/vps/verifier-pause.mjs), on a copy", () => {
  it("refuses the rollback when no pause is recorded: exit 1, pause=non", () => {
    const r = runCopy(copy());
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain("ÉCHEC : aucune pause enregistrée");
    expect(r.stdout).toContain("ne démarre pas l'ancienne version");
    expect(r.last).toBe("RÉSULTAT : code=1 pause=non achats_en_attente=0 positions_sous_1_centime=0 positions_invalides=0 achats_depuis=non vérifié");
  });

  it("lets it go on when the pause is recorded and nothing can buy: exit 0; a position under 1 EUR is listed, not blocking", () => {
    const r = runCopy(copy({ paused: true }));
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/OK : pause enregistrée depuis \d{2}\/\d{2}\/\d{4} \d{2}:\d{2} UTC \(retour arrière\)/);
    expect(r.stdout).toContain("OK : aucun ordre d'achat en attente");
    expect(r.stdout).toMatch(/position USDC : dernier prix 0,87 € .*sous 1 €/);
    expect(r.stdout).toContain("OK : aucune position sur un actif sous 1 centime (2 position(s) ouverte(s))");
    expect(r.stdout).not.toContain("ÉCHEC");
    expect(r.last).toBe("RÉSULTAT : code=0 pause=oui achats_en_attente=0 positions_sous_1_centime=0 positions_invalides=0 achats_depuis=non vérifié");
  });

  it("counts an unreadable pause record as a pause, as the runtime does (fail closed)", () => {
    const r = runCopy(copy({ extra: (db) => setKV(db.raw, "money_lab.paused", "{pas du json") }));
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toContain("OK : pause enregistrée enregistrement illisible, compté comme une pause");
  });

  it("refuses while a buy is pending, even paused (the old broker fills it), and lists it with its asset's last price", () => {
    const file = copy({ paused: true, extra: (db) => place(db, 3, "BTC", 61_000, { side: "buy", kind: "limit", limitPrice: 55_000, amountEur: 50, invalidation: 44_000 }) });
    const r = runCopy(file);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain("ÉCHEC : 1 ordre(s) d'achat en attente");
    expect(r.stdout).toMatch(/achat à cours limité \(55\s000,00 €\) de BTC pour 50 € passé le 07\/10\/2026 11:00 UTC ; dernier prix 61\s000,00 €/);
    expect(r.last).toContain("code=1 pause=oui achats_en_attente=1 ");
  });

  it("refuses with a position on an asset under 1 cent (the old broker would sell it at 0, a stop included)", () => {
    const file = copy({ paused: true, extra: (db) => trade(db, 3, "PUMP", 0.0048874425, buy(50, 0.0048874425)) });
    const r = runCopy(file);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toMatch(/ÉCHEC : position PUMP : dernier prix 0,0048874425 € .*sous 1 centime/);
    expect(r.last).toContain("positions_sous_1_centime=1 ");
  });
});

describe("Pause check after the old version started (--en-marche), on the live database read-only", () => {
  /** Sonni's live WAL database, kept open by this process as the service keeps it. */
  function live(extra?: (db: AutomatonDatabase) => void): { home: string; db: AutomatonDatabase; file: string } {
    const home = tmp("sonni-pause-live-");
    fs.mkdirSync(path.join(home, ".automaton"));
    const file = path.join(home, ".automaton", "state.db");
    const db = openDb(file);
    openDbs.push(db);
    fill(db);
    pause(db.raw, "retour arrière", "operator");
    extra?.(db);
    expect(fs.existsSync(`${file}-wal`) && fs.existsSync(`${file}-shm`)).toBe(true);
    return { home, db, file };
  }
  const counts = (db: AutomatonDatabase) => db.raw.prepare("SELECT (SELECT COUNT(*) FROM trader_orders) AS o, (SELECT COUNT(*) FROM kv) AS k").get();

  it("passes when nothing was bought since the start, and writes nothing", () => {
    const { home, db } = live();
    const before = counts(db);
    const r = run(["--en-marche", "--depuis", hours(5).toISOString()], home);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("OK : aucun achat passé ni exécuté depuis le 07/10/2026 13:00 UTC");
    expect(r.stdout).toContain("Conclusion : la pause tient et rien n'a été acheté depuis le démarrage.");
    expect(r.last).toBe("RÉSULTAT : code=0 pause=oui achats_en_attente=0 positions_sous_1_centime=0 positions_invalides=0 achats_depuis=0");
    expect(counts(db)).toEqual(before);
  });

  it("fails and says to stop Sonni when a buy was placed and filled since the start", () => {
    const { home } = live((db) => trade(db, 6, "BTC", 61_000, buy(50, 61_000)));
    const r = run(["--en-marche", "--depuis", hours(5).toISOString()], home);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain("ÉCHEC : 1 achat(s) depuis le 07/10/2026 13:00 UTC : arrête Sonni tout de suite (systemctl stop sonni)");
    expect(r.stdout).toMatch(/achat de BTC passé le 07\/10\/2026 14:00 UTC/);
    expect(r.stdout).toMatch(/achat de BTC exécuté le 07\/10\/2026 14:06 UTC à 61\s0\d\d,\d\d €/);
    expect(r.last).toContain("achats_depuis=1");
  });

  it("fails when the pause was lifted while the old version runs", () => {
    const { home } = live((db) => db.raw.prepare("DELETE FROM kv WHERE key = 'money_lab.paused'").run());
    const r = run(["--en-marche"], home);
    expect(r.status, r.stdout).toBe(1);
    expect(r.last).toContain("pause=non");
  });

  it("opens nothing when Sonni does not run (no -wal beside the database): exit 2", () => {
    const home = tmp("sonni-pause-stopped-");
    fs.mkdirSync(path.join(home, ".automaton"));
    const file = path.join(home, ".automaton", "state.db");
    const db = openDb(file);
    fill(db);
    db.close();
    const r = run(["--en-marche"], home);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Sonni ne semble pas tourner");
    expect(fs.existsSync(`${file}-wal`) || fs.existsSync(`${file}-shm`)).toBe(false);
  });
});

describe("Pause check: refusals and errors", () => {
  it("refuses usage errors with exit 2 and reads nothing", () => {
    const file = copy({ paused: true });
    for (const args of [[], ["--copie"], ["--copie", file, "--en-marche"], ["--copie", file, "--depuis", "2026-10-07T13:00:00Z"],
      ["--en-marche", "--depuis", "hier"], ["--inconnue"]]) {
      const r = run(args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.last).toBe("RÉSULTAT : code=2 pause=inconnue achats_en_attente=inconnu positions_sous_1_centime=inconnu positions_invalides=inconnu achats_depuis=non vérifié");
    }
  });

  it("refuses the live database given as a copy, and a copy with a -wal beside it", () => {
    const home = tmp("sonni-pause-home-");
    fs.mkdirSync(path.join(home, ".automaton"));
    const liveFile = path.join(home, ".automaton", "state.db");
    fs.copyFileSync(copy({ paused: true }), liveFile);
    let r = run(["--copie", liveFile], home);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("c'est la base active de Sonni");
    const open = copy({ paused: true });
    fs.writeFileSync(`${open}-wal`, "");
    r = run(["--copie", open]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("un fichier -wal ou -shm est à côté");
  });

  it("stops with exit 3 on a file that is not SQLite or not Sonni's memory", () => {
    const dir = tmp("sonni-pause-bad-");
    const text = path.join(dir, "pas-une-base.db");
    fs.writeFileSync(text, "ceci n'est pas une base");
    let r = run(["--copie", text]);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("n'est pas une base SQLite");
    const other = path.join(dir, "autre.db");
    const db = createDatabase(other);
    db.close();
    r = run(["--copie", other]);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("Ce n'est pas la mémoire de Sonni");
  });
});
