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
 * and checks that the given file's SHA-256 did not change (sonni/vps/copie-privee.mjs).
 *
 * The three sections are exported for the pre-deployment check (controle-predeploiement.mjs); run as a
 * script, the output is the one step 0.3 shipped.
 *
 * Usage: node sonni/vps/audit-prix.mjs <copie de la base>
 *   e.g. node sonni/vps/audit-prix.mjs ~/.automaton/backups/state.db.backup-2026-10-09
 */

import path from "path";
import { HUGE, count, fr, isMain, openPrivateCopy, price, refusal, sha256File } from "./copie-privee.mjs";

/** Below this price, rounding to the cent changed fills by 0.05 % or more. */
export const CENT_SENSITIVE = 10;

const hasTable = (db, table) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);

/** True when the copy holds Sonni's virtual portfolio. */
export function hasPortfolio(db) {
  return hasTable(db, "trader_orders") && hasTable(db, "trader_ledger") && hasTable(db, "trader_positions");
}

/** 1. Figures no fill may hold: a price of 0 or less, a quantity of 0 or less, an infinite figure. */
export function invalidFigures(db) {
  const rows = (sql, ...params) => db.prepare(sql).all(...params);
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
  const badTrades = hasTable(db, "trader_trades") ? rows(
    `SELECT id, asset, closed_at, quantity, entry_price, exit_price, pnl_eur FROM trader_trades
     WHERE entry_price <= 0 OR exit_price <= 0 OR quantity <= 0 OR abs(quantity) > ? OR abs(entry_price) > ? OR abs(exit_price) > ?
       OR abs(fees_eur) > ? OR abs(pnl_eur) > ? OR abs(pnl_pct) > ? ORDER BY closed_at`, HUGE, HUGE, HUGE, HUGE, HUGE, HUGE) : [];
  const badDays = hasTable(db, "trader_portfolio_days") ? rows(
    `SELECT day, equity_eur FROM trader_portfolio_days
     WHERE abs(cash_eur) > ? OR abs(positions_eur) > ? OR abs(equity_eur) > ? OR abs(contributed_eur) > ? ORDER BY day`, HUGE, HUGE, HUGE, HUGE) : [];
  const badDecisions = hasTable(db, "trader_decisions") ? rows(
    "SELECT id, made_at, asset FROM trader_decisions WHERE price <= 0 OR abs(price) > ? OR abs(position_eur) > ? OR abs(equity_eur) > ? ORDER BY made_at", HUGE, HUGE, HUGE) : [];
  return [
    { key: "orders", label: ["ordre exécuté", "ordres exécutés"], rows: badOrders, line: (r) => `${r.id} ${r.side} ${r.asset} le ${r.settled_at} : prix ${price(r.fill_price)}, quantité ${Number.isFinite(r.fill_quantity) ? r.fill_quantity : "non finie"}` },
    { key: "ledger", label: ["ligne du registre", "lignes du registre"], rows: badLedger, line: (r) => `${r.id} ${r.kind} ${r.asset ?? ""} le ${r.at} : quantité ${Number.isFinite(r.quantity) ? r.quantity : "non finie"}, prix ${price(r.price)}` },
    { key: "positions", label: ["position ouverte", "positions ouvertes"], rows: badPositions, line: (r) => `${r.asset} : quantité ${Number.isFinite(r.quantity) ? r.quantity : "non finie"}, coût moyen ${price(r.avg_cost)} (ouverte le ${r.opened_at})` },
    { key: "trades", label: ["opération close", "opérations closes"], rows: badTrades, line: (r) => `${r.id} ${r.asset} le ${r.closed_at} : entrée ${price(r.entry_price)}, sortie ${price(r.exit_price)}` },
    { key: "days", label: ["instantané quotidien", "instantanés quotidiens"], rows: badDays, line: (r) => `${r.day} : valeur ${fr(r.equity_eur)}` },
    { key: "decisions", label: ["décision", "décisions"], rows: badDecisions, line: (r) => `${r.id} ${r.asset} le ${r.made_at}` },
  ];
}

