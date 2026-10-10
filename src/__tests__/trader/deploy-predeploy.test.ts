/**
 * Controlled deployment of 2026-10-10: the pre-deployment gate (sonni/vps/controle-predeploiement.mjs). It reads a
 * closed copy of Sonni's memory, classifies what it finds (BLOQUANT, À DÉCIDER, INFO) and predicts what the first
 * broker tick would do. The script runs as the owner runs it, in a child process with a temporary HOME and
 * TMPDIR; every run checks that the copy is byte for byte unchanged and that no temporary folder is left. The
 * fidelity tests run the REAL brokerTick on the same copies and compare it with the script's prediction, order by
 * order. No network, no inference.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import Database from "better-sqlite3";
import { createDatabase } from "../../state/database.js";
import { ensureMoneyLabSchema, setKV } from "../../money-lab/journal.js";
import type { AutomatonDatabase } from "../../types.js";
import { parseTraderConfig, type TraderConfig } from "../../trader/config.js";
import { ensureTraderSchema } from "../../trader/schema.js";
import { isoSeconds } from "../../trader/prices.js";
import { brokerTick, placeOrder } from "../../trader/portfolio.js";
// @ts-expect-error plain ESM script without type declarations (tests are not type-checked)
import { predictPendingOrders, predictStops, resume } from "../../../sonni/vps/controle-predeploiement.mjs";
// @ts-expect-error plain ESM script without type declarations
import { openPrivateCopy } from "../../../sonni/vps/copie-privee.mjs";

const ROOT = path.join(__dirname, "..", "..", "..");
const SCRIPT = path.join(ROOT, "sonni", "vps", "controle-predeploiement.mjs");
const EXAMPLE = JSON.parse(fs.readFileSync(path.join(ROOT, "sonni", "automaton.sonni.example.json"), "utf-8"));
EXAMPLE.trader.assets = [
  ["BTC", "XBTEUR"], ["ETH", "ETHEUR"], ["USDC", "USDCEUR"], ["SPY", "SPYXEUR"], ["ADA", "ADAEUR"], ["MID", "MIDEUR"],
  ["PUMP", "PUMPEUR"], ["PEPE", "PEPEEUR"], ["TINY", "TINYEUR"],
].map(([symbol, krakenPair]) => ({ symbol, krakenPair }));
const TRADER: TraderConfig = parseTraderConfig(EXAMPLE.trader)!;
const T0 = new Date("2026-10-07T08:00:00Z");
const hours = (n: number) => new Date(T0.getTime() + n * 3_600_000);
/** The moment the clean copy is checked: its last prices are 3 minutes old. */
const NOW = hours(10);
const THESIS = "Test du contrôle avant déploiement : position modeste pour donner au courtier virtuel un état réaliste.";
const COPY = "state.db.predeploiement-20261007T180000Z";

let tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
beforeEach(() => { tmpDirs = []; });
afterEach(() => { for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true }); });

function openDb(file: string): AutomatonDatabase {
  const db = createDatabase(file);
  ensureMoneyLabSchema(db.raw);
  ensureTraderSchema(db.raw);
  return db;
}
function storePrice(db: AutomatonDatabase, asset: string, at: Date, price: number) {
  db.raw.prepare("INSERT INTO trader_prices (asset, ts, price, source) VALUES (?, ?, ?, 'test')").run(asset, isoSeconds(at), price);
}
/** Places an order at hour `at` on a fresh price; returns its id. */
function place(db: AutomatonDatabase, at: number, asset: string, price: number, order: Record<string, unknown>): string {
  storePrice(db, asset, hours(at), price);
  const placed = placeOrder(db.raw, TRADER, { asset, thesis: THESIS, ...order } as any, hours(at));
  expect(placed.ok, JSON.stringify(placed)).toBe(true);
  return (placed as { ok: true; value: { id: string } }).value.id;
}
/** Places an order at hour `at`, then fills it at the next stored price `fillAt` (default the same). */
function trade(db: AutomatonDatabase, at: number, asset: string, price: number, order: Record<string, unknown>, fillAt = price) {
  place(db, at, asset, price, order);
  storePrice(db, asset, hours(at + 0.1), fillAt);
  const out = brokerTick(db.raw, TRADER, hours(at + 0.1));
  expect(out.fills.length + out.stops.length, JSON.stringify(out.rejected)).toBeGreaterThan(0);
  return out;
}
const buy = (amountEur: number, price: number) => ({ side: "buy", amountEur, invalidation: price * 0.7 });
const sellAll = { side: "sell", quantity: "all" };

