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

/** Capital and a BTC position with its stop, written by the new broker; `extra` adds to it. */
function fill(db: AutomatonDatabase, extra?: (db: AutomatonDatabase) => void) {
  storePrice(db, "BTC", T0, 60_000);
  brokerTick(db.raw, TRADER, T0);
  trade(db, 1, "BTC", 60_000, buy(200, 60_000));
  extra?.(db);
}
/** A USDC position (under 1 EUR) with its stop at 0.609 EUR. */
const usdc = (db: AutomatonDatabase) => trade(db, 2, "USDC", 0.87, buy(100, 0.87));
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
/** A HOME whose live database (only its modification time is read) predates every copy. */
function homeWithOlderLive(): string {
  const home = tmp("sonni-pause-home-");
  fs.mkdirSync(path.join(home, ".automaton"));
  const live = path.join(home, ".automaton", "state.db");
  fs.writeFileSync(live, "base active fictive");
  fs.utimesSync(live, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
  return home;
}
function runCopy(file: string, args: string[] = [], home = homeWithOlderLive()) {
  const before = sha(file);
  const r = run(["--copie", file, ...args], home);
  expect(sha(file)).toBe(before);
  expect(fs.existsSync(`${file}-wal`) || fs.existsSync(`${file}-shm`)).toBe(false);
  return r;
}

const RESULT_UNKNOWN = "RÉSULTAT : code=2 pause=inconnue achats_en_attente=inconnu ventes_a_risque=inconnu positions_sans_prix=inconnu bloquants=inconnu achats_depuis=non vérifié ventes_depuis=non vérifié";

describe("Pause check before a rollback (sonni/vps/verifier-pause.mjs), on a copy", () => {
  it("refuses the rollback when no pause is recorded: exit 1, pause=non", () => {
    const r = runCopy(copy());
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain("ÉCHEC : aucune pause enregistrée");
    expect(r.stdout).toContain("ne démarre pas l'ancienne version");
    expect(r.last).toBe("RÉSULTAT : code=1 pause=non achats_en_attente=0 ventes_a_risque=0 positions_sans_prix=0 bloquants=0 achats_depuis=non vérifié ventes_depuis=non vérifié");
  });

  it("refuses a copy older than Sonni's database (a daily backup, an earlier copy), and a run without the live database", () => {
    const file = copy({ paused: true });
    const home = homeWithOlderLive();
    const live = path.join(home, ".automaton", "state.db");
    let r = runCopy(file, [], home);
    expect(r.stdout).toContain("OK : copie à jour : la base de Sonni n'a pas changé depuis qu'elle a été faite");
    // Sonni wrote after the copy (it ran, or the pause was recorded after the backup).
    fs.utimesSync(live, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    r = runCopy(file, [], home);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain("ÉCHEC : copie plus ancienne que la base de Sonni (state.db modifié après la copie)");
    // A -wal newer than the copy counts too.
    fs.utimesSync(live, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
    fs.writeFileSync(`${live}-wal`, "");
    r = runCopy(file, [], home);
    expect(r.stdout).toContain("(state.db-wal modifié après la copie)");
    // No live database in HOME: cannot tell, refused.
    r = runCopy(file, [], tmp("sonni-pause-sans-base-"));
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("ÉCHEC : base de Sonni introuvable");
  });

  it("refuses the live database given as the copy, pointing to the fresh backup", () => {
    const home = homeWithOlderLive();
    const r = run(["--copie", path.join(home, ".automaton", "state.db")], home);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Donne la copie que la sauvegarde vient de faire (COPIE_RETOUR");
  });

  it("lets it go on when the pause is recorded and nothing can buy or sell at a rounded price: exit 0", () => {
    const r = runCopy(copy({ paused: true }));
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/OK : pause enregistrée depuis \d{2}\/\d{2}\/\d{4} \d{2}:\d{2} UTC \(retour arrière\)/);
    expect(r.stdout).toContain("OK : aucun ordre d'achat en attente");
    expect(r.stdout).toContain("OK : aucune vente à risque d'arrondi sans ton accord (1 position(s) ouverte(s), 0 vente(s) en attente)");
    expect(r.stdout).toContain("OK : aucune anomalie BLOQUANT du contrôle avant déploiement");
    expect(r.stdout).not.toContain("ÉCHEC");
    expect(r.last).toBe("RÉSULTAT : code=0 pause=oui achats_en_attente=0 ventes_a_risque=0 positions_sans_prix=0 bloquants=0 achats_depuis=non vérifié ventes_depuis=non vérifié");
  });

  it("counts an unreadable pause record as a pause, as the runtime does (fail closed)", () => {
    const r = runCopy(copy({ extra: (db) => setKV(db.raw, "money_lab.paused", "{pas du json") }));
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toContain("OK : pause enregistrée enregistrement illisible, compté comme une pause");
  });

  it("refuses while a buy is pending, even paused (the old broker fills it), and lists it with its horizon and its asset's last price", () => {
    const file = copy({ paused: true, extra: (db) => place(db, 3, "BTC", 61_000, { side: "buy", kind: "limit", limitPrice: 55_000, amountEur: 50, invalidation: 44_000 }) });
    const r = runCopy(file);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain("ÉCHEC : 1 ordre(s) d'achat en attente");
    expect(r.stdout).toMatch(/achat à cours limité \(55\s000,00 €\) de BTC pour 50 € passé le 07\/10\/2026 11:00 UTC, échéance \d{2}\/\d{2}\/2026 \d{2}:\d{2} UTC ; dernier prix 61\s000,00 €/);
    expect(r.last).toContain("code=1 pause=oui achats_en_attente=1 ");
  });

  it("refuses a stop under 1 EUR (the old broker sells at a cent-rounded price) unless the GO names the asset", () => {
    const file = copy({ paused: true, extra: usdc });
    let r = runCopy(file);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toMatch(/ÉCHEC : USDC : dernier prix 0,87 € .*, stop à 0,609 € : l'ancienne version vendrait au centime près, jusqu'à 0,8 % de la valeur d'une unité \(clé vente-arrondie:USDC\)/);
    expect(r.stdout).toContain("--accepter-arrondi USDC");
    expect(r.last).toContain("ventes_a_risque=1 ");
    r = runCopy(file, ["--accepter-arrondi", "USDC"]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toContain("accepté par ton GO (--accepter-arrondi)");
    // Naming another asset lifts nothing.
    expect(runCopy(file, ["--accepter-arrondi", "ADA"]).status).toBe(1);
  });

  it("refuses a pending sale under 1 EUR, and lists a position under 1 EUR without stop or sale as harmless", () => {
    const sale = copy({ paused: true, extra: (db) => {
      usdc(db);
      place(db, 3, "USDC", 0.9, { side: "sell", kind: "limit", limitPrice: 0.95, quantity: "all" });
    } });
    const r = runCopy(sale, ["--accepter-arrondi", "BTC"]);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toMatch(/ÉCHEC : USDC : .*1 vente\(s\) en attente et stop à 0,609 €/);
    const bare = copy({ paused: true, extra: (db) => {
      usdc(db);
      db.raw.prepare("UPDATE trader_positions SET invalidation = NULL WHERE asset = 'USDC'").run();
    } });
    const ok = runCopy(bare);
    expect(ok.stdout).toContain("USDC : dernier prix 0,87 €");
    expect(ok.stdout).toContain("ni stop ni vente en attente : l'ancienne version ne la vendra pas seule");
    expect(ok.stdout).not.toMatch(/ÉCHEC : USDC/);
  });

  it("refuses under 1 cent, between 0.005 and 0.01 EUR too, and no GO lifts it", () => {
    for (const p of [0.0048874425, 0.0075]) {
      const file = copy({ paused: true, extra: (db) => trade(db, 3, "PUMP", p, buy(50, p)) });
      const r = runCopy(file, ["--accepter-arrondi", "PUMP"]);
      expect(r.status, r.stdout).toBe(1);
      expect(r.stdout).toMatch(/ÉCHEC : PUMP : dernier prix 0,00\d+ € .*sous 1 centime/);
      expect(r.stdout).toContain("Aucun GO ne lève ce point");
    }
  });

  it("refuses a position without any stored price", () => {
    const file = copy({ paused: true, extra: (db) => {
      trade(db, 3, "PUMP", 2.5, buy(50, 2.5));
      db.raw.prepare("DELETE FROM trader_prices WHERE asset = 'PUMP'").run();
    } });
    const r = runCopy(file);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain("ÉCHEC : position PUMP sans aucun prix enregistré");
    expect(r.last).toContain("positions_sans_prix=1 ");
  });

  it("refuses data the gate blocks: an infinite quantity, a zero average cost, a ledger row without its position", () => {
    const at = isoSeconds(hours(4));
    const cases: [string, (db: AutomatonDatabase) => void, RegExp][] = [
      ["infinite", (db) => {
        db.raw.prepare("INSERT INTO trader_ledger (id, at, kind, asset, quantity, price, amount_eur, fee_eur, order_id, note) VALUES ('l_x', ?, 'buy', 'ETH', 9e999, 0, -50, 0.4, 'o_x', NULL)").run(at);
        db.raw.prepare("INSERT INTO trader_positions (asset, quantity, avg_cost, opened_at, open_order_id, invalidation, horizon_until, thesis, updated_at) VALUES ('ETH', 9e999, 0, ?, 'o_x', NULL, NULL, ?, ?)").run(at, THESIS, at);
        storePrice(db, "ETH", hours(4), 2_500);
      }, /position ouverte invalide \(ETH\)/],
      ["zero cost", (db) => db.raw.prepare("UPDATE trader_positions SET avg_cost = 0 WHERE asset = 'BTC'").run(), /position ouverte invalide \(BTC\)/],
      ["ghost ledger row", (db) => {
        db.raw.prepare("INSERT INTO trader_ledger (id, at, kind, asset, quantity, price, amount_eur, fee_eur, order_id, note) VALUES ('l_ghost', ?, 'buy', 'ETH', 10, 2500, -25000, 0, 'o_ghost', NULL)").run(at);
        storePrice(db, "ETH", hours(4), 2_500);
      }, /ETH/],
    ];
    for (const [name, mutate, expected] of cases) {
      const r = runCopy(copy({ paused: true, extra: mutate }));
      expect(r.status, `${name}\n${r.stdout}`).toBe(1);
      expect(r.stdout, name).toMatch(/ÉCHEC : \d+ anomalie\(s\) BLOQUANT du contrôle avant déploiement/);
      expect(r.stdout, name).toMatch(expected);
      expect(r.last, name).toMatch(/bloquants=[1-9]/);
    }
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
    // Recorded (R3) before the old version starts (R6, --depuis hours(5)).
    setKV(db.raw, "money_lab.paused", JSON.stringify({ at: hours(4.5).toISOString(), reason: "retour arrière", by: "operator" }));
    extra?.(db);
    expect(fs.existsSync(`${file}-wal`) && fs.existsSync(`${file}-shm`)).toBe(true);
    return { home, db, file };
  }
  const counts = (db: AutomatonDatabase) => db.raw.prepare("SELECT (SELECT COUNT(*) FROM trader_orders) AS o, (SELECT COUNT(*) FROM kv) AS k").get();
  const since = (n: number) => ["--en-marche", "--depuis", hours(n).toISOString()];

  it("passes when nothing was bought or sold at risk since the start, and writes nothing", () => {
    const { home, db } = live();
    const before = counts(db);
    const r = run(since(5), home);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("OK : aucun achat passé ni exécuté depuis le 07/10/2026 13:00 UTC");
    expect(r.stdout).toContain("OK : aucune vente sous 1 € sans ton accord depuis le 07/10/2026 13:00 UTC");
    expect(r.stdout).toContain("Conclusion : la pause tient");
    expect(r.last).toBe("RÉSULTAT : code=0 pause=oui achats_en_attente=0 ventes_a_risque=0 positions_sans_prix=0 bloquants=0 achats_depuis=0 ventes_depuis=0");
    expect(counts(db)).toEqual(before);
  });

  it("fails and says to stop Sonni when a buy was placed and filled since the start", () => {
    const { home } = live((db) => trade(db, 6, "BTC", 61_000, buy(50, 61_000)));
    const r = run(since(5), home);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain("ÉCHEC : 1 achat(s) depuis le 07/10/2026 13:00 UTC : arrête Sonni tout de suite (systemctl stop sonni)");
    expect(r.stdout).toMatch(/achat de BTC passé le 07\/10\/2026 14:00 UTC/);
    expect(r.stdout).toMatch(/achat de BTC exécuté le 07\/10\/2026 14:06 UTC à 61\s0\d\d,\d\d €/);
    expect(r.last).toContain("achats_depuis=1 ");
  });

  it("counts a buy placed before the start and filled after it", () => {
    const { home } = live((db) => {
      place(db, 4, "BTC", 61_000, { side: "buy", amountEur: 50, invalidation: 44_000 });
      storePrice(db, "BTC", hours(6), 61_000);
      expect(brokerTick(db.raw, TRADER, hours(6)).fills.length).toBe(1);
    });
    const r = run(since(5), home);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toMatch(/achat de BTC exécuté le 07\/10\/2026 14:00 UTC/);
    expect(r.stdout).not.toMatch(/achat de BTC passé le/);
    expect(r.last).toContain("achats_depuis=1 ");
  });

  it("fails on a sale under 1 EUR since the start (a stop of the old broker), unless the GO named the asset", () => {
    const { home } = live((db) => {
      usdc(db);
      trade(db, 6, "USDC", 0.86, { side: "sell", quantity: "all" });
    });
    let r = run([...since(5), "--accepter-arrondi", "USDC"], home);
    expect(r.stdout).toMatch(/vente de USDC exécutée le 07\/10\/2026 14:06 UTC à 0,8\d+ €/);
    expect(r.last).toContain("ventes_depuis=0");
    r = run(since(5), home);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain("ÉCHEC : 1 vente(s) sous 1 € depuis le 07/10/2026 13:00 UTC");
    expect(r.last).toContain("ventes_depuis=1");
  });

  it("fails when the pause was lifted, then set again after the start", () => {
    const { home } = live((db) => setKV(db.raw, "money_lab.paused", JSON.stringify({ at: hours(6).toISOString(), reason: "remise", by: "operator" })));
    const r = run(since(5), home);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain("après le démarrage du 07/10/2026 13:00 UTC : elle a été levée puis remise");
  });

  it("fails when the pause was lifted while the old version runs", () => {
    const { home } = live((db) => db.raw.prepare("DELETE FROM kv WHERE key = 'money_lab.paused'").run());
    const r = run(since(5), home);
    expect(r.status, r.stdout).toBe(1);
    expect(r.last).toContain("pause=non");
  });

  it("requires --depuis, refuses a start in the future or too recent, and opens nothing when Sonni does not run", () => {
    const { home } = live();
    let r = run(["--en-marche"], home);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--en-marche demande --depuis");
    r = run(["--en-marche", "--depuis", new Date(Date.now() + 3_600_000).toISOString()], home);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("est dans le futur");
    r = run(["--en-marche", "--depuis", new Date(Date.now() - 60_000).toISOString()], home);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Trop tôt");
    const stopped = tmp("sonni-pause-stopped-");
    fs.mkdirSync(path.join(stopped, ".automaton"));
    const file = path.join(stopped, ".automaton", "state.db");
    const db = openDb(file);
    fill(db);
    db.close();
    r = run(since(5), stopped);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Sonni ne semble pas tourner");
    expect(fs.existsSync(`${file}-wal`) || fs.existsSync(`${file}-shm`)).toBe(false);
  });
});

describe("Pause check: refusals and errors", () => {
  it("refuses usage errors with exit 2 and reads nothing", () => {
    const file = copy({ paused: true });
    for (const args of [[], ["--copie"], ["--copie", file, "--en-marche"], ["--copie", file, "--depuis", "2026-10-07T13:00:00Z"],
      ["--en-marche", "--depuis", "hier"], ["--inconnue"], ["--copie", file, "--accepter-arrondi", "usdc;rm"]]) {
      const r = run(args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.last).toBe(RESULT_UNKNOWN);
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
