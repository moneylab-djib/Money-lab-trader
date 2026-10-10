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
import { KEY_PATTERN, pointKey, predictPendingOrders, predictStops, resume } from "../../../sonni/vps/controle-predeploiement.mjs";
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
/** The keys of the conclusion's "Pour accepter exactement ces points" line, or null when it has none. */
const acceptKeys = (stdout: string) => /^Pour accepter exactement ces points : --accepter-a-decider (\S+)$/m.exec(stdout)?.[1] ?? null;
/** The conclusion addressed to the owner when a BLOQUANT is found. */
const BLOCKED = "Déploiement bloqué : ne démarre pas la nouvelle version ; envoie-moi ce rapport et décide de la suite";

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
    expect(r.stdout.match(/Conclusion/g)).toHaveLength(1);
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
    }, /\[BLOQUANT\] position BTC : 0,50\d+ unité enregistrée, le registre en donne 0,00\d+ \(écart -0,5\)/],
    ["a filled order without its ledger row", (db) => {
      rawOrder(db, { id: "o_sans_registre", at: hours(6), asset: "BTC", side: "buy", amountEur: 50, status: "filled", settledAt: isoSeconds(hours(6.1)), fillPrice: 60_030, fillQuantity: 0.00082624, fillEur: 50, feeEur: 0.4 });
    }, /\[BLOQUANT\] 1 ordre exécuté sans exactement une ligne d'achat ou de vente au registre : o_sans_registre \(achat BTC le 07\/10\/2026 14:06 UTC, 0 ligne\)/],
    ["a filled order booked twice in the ledger", (db) => {
      const sale = db.prepare("SELECT id FROM trader_orders WHERE asset = 'ETH' AND side = 'sell' AND status = 'filled'").get() as { id: string };
      db.prepare(`INSERT INTO trader_ledger (id, at, kind, asset, quantity, price, amount_eur, fee_eur, order_id, note)
        SELECT 'l_double', at, kind, asset, quantity, price, amount_eur, fee_eur, order_id, note FROM trader_ledger WHERE order_id = ? AND kind = 'sell'`).run(sale.id);
    }, /\[BLOQUANT\] 1 ordre exécuté sans exactement une ligne d'achat ou de vente au registre : o_\w+ \(vente ETH le 07\/10\/2026 13:06 UTC, 2 lignes\)/],
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
      expect(r.stdout).toContain(BLOCKED);
      expect(r.stdout).not.toContain("propriétaire");
      expect(counts(r.last)!.b).toBeGreaterThan(0);
      // Accepting every point to decide the run lists (or a key when it lists none) never lifts a BLOQUANT.
      const accepted = run(file, ["--accepter-a-decider", acceptKeys(r.stdout) ?? "sans-stop:BTC"]);
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
    const r = run(file, ["--accepter-a-decider", "sans-stop:BTC"]);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toMatch(/\[BLOQUANT\] contrôle d'intégrité SQLite en échec \(\d+ problèmes?\)/);
    expect(r.stdout).toContain(BLOCKED);
  });

  const DECISIONS: [string, (db: Database.Database) => void, RegExp, string][] = [
    ["an averaged position whose stored cost drifts by a cent or more", (db) => {
      db.prepare("UPDATE trader_positions SET avg_cost = 0.86 WHERE asset = 'USDC'").run();
    }, /\[À DÉCIDER\] \(clé ecart-moyen:USDC\) USDC : coût moyen enregistré 0,86 € contre 0,8\d+ € d'après le registre, écart -0,\d\d € sur la position : écart historique d'arrondi, aucune réparation automatique/,
    "ecart-moyen:USDC"],
    ["market fills further than 0.5 % from the market", (db) => {
      rawPrice(db, "ADA", hours(6), 0.403);
      rawOrder(db, { id: "o_ada_ancien", at: hours(5.9), asset: "ADA", side: "buy", amountEur: 40, status: "filled", settledAt: isoSeconds(hours(6)), fillPrice: 0.4, fillQuantity: 99.2, fillEur: 40, feeEur: 0.32 });
      db.prepare("INSERT INTO trader_ledger (id, at, kind, asset, quantity, price, amount_eur, fee_eur, order_id, note) VALUES ('l_ada', ?, 'buy', 'ADA', 99.2, 0.4, -40, 0.32, 'o_ada_ancien', NULL)").run(isoSeconds(hours(6)));
      db.prepare("INSERT INTO trader_positions (asset, quantity, avg_cost, opened_at, open_order_id, invalidation, horizon_until, thesis, updated_at) VALUES ('ADA', 99.2, 0.4, ?, 'o_ada_ancien', 0.3, NULL, ?, ?)").run(isoSeconds(hours(6)), THESIS, isoSeconds(hours(6)));
    }, /\[À DÉCIDER\] \(clé derive:ADA\) ADA : 1 exécution au marché à plus de 0,5 % du prix du marché \(jusqu'à 0,74 %, dix fois le glissement configuré\)/, "derive:ADA"],
    ["a pending sell the broker rejects (nothing to sell)", (db) => {
      rawOrder(db, { id: "o_vente_vide", at: hours(9), asset: "ETH", side: "sell", quantity: 0.04 });
      rawPrice(db, "ETH", hours(9.5), 2_700);
    }, /\[À DÉCIDER\] \(clé ordre-refuse:o_vente_vide\) o_vente_vide : vente au marché ETH passé le 07\/10\/2026 17:00 UTC : refusé \(rien à vendre\)/, "ordre-refuse:o_vente_vide"],
    ["a pending market order that expires", (db) => {
      rawOrder(db, { id: "o_expire", at: hours(-20), asset: "SPY", side: "buy", amountEur: 30 });
    }, /\[À DÉCIDER\] \(clé ordre-expire:o_expire\) o_expire : achat au marché SPY passé le 06\/10\/2026 12:00 UTC : expiré \(aucun prix enregistré dans les 24 h suivant l'ordre\)/, "ordre-expire:o_expire"],
    ["a pending order filled at an old stored price", (db) => {
      rawOrder(db, { id: "o_prix_ancien", at: hours(5), asset: "ADA", side: "buy", amountEur: 20, invalidation: 0.3 });
      rawPrice(db, "ADA", hours(5.1), 0.4);
    }, /\[À DÉCIDER\] \(clé prix-ancien:o_prix_ancien\) o_prix_ancien : achat au marché ADA .* exécuté au prix enregistré du 07\/10\/2026 13:06 UTC \(0,4 € ; prix d'exécution 0,4002 €\) : exécution à un prix ancien du 07\/10\/2026 13:06 UTC \(il y a 4 h 54\)/,
    "prix-ancien:o_prix_ancien"],
    ["a position without a stop", (db) => {
      db.prepare("UPDATE trader_positions SET invalidation = NULL WHERE asset = 'BTC'").run();
    }, /\[À DÉCIDER\] \(clé sans-stop:BTC\) BTC : position sans stop \(aucun niveau d'invalidation, aucune vente en attente\)/, "sans-stop:BTC"],
    ["a stop already crossed by the last known price", (db) => {
      db.prepare("UPDATE trader_positions SET invalidation = 70000 WHERE asset = 'BTC'").run();
    }, /\[À DÉCIDER\] \(clé stop-franchi:BTC\) BTC : stop franchi d'après le dernier prix connu \(61\s000,00 € le 07\/10\/2026 17:57 UTC\) : vente au premier relevé si le prix reste sous 70\s000,00 € ; prix frais \(il y a 3 min\) : la nouvelle version pose le stop dès le premier relevé/,
    "stop-franchi:BTC"],
    // The stored level (42,000) is far below the price; a pending added buy fills on a fresh price and its level
    // (57,950) replaces it, and that price is already under the new level: the first tick sells the whole position.
    ["a stop placed on the level a pending added buy sets", (db) => {
      rawOrder(db, { id: "o_achat_ajout", at: hours(9.5), asset: "BTC", side: "buy", kind: "limit", limitPrice: 58_000, amountEur: 50, invalidation: 57_950 });
      rawPrice(db, "BTC", hours(9.96), 57_900);
    }, /\[À DÉCIDER\] \(clé stop-franchi:BTC\) BTC : stop franchi d'après le dernier prix connu \(57\s900,00 € le 07\/10\/2026 17:57 UTC\) : vente au premier relevé si le prix reste sous 57\s950,00 € ; prix frais \(il y a 2 min\) : la nouvelle version pose le stop dès le premier relevé ; niveau fixé au premier relevé \(niveau enregistré : 42\s000,00 €\)/,
    "stop-franchi:BTC"],
    // A legacy pending buy without a level opens a position the first tick leaves without a stop.
    ["a position the first tick opens without a stop", (db) => {
      rawOrder(db, { id: "o_achat_sans_niveau", at: hours(9.92), asset: "ETH", side: "buy", amountEur: 30, invalidation: null });
      rawPrice(db, "ETH", hours(9.96), 2_650);
    }, /\[À DÉCIDER\] \(clé sans-stop:ETH\) ETH : position sans stop \(aucun niveau d'invalidation, aucune vente en attente\) ; position ouverte au premier relevé par un achat en attente/, "sans-stop:ETH"],
  ];

  for (const [name, mutate, expected, key] of DECISIONS) {
    it(`asks the owner about ${name}: exit 1 with its key ${key}, then exit 0 once that key is accepted`, () => {
      const file = variant(mutate);
      const r = run(file);
      expect(r.status, r.stdout + r.stderr).toBe(1);
      expect(r.stdout).toMatch(expected);
      expect(counts(r.last)).toMatchObject({ b: 0, d: 1 });
      expect(r.stdout).toContain(`Déploiement bloqué : ne démarre pas la nouvelle version ; envoie-moi ce rapport et décide de chaque point « À DÉCIDER » (1 point non accepté : ${key}).`);
      expect(acceptKeys(r.stdout)).toBe(key);
      expect(r.stdout).not.toContain("propriétaire");
      const accepted = run(file, ["--accepter-a-decider", key]);
      expect(accepted.status, accepted.stdout).toBe(0);
      expect(accepted.stdout).toMatch(expected);
      expect(accepted.stdout).toContain(`- [À DÉCIDER, accepté] (clé ${key}) `);
      expect(accepted.stdout).toContain(`Conclusion : rien ne bloque (1 point à décider levé par --accepter-a-decider : ${key}).`);
      expect(accepted.stdout).not.toContain("Pour accepter exactement ces points");
      expect(accepted.last).toMatch(/^RÉSULTAT : code=0 bloquants=0 a_decider=1 infos=\d+$/);
    });
  }

  it("never lets --accepter-a-decider lift a BLOQUANT next to points to decide", () => {
    const file = variant((db) => {
      db.prepare("UPDATE trader_positions SET invalidation = NULL WHERE asset = 'BTC'").run();
      db.prepare("INSERT INTO trader_ledger (id, at, kind, asset, quantity, price, amount_eur, fee_eur, order_id, note) VALUES ('l_neg', ?, 'contribution', NULL, NULL, NULL, -5000, 0, NULL, 'test')").run(isoSeconds(hours(6)));
    });
    const r = run(file, ["--accepter-a-decider", "sans-stop:BTC"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("- [À DÉCIDER, accepté] (clé sans-stop:BTC) BTC : position sans stop");
    expect(r.stdout).toContain(`${BLOCKED} (rien n'a été modifié ; une réparation demande une procédure séparée et ton accord). L'option --accepter-a-decider ne lève jamais un point bloquant.`);
    expect(r.stdout).not.toContain("Pour accepter exactement ces points");
    expect(counts(r.last)).toMatchObject({ b: 1, d: 1 });
    // Without the key, the conclusion still gives the option to copy, and says it never lifts the BLOQUANT.
    const plain = run(file);
    expect(plain.status).toBe(1);
    expect(plain.stdout).toContain("L'option --accepter-a-decider ne lève jamais un point bloquant.");
    expect(acceptKeys(plain.stdout)).toBe("sans-stop:BTC");
  });

  it("reports a fill at a recent stored price as INFO (up to 60 minutes old), with the stop of the position it opens", () => {
    const file = variant((db) => {
      rawOrder(db, { id: "o_ada_frais", at: hours(9.8), asset: "ADA", side: "buy", amountEur: 20, invalidation: 0.3 });
      rawPrice(db, "ADA", new Date(NOW.getTime() - 5 * 60_000), 0.4);
      // Exactly 60 minutes old is still recent.
      rawOrder(db, { id: "o_spy_60min", at: hours(8.5), asset: "SPY", side: "buy", amountEur: 20, invalidation: 400 });
      rawPrice(db, "SPY", new Date(NOW.getTime() - 60 * 60_000), 500);
    });
    const r = run(file);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("[INFO] o_ada_frais : achat au marché ADA passé le 07/10/2026 17:48 UTC : exécuté au prix enregistré du 07/10/2026 17:55 UTC (0,4 € ; prix d'exécution 0,4002 €)");
    expect(r.stdout).toMatch(/\[INFO\] o_spy_60min : achat au marché SPY passé le 07\/10\/2026 16:30 UTC : exécuté au prix enregistré du 07\/10\/2026 17:00 UTC \(500,00 € ; prix d'exécution 500,25 €\)\n/);
    expect(r.stdout).toContain("[INFO] ADA : stop à 0,3 €, 25,00 % sous le dernier prix (0,4 € le 07/10/2026 17:55 UTC) ; position ouverte au premier relevé par un achat en attente");
    expect(r.stdout).not.toContain("prix ancien");
    expect(r.last).toMatch(/^RÉSULTAT : code=0 bloquants=0 a_decider=0 infos=\d+$/);
  });

  it("reports the history: days without a snapshot, incidents of the last 7 days by kind, broker and backup named (INFO)", () => {
    const file = variant((db) => {
      const day = db.prepare("INSERT INTO trader_portfolio_days (day, at, cash_eur, positions_eur, equity_eur, contributed_eur) VALUES (?, ?, 500, 0, 500, 500)");
      for (const d of ["2026-10-01", "2026-10-02", "2026-10-05"]) day.run(d, `${d}T23:00:00.000Z`);
      const incident = db.prepare("INSERT INTO trader_incidents (id, at, kind, message) VALUES (?, ?, ?, ?)");
      const before = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
      incident.run("i_1", before(1), "broker", "ordre o_x refusé par le courtier virtuel");
      incident.run("i_2", before(6 * 24), "broker", "position PUMP invalide");
      incident.run("i_3", before(2 * 24), "backup", "sauvegarde du jour impossible");
      incident.run("i_4", before(3), "errors", "trois erreurs de suite");
      incident.run("i_5", before(8 * 24), "broker", "incident trop ancien");
      incident.run("i_6", before(-1), "backup", "incident après le moment contrôlé");
    });
    const r = run(file);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("[INFO] 3 jours sans instantané entre le 2026-10-01 et le 2026-10-07 : 2026-10-03 → 2026-10-04, 2026-10-06");
    expect(r.stdout).toContain("[INFO] incidents des 7 derniers jours : courtier virtuel 2, sauvegarde 1, série d'erreurs 1");
    expect(r.stdout).toContain("[INFO] incident « courtier virtuel » du 07/10/2026 17:00 UTC : ordre o_x refusé par le courtier virtuel");
    expect(r.stdout).toContain("[INFO] incident « courtier virtuel » du 01/10/2026 18:00 UTC : position PUMP invalide");
    expect(r.stdout).toContain("[INFO] incident « sauvegarde » du 05/10/2026 18:00 UTC : sauvegarde du jour impossible");
    expect(r.stdout).not.toContain("trois erreurs de suite");
    expect(r.stdout).not.toContain("incident trop ancien");
    expect(r.stdout).not.toContain("incident après le moment contrôlé");
    const clean = run(cleanCopy());
    expect(clean.stdout).toContain("[INFO] instantanés quotidiens complets du 2026-10-07 au 2026-10-07");
    expect(clean.stdout).toContain("[INFO] aucun incident les 7 derniers jours");
  });

  it("explains a damaged copy in French (a missing table), never with SQLite's English message", () => {
    const file = variant((db) => { db.exec("DROP TABLE trader_prices"); });
    const r = run(file);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toContain("table manquante dans la copie : trader_prices");
    expect(r.stdout).not.toContain("no such table");
    expect(counts(r.last)!.b).toBeGreaterThan(0);
  });

  it("refuses the live database, a file beside -wal/-shm, a missing file and bad options (exit 2, nothing read)", () => {
    const dir = tmp("sonni-controle-refus-");
    const live = path.join(dir, "state.db");
    openDb(live).close();
    const r1 = run(live);
    expect(r1.status).toBe(2);
    expect(r1.stderr).toContain("Refusé : c'est la base active de Sonni");
    expect(r1.last).toBe("RÉSULTAT : code=2 controle=refusé");
    // The Telegram summary says why once, in French.
    const short = run(live, ["--resume"]);
    expect(short.status).toBe(2);
    expect(short.stdout).toContain("Contrôle avant déploiement de Sonni : refusé. C'est la base active de Sonni.");
    expect(short.stdout).not.toContain("Refusé :");
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
    expect(r.stdout).toContain("BLOQUANT :\n- position Z000 : 1 unité enregistrée, le registre en donne 0");
    expect(r.stdout).toMatch(/… et \d+ autre\(s\) ligne\(s\) : rapport complet dans le terminal/);
    expect(r.stdout).not.toContain("A. Intégrité");
    expect(r.last).toBe("RÉSULTAT : code=1 bloquants=150 a_decider=150 infos=" + counts(full.last)!.i);
    const clean = run(cleanCopy(), ["--resume"]);
    expect(clean.status).toBe(0);
    expect(clean.stdout).toMatch(/^Contrôle avant déploiement de Sonni : rien ne bloque\n/);
    expect(clean.stdout.length).toBeLessThanOrEqual(3_500);
    // The cut also holds for a few very long lines.
    const long = resume(Array.from({ length: 40 }, (_, i) => ({ level: "D", key: `sans-stop:A${i}`, text: `${i} ${"x".repeat(400)}` })), { file, now: NOW, accepted: [], code: 1 });
    expect(long.length).toBeLessThanOrEqual(3_500);
    // So does a list of keys too long for one message: the full report gives it, the summary points there.
    expect(full.stdout).toContain(`Pour accepter exactement ces points : --accepter-a-decider sans-stop:Z000,sans-stop:Z001,`);
    expect(acceptKeys(full.stdout)!.split(",")).toHaveLength(150);
    expect(r.stdout).toContain("Pour accepter exactement ces points : 150 clés, liste trop longue pour ce message : copie-la depuis le terminal");
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
    expect(unfollowed.stdout).toContain("[À DÉCIDER] (clé actif-non-suivi:BTC) BTC : actif plus suivi d'après la configuration, aucun prix ne sera relevé et aucun stop ne peut être posé");
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
    expect(r.stdout).toContain("[INFO] Sonni est en pause (budget du jour atteint) : aucun cycle tant que tu ne l'as pas relancé (/reprendre)");
    expect(r.stdout).toContain("[INFO] échéance de la position USDC passée (07/10/2026 17:00 UTC) : réveil payé pour revoir USDC");
    expect(r.stdout).toContain("[INFO] versement virtuel du mois au premier relevé (50,00 €, dernier mois versé : 2026-09)");
    const awake = run(cleanCopy());
    expect(awake.stdout).toMatch(/\[INFO\] le redémarrage lancera un cycle payé : Sonni n'était pas endormi, état enregistré : \S+/);
  });

  /** BTC left without a stop (the point the GO accepted after Phase 1) and an ETH sale the first tick rejects (new). */
  const twoPoints = () => variant((db) => {
    db.prepare("UPDATE trader_positions SET invalidation = NULL WHERE asset = 'BTC'").run();
    rawOrder(db, { id: "o_vente_vide", at: hours(9), asset: "ETH", side: "sell", quantity: 0.04 });
    rawPrice(db, "ETH", hours(9.5), 2_700);
  });

  it("lifts only the keys listed: a new point to decide that is not listed still blocks", () => {
    const file = twoPoints();
    const first = run(file);
    expect(first.status).toBe(1);
    expect(first.stdout).toContain("[À DÉCIDER] (clé ordre-refuse:o_vente_vide) o_vente_vide : vente au marché ETH");
    expect(first.stdout).toContain("[À DÉCIDER] (clé sans-stop:BTC) BTC : position sans stop");
    expect(first.stdout).toContain("(2 points non acceptés : ordre-refuse:o_vente_vide, sans-stop:BTC).");
    expect(acceptKeys(first.stdout)).toBe("ordre-refuse:o_vente_vide,sans-stop:BTC");
    // The GO accepted BTC only: the rejected sale that appeared since keeps the deployment blocked.
    const partial = run(file, ["--accepter-a-decider", "sans-stop:BTC"]);
    expect(partial.status, partial.stdout).toBe(1);
    expect(partial.stdout).toContain("- [À DÉCIDER, accepté] (clé sans-stop:BTC) BTC : position sans stop");
    expect(partial.stdout).toContain("- [À DÉCIDER] (clé ordre-refuse:o_vente_vide) o_vente_vide : vente au marché ETH");
    expect(partial.stdout).toContain("Déploiement bloqué : ne démarre pas la nouvelle version ; envoie-moi ce rapport et décide de chaque point « À DÉCIDER » (1 point non accepté : ordre-refuse:o_vente_vide).");
    expect(acceptKeys(partial.stdout)).toBe("ordre-refuse:o_vente_vide,sans-stop:BTC");
    expect(partial.stdout).not.toContain("rien ne bloque");
    expect(partial.last).toMatch(/^RÉSULTAT : code=1 bloquants=0 a_decider=2 infos=\d+$/);
    const short = run(file, ["--accepter-a-decider", "sans-stop:BTC", "--resume"]);
    expect(short.status).toBe(1);
    expect(short.stdout).toContain("Bloquants : 0 ; à décider : 2 (dont 1 accepté) ;");
    expect(short.stdout).toContain("À DÉCIDER :\n- (clé ordre-refuse:o_vente_vide) o_vente_vide : vente au marché ETH");
    expect(short.stdout).toContain("\n- [accepté] (clé sans-stop:BTC) BTC : position sans stop");
    expect(short.stdout).toContain("\nPour accepter exactement ces points : --accepter-a-decider ordre-refuse:o_vente_vide,sans-stop:BTC\n");
    // Both keys, in one list or with the option repeated: nothing blocks.
    for (const args of [["--accepter-a-decider", acceptKeys(first.stdout)!], ["--accepter-a-decider", "sans-stop:BTC", "--accepter-a-decider", " ordre-refuse:o_vente_vide ,"]]) {
      const all = run(file, args);
      expect(all.status, all.stdout).toBe(0);
      expect(all.stdout).toContain("Conclusion : rien ne bloque (2 points à décider levés par --accepter-a-decider : ordre-refuse:o_vente_vide, sans-stop:BTC).");
      expect(all.last).toMatch(/^RÉSULTAT : code=0 bloquants=0 a_decider=2 infos=\d+$/);
    }
  });

  it("reports a listed key that matches no point as INFO (it lifts nothing and blocks nothing)", () => {
    const file = twoPoints();
    const both = run(file, ["--accepter-a-decider", "ordre-refuse:o_vente_vide,sans-stop:BTC"]);
    const extra = run(file, ["--accepter-a-decider", "ordre-refuse:o_vente_vide,sans-stop:BTC,stop-franchi:ETH"]);
    expect(extra.status, extra.stdout).toBe(0);
    expect(extra.stdout).toContain("- [INFO] clé acceptée sans objet : stop-franchi:ETH (aucun point à décider de cette copie ne porte cette clé ; elle ne lève rien)");
    expect(counts(extra.last)).toEqual({ ...counts(both.last), i: counts(both.last)!.i + 1 });
    const clean = run(cleanCopy(), ["--accepter-a-decider", "ordre-expire:o_01ABC"]);
    expect(clean.status).toBe(0);
    expect(clean.stdout).toContain("- [INFO] clé acceptée sans objet : ordre-expire:o_01ABC");
    expect(clean.stdout).toContain("Conclusion : rien ne bloque, le déploiement peut continuer.");
    const short = run(cleanCopy(), ["--accepter-a-decider", "ordre-expire:o_01ABC", "--resume"]);
    expect(short.stdout).toContain("INFO :\n- clé acceptée sans objet : ordre-expire:o_01ABC");
    // A key naming another point than the one found does not lift it.
    const other = run(file, ["--accepter-a-decider", "sans-stop:ETH,ordre-refuse:o_autre"]);
    expect(other.status).toBe(1);
    expect(other.stdout).toContain("(2 points non acceptés : ordre-refuse:o_vente_vide, sans-stop:BTC).");
  });

  it("gives keys that are short, stable and safe to type: kind and asset or order id, other bytes percent-encoded", () => {
    expect(pointKey("stop-franchi", "BTC")).toBe("stop-franchi:BTC");
    expect(pointKey("ordre-refuse", "o_01M4J4K14XTJKACH99H20NHMHK")).toBe("ordre-refuse:o_01M4J4K14XTJKACH99H20NHMHK");
    // A legacy id with a comma, a space or an accent cannot split the list or clash with another id.
    expect(pointKey("ordre-expire", "o,a b")).toBe("ordre-expire:o%2Ca%20b");
    expect(pointKey("ordre-expire", "o_é")).toBe("ordre-expire:o_%C3%A9");
    expect(pointKey("ordre-expire", "o%2C")).not.toBe(pointKey("ordre-expire", "o,"));
    for (const k of [pointKey("sans-stop", ""), pointKey("derive", "a'b;c"), pointKey("ordre-expire", "o,a b")]) expect(k).toMatch(KEY_PATTERN);
    const file = variant((db) => { rawOrder(db, { id: "o,legacy id", at: hours(-20), asset: "SPY", side: "buy", amountEur: 30 }); });
    const r = run(file);
    expect(r.stdout).toContain("[À DÉCIDER] (clé ordre-expire:o%2Clegacy%20id) o,legacy id : achat au marché SPY");
    expect(acceptKeys(r.stdout)).toBe("ordre-expire:o%2Clegacy%20id");
    expect(run(file, ["--accepter-a-decider", acceptKeys(r.stdout)!]).status).toBe(0);
  });

  it("refuses --accepter-a-decider without its list of keys, or with something that is not a key (exit 2, nothing read)", () => {
    const file = cleanCopy();
    for (const args of [["--accepter-a-decider"], ["--accepter-a-decider", "--resume"], ["--accepter-a-decider", ""], ["--accepter-a-decider", " , "]]) {
      const r = run(file, args);
      expect(r.status, args.join(" ")).toBe(2);
      expect(r.stderr).toContain("L'option --accepter-a-decider demande la liste des clés que ton GO accepte, séparées par des virgules, par exemple : --accepter-a-decider stop-franchi:BTC,ecart-moyen:USDC.");
      expect(r.stderr).toContain("Lance d'abord le contrôle sans cette option : sa conclusion donne la ligne exacte à recopier.");
      expect(r.last).toBe("RÉSULTAT : code=2 controle=refusé");
      expect(r.stdout).not.toContain("A. Intégrité");
    }
    const short = run(file, ["--resume", "--accepter-a-decider"]);
    expect(short.status).toBe(2);
    expect(short.stdout).toContain("Contrôle avant déploiement de Sonni : refusé. L'option --accepter-a-decider demande la liste des clés");
    // The copy's path after the option (its list forgotten) is not a key.
    const swapped = spawnSync(process.execPath, [SCRIPT, "--accepter-a-decider", file], { encoding: "utf-8", env: { ...process.env, HOME: tmp("sonni-controle-home-"), TMPDIR: tmp("sonni-controle-tmp-") } });
    expect(swapped.status).toBe(2);
    expect(swapped.stderr).toContain("Clé invalide après --accepter-a-decider : « ");
    expect(swapped.stdout.trimEnd().split("\n").pop()).toBe("RÉSULTAT : code=2 controle=refusé");
  });

  it("predicts by default at the moment of the copy (its newest stored price), --maintenant still overrides it", () => {
    const file = variant((db) => {
      // A market buy placed two minutes before the copy's last price, still waiting for its own.
      rawOrder(db, { id: "o_eth_marche", at: hours(9.92), asset: "ETH", side: "buy", amountEur: 30, invalidation: 2_000 });
    });
    const byDefault = run(file, [], { now: null });
    expect(byDefault.status, byDefault.stdout).toBe(0);
    expect(byDefault.stdout).toContain("Prévision : si Sonni redémarrait le 07/10/2026 17:57 UTC avec cette copie\n(prévision au moment de la copie : 07/10/2026 17:57 UTC, son dernier prix enregistré");
    expect(byDefault.stdout).toContain("E. Ordres en attente : ce que ferait le premier relevé du 07/10/2026 17:57 UTC");
    expect(byDefault.stdout).toContain("[INFO] o_eth_marche : achat au marché ETH passé le 07/10/2026 17:55 UTC : attend un prix");
    expect(byDefault.stdout).toContain("[INFO] dernier prix enregistré : 07/10/2026 17:57 UTC (il y a moins d'une minute)");
    const short = run(file, ["--resume"], { now: null });
    expect(short.stdout).toContain("Copie : state.db.predeploiement-20261007T180000Z ; prévision au moment de la copie : 07/10/2026 17:57 UTC\n");
    // The exported prediction has the same default.
    const copy = openPrivateCopy(file, "sonni-controle-test-");
    try {
      expect(predictPendingOrders(copy.db, { staleMinutes: 15 }).find((o: any) => o.id === "o_eth_marche")?.outcome).toBe("wait");
      expect(predictPendingOrders(copy.db, { now: hours(58), staleMinutes: 15 }).find((o: any) => o.id === "o_eth_marche")?.outcome).toBe("expire");
    } finally {
      copy.close();
    }
    // Two days later the same order has expired: that is a point to decide, at the moment the option names.
    const later = run(file, [], { now: hours(58) });
    expect(later.status).toBe(1);
    expect(later.stdout).toContain("Prévision : si Sonni redémarrait le 09/10/2026 18:00 UTC avec cette copie\n(moment choisi avec --maintenant)");
    expect(later.stdout).toContain("[À DÉCIDER] (clé ordre-expire:o_eth_marche) o_eth_marche : achat au marché ETH passé le 07/10/2026 17:55 UTC : expiré");
    // A copy without any price: the current time, said so.
    const empty = path.join(tmp("sonni-controle-vide-"), COPY);
    openDb(empty).close();
    const none = run(empty, [], { now: null });
    expect(none.status, none.stdout).toBe(0);
    expect(none.stdout).toContain("(aucun prix dans la copie : prévision à l'heure actuelle)");
    expect(none.stdout).toContain(`E. Ordres en attente : ce que ferait le premier relevé du ${new Date().toISOString().slice(8, 10)}/`);
  });

  it("reconciles the ledger both ways: units the ledger holds without a position, a closed position the ledger does not bring back to 0", () => {
    const file = variant((db) => {
      // A filled SPY buy with its ledger row and no position row.
      rawPrice(db, "SPY", hours(6), 500);
      rawOrder(db, { id: "o_spy_sans_position", at: hours(5.9), asset: "SPY", side: "buy", amountEur: 100, status: "filled", settledAt: isoSeconds(hours(6)), fillPrice: 500.25, fillQuantity: 0.198, fillEur: 100, feeEur: 0.8 });
      db.prepare("INSERT INTO trader_ledger (id, at, kind, asset, quantity, price, amount_eur, fee_eur, order_id, note) VALUES ('l_spy', ?, 'buy', 'SPY', 0.198, 500.25, -100, 0.8, 'o_spy_sans_position', NULL)").run(isoSeconds(hours(6)));
      // ETH is closed (quantity 0) but the ledger holds one more buy.
      db.prepare("INSERT INTO trader_ledger (id, at, kind, asset, quantity, price, amount_eur, fee_eur, order_id, note) VALUES ('l_eth_fantome', ?, 'buy', 'ETH', 0.01, 2500, -25, 0.2, NULL, NULL)").run(isoSeconds(hours(6)));
    });
    const r = run(file);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain("[BLOQUANT] actif SPY : le registre en donne 0,198 unité au total (achats moins ventes), aucune position enregistrée (écart 0,198)");
    expect(r.stdout).toMatch(/\[BLOQUANT\] actif ETH : le registre en donne 0,01 unité au total \(achats moins ventes\), la position enregistrée est à 0 \(close\) \(écart 0,01\)/);
    expect(r.stdout).not.toContain("registre, positions, ordres et opérations concordent");
    expect(counts(r.last)).toMatchObject({ b: 2, d: 0 });
    expect(run(file, ["--accepter-a-decider", "sans-stop:SPY"]).status).toBe(1);
    // A position the replay already reports is not reported a second time by the net.
    const replayed = run(variant((db) => { db.prepare("UPDATE trader_positions SET quantity = quantity + 0.5 WHERE asset = 'BTC'").run(); }));
    expect(counts(replayed.last)).toMatchObject({ b: 1, d: 0 });
    expect(replayed.stdout).not.toContain("actif BTC");
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
      name: "time bounds: a price stored after now is not used, the 24 h market TTL and the limit horizon are strict, a price exactly staleMinutes old is fresh",
      stops: ["BTC"],
      build: (db) => {
        portfolio(db);
        const H = 3_600_000;
        const before = (ms: number) => new Date(T.getTime() - ms);
        // Market orders whose only price is stored one minute after now: not seen, the 24 h TTL decides.
        rawOrder(db, { id: "o_prix_futur_attend", at: before(H), asset: "SPY", side: "buy", amountEur: 20 });
        rawOrder(db, { id: "o_prix_futur_expire", at: before(25 * H), asset: "PEPE", side: "buy", amountEur: 20 });
        storePrice(db, "SPY", new Date(T.getTime() + 60_000), 500);
        storePrice(db, "PEPE", new Date(T.getTime() + 60_000), 0.00001);
        // A limit buy crossed only after now.
        rawOrder(db, { id: "o_limite_futur", at: before(H + 1000), asset: "SOL", side: "buy", kind: "limit", limitPrice: 100, amountEur: 20 });
        storePrice(db, "SOL", new Date(T.getTime() + 60_000), 90);
        // The market TTL without any price: 23 h 59 and exactly 24 h wait, 24 h and one second expires.
        rawOrder(db, { id: "o_ttl_23h59", at: before(24 * H - 60_000), asset: "TINY", side: "buy", amountEur: 20 });
        rawOrder(db, { id: "o_ttl_24h", at: before(24 * H), asset: "TINY", side: "buy", amountEur: 20 });
        rawOrder(db, { id: "o_ttl_24h_1s", at: before(24 * H + 1000), asset: "TINY", side: "buy", amountEur: 20 });
        // The limit horizon without any crossing: one second after now and exactly now wait, one second before expires.
        const horizons = [["o_horizon_plus_1s", 1000], ["o_horizon_pile", 0], ["o_horizon_moins_1s", -1000]] as const;
        horizons.forEach(([id, offset], i) => rawOrder(db, {
          id, at: before(2 * H + i * 1000), asset: "DOGE", side: "buy", kind: "limit", limitPrice: 0.05, amountEur: 20, horizonUntil: new Date(T.getTime() + offset),
        }));
        storePrice(db, "DOGE", before(H), 0.1);
        // Stops: BTC's last price is exactly staleMinutes old (fresh: placed), ETH's one second older (stale: not placed).
        storePrice(db, "BTC", before(TRADER.staleMinutes * 60_000), 40_000);
        storePrice(db, "ETH", before(TRADER.staleMinutes * 60_000 + 1000), 1_500);
        return {
          o_prix_futur_attend: "wait", o_prix_futur_expire: "expire", o_limite_futur: "wait", o_ttl_23h59: "wait", o_ttl_24h: "wait", o_ttl_24h_1s: "expire",
          o_horizon_plus_1s: "wait", o_horizon_pile: "wait", o_horizon_moins_1s: "expire",
        };
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