/** 2. Market fills below 10 EUR against the market price stored at the same moment, per asset. */
export function marketFillDrifts(db) {
  const fills = hasTable(db, "trader_prices") ? db.prepare(
    `SELECT o.id, o.asset, o.side, o.settled_at, o.fill_price, p.price AS market FROM trader_orders o
     JOIN trader_prices p ON p.asset = o.asset AND p.ts = o.settled_at
     WHERE o.status = 'filled' AND o.kind = 'market' AND o.fill_price > 0 AND o.fill_price < ? AND p.price > 0`).all(CENT_SENSITIVE) : [];
  return fills.map((f) => ({ ...f, driftPct: Math.abs(f.fill_price / f.market - 1) * 100 }));
}

/** 3. Open positions averaged from several buys, at any price: stored average cost against the ledger replay. */
export function averagedPositions(db) {
  const rows = (sql, ...params) => db.prepare(sql).all(...params);
  const out = [];
  // Every price: a cent-rounded average drifts by up to 0.005 EUR a unit, which passes a cent above about 2 units.
  for (const p of rows("SELECT asset, quantity, avg_cost, opened_at, open_order_id FROM trader_positions WHERE quantity > 0 AND quantity <= ? AND avg_cost > 0 AND avg_cost <= ? ORDER BY asset", HUGE, HUGE)) {
    const { buys, held, avg } = ledgerReplay(db, p);
    if (buys < 2) continue;
    out.push({ asset: p.asset, buys, quantity: p.quantity, storedAvg: p.avg_cost, ledgerAvg: avg, ledgerHeld: held, gap: p.quantity * (p.avg_cost - avg) });
  }
  return out;
}

/**
 * Units and average cost of an open position replayed from the ledger, from the ledger row of the order that
 * opened it (append-only, so rowid is the order of writing): a sale of the previous position in the same tick
 * is not part of it.
 */
export function ledgerReplay(db, p) {
  const rows = (sql, ...params) => db.prepare(sql).all(...params);
  const start = db.prepare("SELECT rowid AS r FROM trader_ledger WHERE kind = 'buy' AND order_id = ?").get(p.open_order_id);
  const moves = start
    ? rows("SELECT kind, quantity, amount_eur, fee_eur FROM trader_ledger WHERE asset = ? AND kind IN ('buy', 'sell') AND rowid >= ? ORDER BY rowid", p.asset, start.r)
    : rows("SELECT kind, quantity, amount_eur, fee_eur FROM trader_ledger WHERE asset = ? AND kind IN ('buy', 'sell') AND at >= ? ORDER BY at, rowid", p.asset, p.opened_at);
  let held = 0;
  let avg = 0;
  let buys = 0;
  for (const m of moves) {
    if (m.kind === "buy") {
      const cost = -m.amount_eur - m.fee_eur;
      avg = (held * avg + cost) / (held + m.quantity);
      held += m.quantity;
      buys += 1;
    } else held -= m.quantity;
  }
  return { buys, held, avg, fromOpeningOrder: !!start };
}

