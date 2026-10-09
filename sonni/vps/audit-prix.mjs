#!/usr/bin/env node
/**
 * Read-only price audit of a COPY of Sonni's memory (step 0.3, 2026-10-09). Before step 0.3 the paper broker
 * rounded fill prices and average costs to the cent: below 1 EUR fills drifted from the market, averaged
 * positions drifted from what they cost, and below 0.005 EUR a fill could store a price of 0 and an infinite
 * quantity. This script reports what a copy holds, in French, and changes nothing.
 *
 * Safety: it never opens the active database. It refuses a file named state.db, a file with a -wal or -shm
 * file beside it, and the file ~/.automaton/state.db itself. It never opens the given file with SQLite either:
 * it copies it byte for byte into a new temporary folder, opens that copy read-only, reads, deletes the copy,
 * and checks that the given file's SHA-256 did not change.
 *
 * Usage: node sonni/vps/audit-prix.mjs <copie de la base>
 *   e.g. node sonni/vps/audit-prix.mjs ~/.automaton/backups/state.db.backup-2026-10-09
 */

import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";

/** Above this, a stored REAL is the Infinity a pre-0.3 fill wrote (SQLite keeps it as 9e999). */
const HUGE = 1e300;
/** Below this price, rounding to the cent changed fills by 0.05 % or more. */
const CENT_SENSITIVE = 10;

const say = (line = "") => process.stdout.write(`${line}\n`);
const fail = (message, code = 2) => {
  process.stderr.write(`${message}\n`);
  process.exit(code);
};

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function sameFile(a, b) {
  try {
    const x = fs.statSync(a);
    const y = fs.statSync(b);
    return x.dev === y.dev && x.ino === y.ino;
  } catch {
    return false;
  }
}

/** French number; -0,00 never appears (a gap below half a cent is 0,00). */
const fr = (v, digits = 2) => (Number.isFinite(v) ? (Math.abs(v) < 0.5 * 10 ** -digits ? 0 : v).toLocaleString("fr-FR", { minimumFractionDigits: digits, maximumFractionDigits: digits }) : "non fini");
const count = (n, one, many) => `${n} ${n > 1 ? many : one}`;
const price = (v) => (!Number.isFinite(v) ? "non fini" : Math.abs(v) >= 1 || v === 0 ? `${fr(v)} €` : `${v.toLocaleString("fr-FR", { maximumSignificantDigits: 8 })} €`);

// ─── Refuse anything that could be the live database ────────────────

const source = process.argv[2];
if (!source) fail("Usage : node sonni/vps/audit-prix.mjs <copie de la base> (par exemple ~/.automaton/backups/state.db.backup-AAAA-MM-JJ)");
const file = path.resolve(source);
if (!fs.existsSync(file) || !fs.statSync(file).isFile()) fail(`Fichier introuvable : ${file}`);
const live = path.join(process.env.HOME || os.homedir(), ".automaton", "state.db");
if (path.basename(file) === "state.db" || sameFile(file, live)) {
  fail("Refusé : c'est la base active de Sonni. Donne une copie, par exemple la sauvegarde du jour dans ~/.automaton/backups/.");
}
if (fs.existsSync(`${file}-wal`) || fs.existsSync(`${file}-shm`)) {
  fail("Refusé : un fichier -wal ou -shm est à côté, signe d'une base ouverte par un programme. Donne une copie fermée.");
}

// ─── Read a private copy ────────────────────────────────────────────