/** A pending or settled order written directly, as an old broker or a legacy row could have left it. */
function rawOrder(db: Database.Database | AutomatonDatabase, o: {
  id: string; at: Date; asset: string; side: "buy" | "sell"; kind?: "market" | "limit"; amountEur?: number | null; quantity?: number | null;
  limitPrice?: number | null; invalidation?: number | null; horizonUntil?: Date; origin?: "model" | "stop" | "owner"; status?: string;
  settledAt?: string | null; fillPrice?: number | null; fillQuantity?: number | null; fillEur?: number | null; feeEur?: number | null;
}) {
  const raw = "raw" in db ? db.raw : db;
  raw.prepare(
    `INSERT INTO trader_orders (id, placed_at, asset, side, kind, amount_eur, quantity, limit_price, thesis, probability, invalidation, horizon_until,
       hypothesis_ids, origin, status, settled_at, fill_price, fill_quantity, fill_eur, fee_eur, slippage_eur, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
  ).run(o.id, o.at.toISOString(), o.asset, o.side, o.kind ?? "market", o.amountEur ?? null, o.quantity ?? null, o.limitPrice ?? null, THESIS,
    o.invalidation ?? null, isoSeconds(o.horizonUntil ?? new Date(o.at.getTime() + 7 * 86_400_000)), o.origin ?? "model", o.status ?? "pending",
    o.settledAt ?? null, o.fillPrice ?? null, o.fillQuantity ?? null, o.fillEur ?? null, o.feeEur ?? null);
}
function rawPrice(db: Database.Database, asset: string, at: Date, price: number) {
  db.prepare("INSERT INTO trader_prices (asset, ts, price, source) VALUES (?, ?, ?, 'test')").run(asset, isoSeconds(at), price);
}

/**
 * A copy written by the new broker: capital, BTC and USDC positions with their stops (USDC averaged from two
 * buys), an ETH round trip, a BTC limit buy waiting below the market, fresh prices 3 minutes before NOW.
 */
function cleanCopy(): string {
  const file = path.join(tmp("sonni-controle-"), COPY);
  const db = openDb(file);
  storePrice(db, "BTC", T0, 60_000);
  brokerTick(db.raw, TRADER, T0);
  trade(db, 1, "BTC", 60_000, buy(200, 60_000));
  trade(db, 2, "USDC", 0.86, buy(100, 0.86));
  trade(db, 3, "USDC", 0.869, buy(50, 0.869));
  trade(db, 4, "ETH", 2_500, buy(100, 2_500));
  trade(db, 5, "ETH", 2_600, sellAll);
  place(db, 9.9, "BTC", 61_000, { side: "buy", kind: "limit", limitPrice: 55_000, amountEur: 50, invalidation: 44_000 });
  storePrice(db, "BTC", hours(9.95), 61_000);
  storePrice(db, "USDC", hours(9.95), 0.87);
  brokerTick(db.raw, TRADER, hours(9.95));
  db.close();
  return file;
}

/** The clean copy changed by `mutate` through a plain writable connection (closed before the check). */
function variant(mutate: (db: Database.Database) => void): string {
  const file = cleanCopy();
  const db = new Database(file);
  mutate(db);
  db.close();
  expect(fs.existsSync(`${file}-wal`)).toBe(false);
  return file;
}

const sha = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** Runs the gate as the owner would; checks the copy is untouched, no -wal/-shm appeared and no temporary folder is left. */
function run(file: string, args: string[] = [], opts: { home?: string; now?: Date | null } = {}) {
  const home = opts.home ?? tmp("sonni-controle-home-");
  const tmpRoot = tmp("sonni-controle-tmp-");
  const before = fs.existsSync(file) ? sha(file) : null;
  const when = opts.now === null ? [] : ["--maintenant", (opts.now ?? NOW).toISOString()];
  const r = spawnSync(process.execPath, [SCRIPT, file, ...when, ...args], { encoding: "utf-8", env: { ...process.env, HOME: home, TMPDIR: tmpRoot } });
  if (before !== null) expect(sha(file)).toBe(before);
  expect(fs.existsSync(`${file}-wal`) || fs.existsSync(`${file}-shm`)).toBe(false);
  expect(fs.readdirSync(tmpRoot)).toEqual([]);
  const last = r.stdout.trimEnd().split("\n").pop() ?? "";
  expect(last, r.stdout + r.stderr).toMatch(/^RÉSULTAT : code=\d+ /);
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, last };
}
const counts = (last: string) => {
  const m = /bloquants=(\d+) a_decider=(\d+) infos=(\d+)/.exec(last);
  return m ? { b: Number(m[1]), d: Number(m[2]), i: Number(m[3]) } : null;
};

describe("Pre-deployment gate (sonni/vps/controle-predeploiement.mjs): verdicts", () => {
  it("lets a clean copy written by the new broker through: exit 0, nothing blocks, copy unchanged", () => {
    const file = cleanCopy();
    const r = run(file);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("Contrôle avant déploiement — copie en lecture seule");
    for (const title of ["A. Intégrité", "B. Fraîcheur de la copie", "C. Audit des prix", "D. Rapprochement du portefeuille", "E. Ordres en attente",
      "F. Stops et protections", "G. Redémarrage et coûts", "H. Historique"]) expect(r.stdout).toContain(title);
    expect(r.stdout).toContain("[INFO] contrôle d'intégrité SQLite : ok");
    expect(r.stdout).toContain("registre, positions, ordres et opérations concordent");
    expect(r.stdout).toMatch(/\[INFO\] o_\w+ : achat à cours limité BTC passé le 07\/10\/2026 17:54 UTC : attend que le prix atteigne 55\s000,00 €/);
    expect(r.stdout).toMatch(/\[INFO\] BTC : stop à 42\s000,00 €, 31,15 % sous le dernier prix/);
    expect(r.stdout).toContain("Conclusion : rien ne bloque, le déploiement peut continuer.");
    expect(r.stdout).toContain("Fichier contrôlé inchangé (SHA-256 identique avant et après).");
    expect(counts(r.last)).toMatchObject({ b: 0, d: 0 });
    expect(r.last).toMatch(/^RÉSULTAT : code=0 bloquants=0 a_decider=0 infos=\d+$/);
    expect(r.stdout).not.toMatch(/NaN|Infinity|undefined/);
  });

  const BLOCKERS: [string, (db: Database.Database) => void, RegExp][] = [
    ["an Infinity or zero position left by the old broker", (db) => {
      const at = isoSeconds(hours(6));
      db.prepare("INSERT INTO trader_ledger (id, at, kind, asset, quantity, price, amount_eur, fee_eur, order_id, note) VALUES ('l_pump', ?, 'buy', 'PUMP', 9e999, 0, -100, 0.8, 'o_pump', NULL)").run(at);
      db.prepare("INSERT INTO trader_positions (asset, quantity, avg_cost, opened_at, open_order_id, invalidation, horizon_until, thesis, updated_at) VALUES ('PUMP', 9e999, 0, ?, 'o_pump', NULL, NULL, ?, ?)").run(at, THESIS, at);
      db.prepare("INSERT INTO trader_ledger (id, at, kind, asset, quantity, price, amount_eur, fee_eur, order_id, note) VALUES ('l_tiny', ?, 'buy', 'TINY', 1000, 0, -10, 0.08, 'o_tiny', NULL)").run(at);
      db.prepare("INSERT INTO trader_positions (asset, quantity, avg_cost, opened_at, open_order_id, invalidation, horizon_until, thesis, updated_at) VALUES ('TINY', 1000, 0, ?, 'o_tiny', NULL, NULL, ?, ?)").run(at, THESIS, at);
    }, /\[BLOQUANT\] 2 positions ouvertes invalides \(PUMP, TINY\) : la nouvelle version suspend les achats, les décisions et les instantanés et ne pose aucun stop sur elle/],
    ["negative cash", (db) => {
      db.prepare("INSERT INTO trader_ledger (id, at, kind, asset, quantity, price, amount_eur, fee_eur, order_id, note) VALUES ('l_neg', ?, 'contribution', NULL, NULL, NULL, -5000, 0, NULL, 'test')").run(isoSeconds(hours(6)));
    }, /\[BLOQUANT\] liquidités négatives : -4\s\d{3},\d\d € d'après le registre/],
    ["a position the ledger does not add up to", (db) => {
      db.prepare("UPDATE trader_positions SET quantity = quantity + 0.5 WHERE asset = 'BTC'").run();
    }, /\[BLOQUANT\] position BTC : 0,50\d+ unités enregistrées, le registre en donne 0,00\d+ \(écart -0,5\)/],
    ["a filled order without its ledger row", (db) => {
      rawOrder(db, { id: "o_sans_registre", at: hours(6), asset: "BTC", side: "buy", amountEur: 50, status: "filled", settledAt: isoSeconds(hours(6.1)), fillPrice: 60_030, fillQuantity: 0.00082624, fillEur: 50, feeEur: 0.4 });
    }, /\[BLOQUANT\] 1 ordre exécuté sans exactement une ligne d'achat ou de vente au registre : o_sans_registre \(achat BTC le 07\/10\/2026 14:06 UTC, 0 ligne\)/],
    ["a trade closed by an order that is not filled", (db) => {
      db.prepare(`INSERT INTO trader_trades (id, asset, opened_at, closed_at, quantity, entry_price, exit_price, fees_eur, pnl_eur, pnl_pct, open_order_id, close_order_id, close_reason, thesis)
        VALUES ('t_orphelin', 'SPY', ?, ?, 1, 500, 510, 8, 2, 0.4, 'o_spy_ouverture', 'o_absent', 'model', ?)`).run(isoSeconds(hours(6)), isoSeconds(hours(7)), THESIS);
    }, /\[BLOQUANT\] 1 opération close par un ordre qui n'est pas exécuté : t_orphelin \(SPY le 07\/10\/2026 15:00 UTC, ordre o_absent introuvable\)/],
  ];

  for (const [name, mutate, expected] of BLOCKERS) {
    it(`blocks on ${name} (exit 1), and --accepter-a-decider does not lift it`, () => {
      const file = variant(mutate);
      const r = run(file);
      expect(r.status, r.stdout + r.stderr).toBe(1);
      expect(r.stdout).toMatch(expected);
      expect(r.stdout).toContain("Déploiement bloqué : envoie ce rapport au propriétaire et attends sa décision");
      expect(counts(r.last)!.b).toBeGreaterThan(0);
      const accepted = run(file, ["--accepter-a-decider"]);
      expect(accepted.status).toBe(1);
      expect(accepted.stdout).toMatch(expected);
      expect(accepted.last).toMatch(/^RÉSULTAT : code=1 bloquants=[1-9]/);
    });
  }

  it("blocks on a failed integrity check of a damaged page, without touching the copy", () => {
    const file = variant((db) => {
      db.exec("CREATE TABLE controle_test (x TEXT); CREATE INDEX idx_controle_test ON controle_test (x);");
      const insert = db.prepare("INSERT INTO controle_test (x) VALUES (?)");
      for (let i = 0; i < 40; i++) insert.run(`valeur-${i}`);
    });
    const db = new Database(file, { readonly: true });
    const root = (db.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'idx_controle_test'").get() as { rootpage: number }).rootpage;
    const pageSize = db.pragma("page_size", { simple: true }) as number;
    db.close();
    for (const ext of ["-wal", "-shm"]) fs.rmSync(`${file}${ext}`, { force: true });
    const fd = fs.openSync(file, "r+");
    fs.writeSync(fd, Buffer.alloc(pageSize, 0), 0, pageSize, (root - 1) * pageSize);
    fs.closeSync(fd);
    const r = run(file, ["--accepter-a-decider"]);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toMatch(/\[BLOQUANT\] contrôle d'intégrité SQLite en échec \(\d+ problèmes?\)/);
    expect(r.stdout).toContain("Déploiement bloqué");
  });

  const DECISIONS: [string, (db: Database.Database) => void, RegExp][] = [
    ["an averaged position whose stored cost drifts by a cent or more", (db) => {
      db.prepare("UPDATE trader_positions SET avg_cost = 0.86 WHERE asset = 'USDC'").run();
    }, /\[À DÉCIDER\] USDC : coût moyen enregistré 0,86 € contre 0,8\d+ € d'après le registre, écart -0,\d\d € sur la position : écart historique d'arrondi, aucune réparation automatique/],
    ["market fills further than 0.5 % from the market", (db) => {
      rawPrice(db, "ADA", hours(6), 0.403);
      rawOrder(db, { id: "o_ada_ancien", at: hours(5.9), asset: "ADA", side: "buy", amountEur: 40, status: "filled", settledAt: isoSeconds(hours(6)), fillPrice: 0.4, fillQuantity: 99.2, fillEur: 40, feeEur: 0.32 });
      db.prepare("INSERT INTO trader_ledger (id, at, kind, asset, quantity, price, amount_eur, fee_eur, order_id, note) VALUES ('l_ada', ?, 'buy', 'ADA', 99.2, 0.4, -40, 0.32, 'o_ada_ancien', NULL)").run(isoSeconds(hours(6)));
    }, /\[À DÉCIDER\] ADA : 1 exécution au marché à plus de 0,5 % du prix du marché \(jusqu'à 0,74 %, dix fois le glissement configuré\)/],
    ["a pending sell the broker rejects (nothing to sell)", (db) => {
      rawOrder(db, { id: "o_vente_vide", at: hours(9), asset: "ETH", side: "sell", quantity: 0.04 });
      rawPrice(db, "ETH", hours(9.5), 2_700);
    }, /\[À DÉCIDER\] o_vente_vide : vente au marché ETH passé le 07\/10\/2026 17:00 UTC : refusé \(rien à vendre\)/],
    ["a pending market order that expires", (db) => {
      rawOrder(db, { id: "o_expire", at: hours(-20), asset: "SPY", side: "buy", amountEur: 30 });
    }, /\[À DÉCIDER\] o_expire : achat au marché SPY passé le 06\/10\/2026 12:00 UTC : expiré \(aucun prix enregistré dans les 24 h suivant l'ordre\)/],
    ["a pending order filled at an old stored price", (db) => {
      rawOrder(db, { id: "o_prix_ancien", at: hours(5), asset: "ADA", side: "buy", amountEur: 20, invalidation: 0.3 });
      rawPrice(db, "ADA", hours(5.1), 0.4);
    }, /\[À DÉCIDER\] o_prix_ancien : achat au marché ADA .* exécuté au prix enregistré du 07\/10\/2026 13:06 UTC \(0,4 € ; prix d'exécution 0,4002 €\) : exécution à un prix ancien du 07\/10\/2026 13:06 UTC \(il y a 4 h 54\)/],
    ["a position without a stop", (db) => {
      db.prepare("UPDATE trader_positions SET invalidation = NULL WHERE asset = 'BTC'").run();
    }, /\[À DÉCIDER\] BTC : position sans stop \(aucun niveau d'invalidation, aucune vente en attente\)/],
    ["a stop already crossed by the last known price", (db) => {
      db.prepare("UPDATE trader_positions SET invalidation = 70000 WHERE asset = 'BTC'").run();
    }, /\[À DÉCIDER\] BTC : stop franchi d'après le dernier prix connu \(61\s000,00 € le 07\/10\/2026 17:57 UTC\) : vente au premier relevé si le prix reste sous 70\s000,00 € ; prix frais \(il y a 3 min\) : la nouvelle version pose le stop dès le premier relevé/],
  ];

  for (const [name, mutate, expected] of DECISIONS) {
    it(`asks the owner about ${name}: exit 1, then exit 0 with --accepter-a-decider`, () => {
      const file = variant(mutate);
      const r = run(file);
      expect(r.status, r.stdout + r.stderr).toBe(1);
      expect(r.stdout).toMatch(expected);
      expect(counts(r.last)).toMatchObject({ b: 0, d: 1 });
      expect(r.stdout).toContain("S'il accepte les points à décider, relance le contrôle avec --accepter-a-decider.");
      const accepted = run(file, ["--accepter-a-decider"]);
      expect(accepted.status, accepted.stdout).toBe(0);
      expect(accepted.stdout).toMatch(expected);
      expect(accepted.stdout).toContain("Conclusion : rien ne bloque (1 point à décider accepté par le propriétaire avec --accepter-a-decider).");
      expect(accepted.last).toMatch(/^RÉSULTAT : code=0 bloquants=0 a_decider=1 infos=\d+$/);
    });
  }

  it("never lets --accepter-a-decider lift a BLOQUANT next to points to decide", () => {
    const file = variant((db) => {
      db.prepare("UPDATE trader_positions SET invalidation = NULL WHERE asset = 'BTC'").run();
      db.prepare("INSERT INTO trader_ledger (id, at, kind, asset, quantity, price, amount_eur, fee_eur, order_id, note) VALUES ('l_neg', ?, 'contribution', NULL, NULL, NULL, -5000, 0, NULL, 'test')").run(isoSeconds(hours(6)));
    });
    const r = run(file, ["--accepter-a-decider"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("L'option --accepter-a-decider ne lève jamais un point bloquant.");
    expect(counts(r.last)).toMatchObject({ b: 1, d: 1 });
  });

  it("refuses the live database, a file beside -wal/-shm, a missing file and bad options (exit 2, nothing read)", () => {
    const dir = tmp("sonni-controle-refus-");
    const live = path.join(dir, "state.db");
    openDb(live).close();
    const r1 = run(live);
    expect(r1.status).toBe(2);
    expect(r1.stderr).toContain("Refusé : c'est la base active de Sonni");
    expect(r1.last).toBe("RÉSULTAT : code=2 controle=refusé");
    const copy = path.join(dir, "copie.db");
    fs.copyFileSync(live, copy);
    fs.writeFileSync(`${copy}-wal`, "");
    const tmpRoot = tmp("sonni-controle-tmp-");
    const r2 = spawnSync(process.execPath, [SCRIPT, copy], { encoding: "utf-8", env: { ...process.env, HOME: tmp("sonni-controle-home-"), TMPDIR: tmpRoot } });
    expect(r2.status).toBe(2);
    expect(r2.stderr).toContain("un fichier -wal ou -shm est à côté");
    expect(fs.readdirSync(tmpRoot)).toEqual([]);
    fs.rmSync(`${copy}-wal`);
    const home = tmp("sonni-controle-home-");
    fs.mkdirSync(path.join(home, ".automaton"));
    fs.copyFileSync(live, path.join(home, ".automaton", "state.db"));
    const linked = path.join(dir, "lien.db");
    fs.linkSync(path.join(home, ".automaton", "state.db"), linked);
    const r3 = run(linked, [], { home });
    expect(r3.status).toBe(2);
    expect(r3.stderr).toContain("Refusé : c'est la base active de Sonni");
    expect(run(path.join(dir, "absent.db")).status).toBe(2);
    const file = cleanCopy();
    const bad = [
      [["--maintenant", "demain"], "Date invalide pour --maintenant"],
      [["--inconnue"], "Option inconnue : --inconnue"],
      [["--config", path.join(dir, "absente.json")], "Configuration illisible (fichier introuvable)"],
      [["--config"], "Valeur manquante après --config"],
      [["autre.db"], "Un seul fichier à contrôler"],
    ] as const;
    for (const [args, message] of bad) {
      const r = run(file, [...args], { now: null });
      expect(r.status, r.stdout).toBe(2);
      expect(r.stderr).toContain(message);
    }
    const tmpRoot2 = tmp("sonni-controle-tmp-");
    const none = spawnSync(process.execPath, [SCRIPT], { encoding: "utf-8", env: { ...process.env, HOME: home, TMPDIR: tmpRoot2 } });
    expect(none.status).toBe(2);
    expect(none.stderr).toContain("Fichier manquant.");
  });

  it("never prints the configuration's contents when it is not valid JSON", () => {
    const file = cleanCopy();
    const config = path.join(tmp("sonni-controle-config-"), "automaton.json");
    fs.writeFileSync(config, '{ "moneyLab": { "telegram": { "token": "123456:SECRET-JETON-A-NE-JAMAIS-AFFICHER" } ', "utf-8");
    const r = run(file, ["--config", config]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Configuration illisible (JSON invalide)");
    expect(r.stdout + r.stderr).not.toContain("SECRET");
  });

  it("stops with exit 3 on a file that is not SQLite or not Sonni's memory", () => {
    const dir = tmp("sonni-controle-tech-");
    const text = path.join(dir, "notes.txt");
    fs.writeFileSync(text, "ceci n'est pas une base de données\n".repeat(20));
    const r1 = run(text);
    expect(r1.status).toBe(3);
    expect(r1.stderr).toContain("Ce fichier n'est pas une base SQLite.");
    expect(r1.last).toBe("RÉSULTAT : code=3 controle=impossible");
    const other = path.join(dir, "autre.db");
    const db = new Database(other);
    db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, texte TEXT); INSERT INTO notes (texte) VALUES ('bonjour');");
    db.close();
    const r2 = run(other);
    expect(r2.status).toBe(3);
    expect(r2.stderr).toContain("Ce n'est pas une copie de la mémoire de Sonni");
  });

  it("prints a short report for Telegram with --resume (at most 3,500 characters)", () => {
    const file = variant((db) => {
      const insert = db.prepare("INSERT INTO trader_positions (asset, quantity, avg_cost, opened_at, open_order_id, invalidation, horizon_until, thesis, updated_at) VALUES (?, 1, 1, ?, ?, NULL, NULL, ?, ?)");
      for (let i = 0; i < 150; i++) insert.run(`Z${String(i).padStart(3, "0")}`, isoSeconds(hours(6)), `o_z${i}`, THESIS, isoSeconds(hours(6)));
    });
    const full = run(file);
    expect(full.status).toBe(1);
    expect(counts(full.last)).toMatchObject({ b: 150, d: 150 });
    const r = run(file, ["--resume"]);
    expect(r.status).toBe(1);
    expect(r.stdout.length).toBeLessThanOrEqual(3_500);
    expect(r.stdout).toMatch(/^Contrôle avant déploiement de Sonni : déploiement bloqué\n/);
    expect(r.stdout).toContain("Bloquants : 150 ; à décider : 150 ;");
    expect(r.stdout).toContain("BLOQUANT :\n- position Z000 : 1 unités enregistrées, le registre en donne 0");
    expect(r.stdout).toMatch(/… et \d+ autre\(s\) ligne\(s\) : rapport complet dans le terminal/);
    expect(r.stdout).not.toContain("A. Intégrité");
    expect(r.last).toBe("RÉSULTAT : code=1 bloquants=150 a_decider=150 infos=" + counts(full.last)!.i);
    const clean = run(cleanCopy(), ["--resume"]);
    expect(clean.status).toBe(0);
    expect(clean.stdout).toMatch(/^Contrôle avant déploiement de Sonni : rien ne bloque\n/);
    expect(clean.stdout.length).toBeLessThanOrEqual(3_500);
    // The cut also holds for a few very long lines.
    const long = resume(Array.from({ length: 40 }, (_, i) => ({ level: "D", text: `${i} ${"x".repeat(400)}` })), { file, now: NOW, accept: false, code: 1 });
    expect(long.length).toBeLessThanOrEqual(3_500);
  });

  it("reads staleMinutes from --config, else from ~/.automaton/automaton.json, else 15 min with a note", () => {
    const file = variant((db) => {
      db.prepare("UPDATE trader_positions SET invalidation = 70000 WHERE asset = 'BTC'").run();
    });
    const later = new Date(NOW.getTime() + 27 * 60_000); // the last BTC price is then 30 min old
    const byDefault = run(file, [], { now: later });
    expect(byDefault.stdout).toContain("[INFO] aucune configuration lisible");
    expect(byDefault.stdout).toContain("prix jugé ancien après 15 min (valeur par défaut)");
    expect(byDefault.stdout).toContain("prix ancien (il y a 30 min, au-delà de 15 min) : le stop sera posé dès qu'un prix frais arrive, s'il reste sous le niveau");
    const config = path.join(tmp("sonni-controle-config-"), "automaton.json");
    fs.writeFileSync(config, JSON.stringify({ ...EXAMPLE, trader: { ...EXAMPLE.trader, staleMinutes: 60 } }), "utf-8");
    const explicit = run(file, ["--config", config], { now: later });
    expect(explicit.stdout).toContain(`[INFO] configuration lue : ${config} (prix jugé ancien après 60 min)`);
    expect(explicit.stdout).toContain("prix frais (il y a 30 min) : la nouvelle version pose le stop dès le premier relevé");
    const home = tmp("sonni-controle-home-");
    fs.mkdirSync(path.join(home, ".automaton"));
    fs.writeFileSync(path.join(home, ".automaton", "automaton.json"), JSON.stringify({ ...EXAMPLE, trader: { ...EXAMPLE.trader, staleMinutes: 45 } }), "utf-8");
    const implicit = run(file, [], { now: later, home });
    expect(implicit.stdout).toContain("(prix jugé ancien après 45 min)");
    expect(implicit.stdout).toContain("la nouvelle version pose le stop dès le premier relevé");
    // An asset no longer followed gets no stop: the configuration's list counts.
    const without = path.join(tmp("sonni-controle-config-"), "automaton.json");
    fs.writeFileSync(without, JSON.stringify({ ...EXAMPLE, trader: { ...EXAMPLE.trader, assets: [{ symbol: "ETH", krakenPair: "ETHEUR" }] } }), "utf-8");
    const unfollowed = run(file, ["--config", without]);
    expect(unfollowed.stdout).toContain("[À DÉCIDER] BTC : actif plus suivi d'après la configuration, aucun prix ne sera relevé et aucun stop ne peut être posé");
    expect(unfollowed.stdout).toContain("actif plus suivi : le stop ne peut pas être posé");
  });

  it("reports the restart rule, the pause, passed horizons and the monthly contribution (INFO)", () => {
    const file = variant((db) => {
      const kv = db.prepare("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
      kv.run("agent_state", "sleeping");
      kv.run("sleep_until", new Date(NOW.getTime() + 3 * 3_600_000).toISOString());
      kv.run("money_lab.paused", JSON.stringify({ at: NOW.toISOString(), reason: "budget du jour atteint", by: "runtime" }));
      kv.run("sonni.portfolio_month", "2026-09");
      db.prepare("UPDATE trader_positions SET horizon_until = ? WHERE asset = 'USDC'").run(isoSeconds(hours(9)));
    });
    const r = run(file);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("[INFO] Sonni reprendra son sommeil jusqu'au 07/10/2026 21:00 UTC : pas de cycle payé au redémarrage");
    expect(r.stdout).toContain("[INFO] Sonni est en pause (budget du jour atteint)");
    expect(r.stdout).toContain("[INFO] échéance de la position USDC passée (07/10/2026 17:00 UTC) : réveil payé pour revoir USDC");
    expect(r.stdout).toContain("[INFO] versement virtuel du mois au premier relevé (50,00 €, dernier mois versé : 2026-09)");
    const awake = run(cleanCopy());
    expect(awake.stdout).toMatch(/\[INFO\] le redémarrage lancera un cycle payé : Sonni n'était pas endormi, état enregistré : \S+/);
  });
});

/**
 * Fidelity: the prediction must be what the real broker does. Each scenario is built with the runtime's own
 * functions (placeOrder, brokerTick) plus raw rows an old broker could leave; the script's functions read a
 * read-only private copy, the REAL brokerTick runs on another copy, and both must agree for every pending order
 * (fill, reject with its reason, expire, wait) and for the stops placed.
 */
describe("Pre-deployment gate: predictions match the real brokerTick", () => {
  const T = hours(30);
  type Scenario = { name: string; build: (db: AutomatonDatabase) => Record<string, string>; stops: string[] };

  /** A funded portfolio with BTC, ETH, USDC, ADA and MID positions (stops at 70 % of the entry). */
  function portfolio(db: AutomatonDatabase) {
    storePrice(db, "BTC", T0, 60_000);
    brokerTick(db.raw, TRADER, T0);
    trade(db, 1, "BTC", 60_000, buy(150, 60_000));
    trade(db, 2, "ETH", 2_500, buy(100, 2_500));
    trade(db, 3, "USDC", 0.86, buy(100, 0.86));
    trade(db, 4, "ADA", 0.4, buy(60, 0.4));
    trade(db, 5, "MID", 12, buy(60, 12));
  }

  const scenarios: Scenario[] = [
    {
      name: "valid portfolio: fills, rejections, expiries, waits, a buy back after a sale, and stops after an expired sell, on an added buy and on a position opened by the tick",
      stops: ["BTC", "PEPE", "USDC"],
      build: (db) => {
        portfolio(db);
        const ids: Record<string, string> = {};
        ids[place(db, 2.5, "SPY", 500, { side: "buy", amountEur: 30, invalidation: 400 })] = "expire"; // no SPY price for 27.5 h
        ids[place(db, 10, "USDC", 0.87, { side: "sell", kind: "limit", limitPrice: 0.95, quantity: "all", horizonHours: 1 })] = "expire";
        // Adds to BTC: the order's level replaces the position's (42,000), and the last price is already under it.
        ids[place(db, 28, "BTC", 60_000, { side: "buy", kind: "limit", limitPrice: 58_000, amountEur: 50, invalidation: 57_950 })] = "fill";
        rawOrder(db, { id: "o_sol_vide", at: hours(28), asset: "SOL", side: "sell", quantity: 1 });
        storePrice(db, "SOL", hours(28.5), 150);
        ids.o_sol_vide = "reject:nothing";
        rawOrder(db, { id: "o_hugep", at: hours(28), asset: "HUGEP", side: "buy", amountEur: 10, invalidation: 1 });
        storePrice(db, "HUGEP", hours(28.5), 1e10);
        ids.o_hugep = "reject:quantity";
        rawOrder(db, { id: "o_doge_stop", at: hours(28), asset: "DOGE", side: "sell", quantity: 5, origin: "stop" });
        storePrice(db, "DOGE", hours(28.5), 0.1);
        ids.o_doge_stop = "reject:nothing";
        ids[place(db, 29, "ETH", 2_500, sellAll)] = "fill";
        ids[place(db, 29, "PEPE", 0.00001, { side: "buy", amountEur: 50, invalidation: 0.000008 })] = "fill";
        ids[place(db, 29, "ADA", 0.27, { side: "buy", kind: "limit", limitPrice: 0.2, amountEur: 20, invalidation: 0.15 })] = "wait";
        ids[place(db, 29, "MID", 12, { side: "sell", kind: "limit", limitPrice: 20, quantity: "all" })] = "wait";
        ids[place(db, 29.9, "TINY", 0.001, { side: "buy", amountEur: 20, invalidation: 0.0008 })] = "wait";
        // Bought back after the ETH sale fills in the same tick: the closed row (quantity 0) is opened again.
        ids[place(db, 29.5, "ETH", 2_550, { side: "buy", amountEur: 30, invalidation: 2_000 })] = "fill";
        storePrice(db, "ETH", hours(29.8), 2_560);
        storePrice(db, "ETH", hours(29.2), 2_550);
        storePrice(db, "PEPE", hours(29.9), 0.0000075); // fills the PEPE buy below its own stop level
        storePrice(db, "BTC", hours(29.95), 57_900); // crosses the BTC limit
        storePrice(db, "USDC", hours(29.95), 0.6); // under the USDC stop, fresh: the expired sell leaves room for the stop
        storePrice(db, "MID", hours(29.95), 8); // under the MID stop, fresh, but the MID limit sell is still pending
        // ADA: last price 0.27 at hour 29, under its 0.28 stop but 60 min old: stale, no stop.
        return ids;
      },
    },
    {
      name: "corrupt legacy positions: buys suspended, the corrupt position's sale rejected, other sales and stops still work",
      stops: ["USDC"],
      build: (db) => {
        storePrice(db, "BTC", T0, 60_000);
        brokerTick(db.raw, TRADER, T0);
        trade(db, 1, "BTC", 60_000, buy(150, 60_000));
        trade(db, 2, "USDC", 0.86, buy(100, 0.86));
        const at = isoSeconds(hours(3));
        db.raw.prepare("INSERT INTO trader_ledger (id, at, kind, asset, quantity, price, amount_eur, fee_eur, order_id, note) VALUES ('l_pump', ?, 'buy', 'PUMP', 9e999, 0, -100, 0.8, 'o_pump', NULL)").run(at);
        db.raw.prepare("INSERT INTO trader_positions (asset, quantity, avg_cost, opened_at, open_order_id, invalidation, horizon_until, thesis, updated_at) VALUES ('PUMP', 9e999, 0, ?, 'o_pump', 1, NULL, ?, ?)").run(at, THESIS, at);
        db.raw.prepare("INSERT INTO trader_positions (asset, quantity, avg_cost, opened_at, open_order_id, invalidation, horizon_until, thesis, updated_at) VALUES ('TINY', 1000, 0, ?, 'o_tiny', 0.5, NULL, ?, ?)").run(at, THESIS, at);
        const ids: Record<string, string> = {};
        rawOrder(db, { id: "o_btc_achat", at: hours(28), asset: "BTC", side: "buy", amountEur: 50, invalidation: 45_000 });
        ids.o_btc_achat = "reject:suspended";
        rawOrder(db, { id: "o_pump_vente", at: hours(28), asset: "PUMP", side: "sell", quantity: 100 });
        ids.o_pump_vente = "reject:position";
        ids[place(db, 28.2, "BTC", 60_000, sellAll)] = "fill";
        storePrice(db, "BTC", hours(28.5), 60_500);
        storePrice(db, "PUMP", hours(29.95), 0.004);
        storePrice(db, "TINY", hours(29.95), 0.001);
        storePrice(db, "USDC", hours(29.95), 0.6);
        return ids;
      },
    },
    {
      name: "a rejected stop puts its level back and the same tick places the stop again",
      stops: ["USDC"],
      build: (db) => {
        storePrice(db, "BTC", T0, 60_000);
        brokerTick(db.raw, TRADER, T0);
        trade(db, 1, "USDC", 0.86, buy(100, 0.86));
        db.raw.prepare("UPDATE trader_positions SET invalidation = NULL WHERE asset = 'USDC'").run();
        db.raw.prepare("INSERT INTO trader_position_updates (id, asset, at, field, old_value, new_value, reason, by) VALUES ('u_stop', 'USDC', ?, 'invalidation', '0.7', NULL, 'stop triggered', 'code')").run(isoSeconds(hours(27)));
        // A stop order without a quantity (only a broken writer could leave one): its sale computes 0 units.
        rawOrder(db, { id: "o_stop_sans_quantite", at: hours(27), asset: "USDC", side: "sell", quantity: null, origin: "stop" });
        storePrice(db, "USDC", hours(29.95), 0.65);
        return { o_stop_sans_quantite: "reject:quantity" };
      },
    },
    {
      name: "the level is put back once a day only: a second rejection the same day leaves the position without a stop",
      stops: [],
      build: (db) => {
        storePrice(db, "BTC", T0, 60_000);
        brokerTick(db.raw, TRADER, T0);
        trade(db, 1, "USDC", 0.86, buy(100, 0.86));
        db.raw.prepare("UPDATE trader_positions SET invalidation = NULL WHERE asset = 'USDC'").run();
        db.raw.prepare("INSERT INTO trader_position_updates (id, asset, at, field, old_value, new_value, reason, by) VALUES ('u_stop', 'USDC', ?, 'invalidation', '0.7', NULL, 'stop triggered', 'code')").run(isoSeconds(hours(27)));
        setKV(db.raw, "sonni.stop_restored.USDC", T.toISOString().slice(0, 10));
        rawOrder(db, { id: "o_stop_sans_quantite", at: hours(27), asset: "USDC", side: "sell", quantity: null, origin: "stop" });
        storePrice(db, "USDC", hours(29.95), 0.65);
        return { o_stop_sans_quantite: "reject:quantity" };
      },
    },
  ];

  const STATUS: Record<string, string> = { filled: "fill", rejected: "reject", expired: "expire", pending: "wait" };

  for (const s of scenarios) {
    it(s.name, () => {
      const file = path.join(tmp("sonni-controle-fidelite-"), COPY);
      const db = openDb(file);
      const expected = s.build(db);
      db.close();
      const before = sha(file);

      // The script's view: a read-only private copy, as the gate opens it.
      const copy = openPrivateCopy(file, "sonni-controle-test-");
      const opts = { now: T, staleMinutes: TRADER.staleMinutes, portfolio: TRADER.portfolio, assets: TRADER.assets.map((a) => a.symbol) };
      let predicted: any[];
      let predictedStops: string[];
      try {
        predicted = predictPendingOrders(copy.db, opts);
        predictedStops = predictStops(copy.db, opts);
      } finally {
        copy.close();
      }
      expect(fs.existsSync(copy.dir)).toBe(false);

      // The real broker on another copy.
      const live = path.join(tmp("sonni-controle-reel-"), "copie-reelle.db");
      fs.copyFileSync(file, live);
      expect(sha(file)).toBe(before);
      const real = new Database(live);
      const pending = (real.prepare("SELECT id FROM trader_orders WHERE status = 'pending' ORDER BY placed_at").all() as { id: string }[]).map((r) => r.id);
      const out = brokerTick(real, TRADER, T);
      const rows = new Map((real.prepare("SELECT id, status, settled_at, fill_price, note FROM trader_orders").all() as any[]).map((r) => [r.id, r]));
      real.close();
      expect(out.failed).toEqual([]);

      // Same orders, same order of processing, same outcome for each.
      expect(predicted.map((p) => p.id)).toEqual(pending);
      for (const p of predicted) {
        const row = rows.get(p.id);
        expect(p.outcome, `${p.id} ${p.asset}`).toBe(STATUS[row.status]);
        if (p.outcome === "reject") expect(row.note, p.id).toContain(`rejected by code (${p.reason})`);
        if (p.outcome === "fill") {
          expect(p.priceTs, p.id).toBe(row.settled_at);
          expect(p.fillPrice, p.id).toBe(row.fill_price);
        }
      }
      // The scenario covers what it says: the expected outcome of each named order.
      for (const [id, outcome] of Object.entries(expected)) {
        const p = predicted.find((x) => x.id === id);
        expect(p, id).toBeDefined();
        expect(p.reason ? `${p.outcome}:${p.reason}` : p.outcome, `${id} ${p.asset}`).toBe(outcome);
      }
      expect([...predictedStops].sort()).toEqual(out.stops.map((o) => o.asset).sort());
      expect([...predictedStops].sort()).toEqual(s.stops);
    });
  }

  it("reads the same stops through the script: fresh price places the stop, a stale one waits", () => {
    const file = variant((db) => {
      db.prepare("UPDATE trader_positions SET invalidation = 70000 WHERE asset = 'BTC'").run();
    });
    const later = new Date(NOW.getTime() + 27 * 60_000);
    const copy = openPrivateCopy(file, "sonni-controle-test-");
    try {
      expect(predictStops(copy.db, { now: later, staleMinutes: 15 })).toEqual([]);
      expect(predictStops(copy.db, { now: later, staleMinutes: 60 })).toEqual(["BTC"]);
      expect(predictStops(copy.db, { now: later, staleMinutes: 60, assets: ["ETH"] })).toEqual([]);
    } finally {
      copy.close();
    }
    for (const [staleMinutes, stops] of [[15, []], [60, ["BTC"]]] as const) {
      const live = path.join(tmp("sonni-controle-reel-"), "copie-reelle.db");
      fs.copyFileSync(file, live);
      const real = new Database(live);
      try {
        expect(brokerTick(real, { ...TRADER, staleMinutes }, later).stops.map((o) => o.asset)).toEqual(stops);
      } finally {
        real.close();
      }
    }
  });
});