/** Writes the audit report with `say` and returns how many points need the owner's attention. */
export function auditPrices(db, say) {
  let problems = 0;
  if (!hasPortfolio(db)) {
    say("Cette copie ne contient pas le portefeuille virtuel de Sonni (tables absentes) : rien à auditer.");
    return { problems, portfolio: false };
  }
  say("1. Chiffres invalides (prix nul, quantité nulle ou infinie, montant infini)");
  let invalid = 0;
  for (const group of invalidFigures(db)) {
    const list = group.rows;
    if (list.length === 0) continue;
    invalid += list.length;
    say(`- ${count(list.length, group.label[0], group.label[1])} :`);
    for (const r of list.slice(0, 20)) say(`  · ${group.line(r)}`);
    if (list.length > 20) say(`  · … et ${list.length - 20} autre(s)`);
  }
  if (invalid === 0) say("- aucun");
  problems += invalid;
  say("");

  say(`2. Exécutions au marché sous ${CENT_SENSITIVE} € (arrondies au centime avant l'étape 0.3)`);
  const fills = marketFillDrifts(db);
  if (fills.length === 0) say("- aucune");
  const byAsset = new Map();
  for (const f of fills) {
    const a = byAsset.get(f.asset) ?? { n: 0, max: 0 };
    a.n += 1;
    a.max = Math.max(a.max, f.driftPct);
    byAsset.set(f.asset, a);
  }
  for (const [asset, a] of byAsset) say(`- ${asset} : ${count(a.n, "exécution", "exécutions")}, écart maximal avec le prix du marché ${fr(a.max)} % (glissement configuré : 0,05 %)`);
  say("");

  say("3. Positions ouvertes moyennées (coût moyen enregistré comparé au registre)");
  const averaged = averagedPositions(db);
  for (const a of averaged) {
    say(`- ${a.asset} : ${a.buys} achats, coût moyen enregistré ${price(a.storedAvg)} contre ${price(a.ledgerAvg)} d'après le registre, ` +
      `écart ${fr(a.gap)} € sur la position${Math.abs(a.ledgerHeld - a.quantity) > 1e-6 ? ` (attention : le registre donne ${fr(a.ledgerHeld, 8)} unités, la position ${fr(a.quantity, 8)})` : ""}`);
    if (Math.abs(a.gap) >= 0.01) problems += 1;
  }
  if (averaged.length === 0) say("- aucune");
  say("");

  const counts = db.prepare("SELECT (SELECT COUNT(*) FROM trader_orders WHERE status = 'filled') AS fills, (SELECT COUNT(*) FROM trader_positions WHERE quantity > 0) AS open").get();
  say(`Parcouru : ${count(counts.fills, "ordre exécuté", "ordres exécutés")}, ${count(counts.open, "position ouverte", "positions ouvertes")}.`);
  return { problems, portfolio: true };
}

function main() {
  const say = (line = "") => process.stdout.write(`${line}\n`);
  const fail = (message, code = 2) => {
    process.stderr.write(`${message}\n`);
    process.exit(code);
  };
  const source = process.argv[2];
  if (!source) fail("Usage : node sonni/vps/audit-prix.mjs <copie de la base> (par exemple ~/.automaton/backups/state.db.backup-AAAA-MM-JJ)");
  const file = path.resolve(source);
  const refused = refusal(file);
  if (refused) fail(refused);

  const before = sha256File(file);
  let copy;
  try {
    copy = openPrivateCopy(file, "sonni-audit-prix-");
    say("Audit des prix — copie en lecture seule (étape 0.3)");
    say(`Fichier : ${file}`);
    say("");
    const { problems, portfolio } = auditPrices(copy.db, say);
    if (portfolio) {
      say(problems === 0
        ? "Conclusion : rien à réparer dans cette copie. L'étape 0.3 peut être déployée sans procédure de réparation ; ce qui a pu arriver après la copie est détecté par la nouvelle version elle-même (incident « courtier virtuel »)."
        : `Conclusion : ${count(problems, "point", "points")} à examiner. Rien n'a été modifié ; une réparation éventuelle demande une procédure séparée et ton accord.`);
    }
  } catch (err) {
    process.stderr.write(`Audit impossible : ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  } finally {
    copy?.close();
  }
  const unchanged = sha256File(file) === before;
  say(unchanged ? "Fichier audité inchangé (SHA-256 identique avant et après)." : "ATTENTION : le fichier a changé pendant l'audit (un autre programme l'écrit ?).");
  if (!unchanged) process.exitCode = 1;
}

if (isMain(import.meta.url)) main();