const before = sha256(file);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sonni-audit-prix-"));
const copy = path.join(dir, "copie.db");
let db;
// The private copy holds all of Sonni's memory: removed on Ctrl+C, a stop or a closed SSH session too.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    try { db?.close(); } catch { /* nothing */ }
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(130);
  });
}
try {
  fs.copyFileSync(file, copy);
  // A WAL-mode copy cannot be opened read-only without its -wal file: mark our private copy as a rollback
  // journal database (header bytes 18 and 19), without SQLite writing anything.
  const fd = fs.openSync(copy, "r+");
  const header = Buffer.alloc(20);
  fs.readSync(fd, header, 0, 20, 0);
  if (header.toString("latin1", 0, 15) !== "SQLite format 3") {
    fs.closeSync(fd);
    throw new Error("Ce fichier n'est pas une base SQLite.");
  }
  if (header[18] === 2 || header[19] === 2) fs.writeSync(fd, Buffer.from([1, 1]), 0, 2, 18);
  fs.closeSync(fd);
  db = new Database(copy, { readonly: true, fileMustExist: true });
  db.pragma("query_only = ON");

  const has = (table) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  const rows = (sql, ...params) => db.prepare(sql).all(...params);
  let problems = 0;

  say("Audit des prix — copie en lecture seule (étape 0.3)");
  say(`Fichier : ${file}`);
  say("");

  if (!has("trader_orders") || !has("trader_ledger") || !has("trader_positions")) {
    say("Cette copie ne contient pas le portefeuille virtuel de Sonni (tables absentes) : rien à auditer.");
  } else {
    // 1. Figures no fill may hold: a price of 0 or less, a quantity of 0 or less, an infinite figure.
    const badOrders = rows(
      `SELECT id, asset, side, settled_at, fill_price, fill_quantity, fill_eur, fee_eur, slippage_eur FROM trader_orders
       WHERE status = 'filled' AND (fill_price IS NULL OR fill_price <= 0 OR fill_quantity IS NULL OR fill_quantity <= 0
         OR abs(fill_quantity) > ? OR abs(fill_price) > ? OR abs(COALESCE(fill_eur, 0)) > ? OR abs(COALESCE(fee_eur, 0)) > ? OR abs(COALESCE(slippage_eur, 0)) > ?)
       ORDER BY settled_at`, HUGE, HUGE, HUGE, HUGE, HUGE);
    const badLedger = rows(
      `SELECT id, at, kind, asset, quantity, price, amount_eur FROM trader_ledger
       WHERE (kind IN ('buy', 'sell') AND (quantity IS NULL OR quantity <= 0 OR quantity > ? OR price IS NULL OR price <= 0 OR price > ?))
         OR abs(amount_eur) > ? OR abs(fee_eur) > ? ORDER BY at`, HUGE, HUGE, HUGE, HUGE);
    const badPositions = rows(
      "SELECT asset, quantity, avg_cost, opened_at FROM trader_positions WHERE quantity > 0 AND (quantity > ? OR avg_cost <= 0 OR avg_cost > ?) ORDER BY asset", HUGE, HUGE);
    const badTrades = has("trader_trades") ? rows(
      `SELECT id, asset, closed_at, quantity, entry_price, exit_price, pnl_eur FROM trader_trades
       WHERE entry_price <= 0 OR exit_price <= 0 OR quantity <= 0 OR abs(quantity) > ? OR abs(entry_price) > ? OR abs(exit_price) > ?
         OR abs(fees_eur) > ? OR abs(pnl_eur) > ? OR abs(pnl_pct) > ? ORDER BY closed_at`, HUGE, HUGE, HUGE, HUGE, HUGE, HUGE) : [];
    const badDays = has("trader_portfolio_days") ? rows(
      `SELECT day, equity_eur FROM trader_portfolio_days
       WHERE abs(cash_eur) > ? OR abs(positions_eur) > ? OR abs(equity_eur) > ? OR abs(contributed_eur) > ? ORDER BY day`, HUGE, HUGE, HUGE, HUGE) : [];
    const badDecisions = has("trader_decisions") ? rows(
      "SELECT id, made_at, asset FROM trader_decisions WHERE price <= 0 OR abs(price) > ? OR abs(position_eur) > ? OR abs(equity_eur) > ? ORDER BY made_at", HUGE, HUGE, HUGE) : [];

    say("1. Chiffres invalides (prix nul, quantité nulle ou infinie, montant infini)");
    const groups = [
      [["ordre exécuté", "ordres exécutés"], badOrders, (r) => `${r.id} ${r.side} ${r.asset} le ${r.settled_at} : prix ${price(r.fill_price)}, quantité ${Number.isFinite(r.fill_quantity) ? r.fill_quantity : "non finie"}`],
      [["ligne du registre", "lignes du registre"], badLedger, (r) => `${r.id} ${r.kind} ${r.asset ?? ""} le ${r.at} : quantité ${Number.isFinite(r.quantity) ? r.quantity : "non finie"}, prix ${price(r.price)}`],
      [["position ouverte", "positions ouvertes"], badPositions, (r) => `${r.asset} : quantité ${Number.isFinite(r.quantity) ? r.quantity : "non finie"}, coût moyen ${price(r.avg_cost)} (ouverte le ${r.opened_at})`],
      [["opération close", "opérations closes"], badTrades, (r) => `${r.id} ${r.asset} le ${r.closed_at} : entrée ${price(r.entry_price)}, sortie ${price(r.exit_price)}`],
      [["instantané quotidien", "instantanés quotidiens"], badDays, (r) => `${r.day} : valeur ${fr(r.equity_eur)}`],
      [["décision", "décisions"], badDecisions, (r) => `${r.id} ${r.asset} le ${r.made_at}`],
    ];
    let invalid = 0;
    for (const [label, list, line] of groups) {
      if (list.length === 0) continue;
      invalid += list.length;
      say(`- ${count(list.length, label[0], label[1])} :`);
      for (const r of list.slice(0, 20)) say(`  · ${line(r)}`);
      if (list.length > 20) say(`  · … et ${list.length - 20} autre(s)`);
    }
    if (invalid === 0) say("- aucun");
    problems += invalid;
    say("");

    // 2. Fills below 10 EUR: how far the cent rounding put them from the market price of the same moment.
    say(`2. Exécutions au marché sous ${CENT_SENSITIVE} € (arrondies au centime avant l'étape 0.3)`);
    const fills = has("trader_prices") ? rows(
      `SELECT o.asset, o.side, o.fill_price, p.price AS market FROM trader_orders o
       JOIN trader_prices p ON p.asset = o.asset AND p.ts = o.settled_at
       WHERE o.status = 'filled' AND o.kind = 'market' AND o.fill_price > 0 AND o.fill_price < ? AND p.price > 0`, CENT_SENSITIVE) : [];
    if (fills.length === 0) say("- aucune");
    const byAsset = new Map();
    for (const f of fills) {
      const drift = Math.abs(f.fill_price / f.market - 1) * 100;
      const a = byAsset.get(f.asset) ?? { n: 0, max: 0 };
      a.n += 1;
      a.max = Math.max(a.max, drift);
      byAsset.set(f.asset, a);
    }
    for (const [asset, a] of byAsset) say(`- ${asset} : ${count(a.n, "exécution", "exécutions")}, écart maximal avec le prix du marché ${fr(a.max)} % (glissement configuré : 0,05 %)`);
    say("");

    // 3. Open positions averaged from several buys below 10 EUR: stored average cost against the ledger replay.
    say("3. Positions ouvertes moyennées (coût moyen enregistré comparé au registre)");
    let averaged = 0;
    // Every price: a cent-rounded average drifts by up to 0.005 EUR a unit, which passes a cent above about 2 units.
    for (const p of rows("SELECT asset, quantity, avg_cost, opened_at, open_order_id FROM trader_positions WHERE quantity > 0 AND quantity <= ? AND avg_cost > 0 AND avg_cost <= ? ORDER BY asset", HUGE, HUGE)) {
      // From the ledger row of the order that opened this position (append-only, so rowid is the order of
      // writing): a sale of the previous position in the same tick is not part of it.
      const start = db.prepare("SELECT rowid AS r FROM trader_ledger WHERE kind = 'buy' AND order_id = ?").get(p.open_order_id);
      const moves = start
        ? rows("SELECT kind, quantity, amount_eur, fee_eur FROM trader_ledger WHERE asset = ? AND kind IN ('buy', 'sell') AND rowid >= ? ORDER BY rowid", p.asset, start.r)
        : rows("SELECT kind, quantity, amount_eur, fee_eur FROM trader_ledger WHERE asset = ? AND kind IN ('buy', 'sell') AND at >= ? ORDER BY at, rowid", p.asset, p.opened_at);
      const buys = moves.filter((m) => m.kind === "buy").length;
      if (buys < 2) continue;
      let held = 0;
      let avg = 0;
      for (const m of moves) {
        if (m.kind === "buy") {
          const cost = -m.amount_eur - m.fee_eur;
          avg = (held * avg + cost) / (held + m.quantity);
          held += m.quantity;
        } else held -= m.quantity;
      }
      averaged += 1;
      const gap = p.quantity * (p.avg_cost - avg);
      say(`- ${p.asset} : ${buys} achats, coût moyen enregistré ${price(p.avg_cost)} contre ${price(avg)} d'après le registre, ` +
        `écart ${fr(gap)} € sur la position${Math.abs(held - p.quantity) > 1e-6 ? ` (attention : le registre donne ${fr(held, 8)} unités, la position ${fr(p.quantity, 8)})` : ""}`);
      if (Math.abs(gap) >= 0.01) problems += 1;
    }
    if (averaged === 0) say("- aucune");
    say("");

    const counts = rows("SELECT (SELECT COUNT(*) FROM trader_orders WHERE status = 'filled') AS fills, (SELECT COUNT(*) FROM trader_positions WHERE quantity > 0) AS open")[0];
    say(`Parcouru : ${count(counts.fills, "ordre exécuté", "ordres exécutés")}, ${count(counts.open, "position ouverte", "positions ouvertes")}.`);
    say(problems === 0
      ? "Conclusion : rien à réparer dans cette copie. L'étape 0.3 peut être déployée sans procédure de réparation ; ce qui a pu arriver après la copie est détecté par la nouvelle version elle-même (incident « courtier virtuel »)."
      : `Conclusion : ${count(problems, "point", "points")} à examiner. Rien n'a été modifié ; une réparation éventuelle demande une procédure séparée et ton accord.`);
  }
} catch (err) {
  process.stderr.write(`Audit impossible : ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
} finally {
  try { db?.close(); } catch { /* nothing */ }
  fs.rmSync(dir, { recursive: true, force: true });
}

const after = sha256(file);
say(after === before ? "Fichier audité inchangé (SHA-256 identique avant et après)." : "ATTENTION : le fichier a changé pendant l'audit (un autre programme l'écrit ?).");
if (after !== before) process.exitCode = 1;
