#!/usr/bin/env node
/**
 * Deployment gate of the controlled deployment of 2026-10-10 (steps 0.1-0.3). It reads a COPY of Sonni's memory
 * (made by sauvegarde.mjs) and reports, in French, what must stop the deployment or needs the owner's decision
 * before the new version starts on that memory:
 * - BLOQUANT: a data anomaly (failed integrity check, figures no fill may hold, negative cash, an asset whose
 *   ledger does not add up to its position, either way, a filled order without its ledger row, a trade closed by
 *   an order that is not filled). Nothing lifts it: a repair is a separate procedure the owner approves.
 * - À DÉCIDER: what the first broker tick would do on its own (an order rejected, expired or filled at an old
 *   price, a stop placed) and historical gaps the owner must accept (cent-rounded averages, market fills that
 *   drifted from the market, a position without a stop). Each point carries a short stable key (kind and order
 *   id or asset, e.g. stop-franchi:BTC, ordre-refuse:o_01J…): the owner's GO accepts points BY KEY, so a point
 *   that appears after the GO keeps blocking.
 * - INFO: freshness of the copy, orders that fill normally or wait, stop distances, restart and cost notes.
 * The broker predictions read "if Sonni restarted at <now> with this copy", <now> being by default the copy's
 * newest stored price (the moment the copy was made; the current time when it holds no price): they mirror
 * brokerTick and applyFill of src/trader/portfolio.ts on the copy's stored prices (predictPendingOrders and
 * predictStops are exported; src/__tests__/trader/deploy-predeploy.test.ts runs the real brokerTick on the same
 * copies and compares them order by order). At a real restart Sonni first collects a new price, which can fill
 * an order still waiting.
 *
 * Safety: read-only. It refuses the live database (a file named state.db, ~/.automaton/state.db by name or
 * inode, a file with -wal or -shm beside it) and never opens the given file with SQLite: it is copied byte for
 * byte into a new private temporary folder, the copy is opened read-only (query_only), the folder is removed at
 * the end and on Ctrl+C, a stop or a closed SSH session, and the given file's SHA-256 must be the same before
 * and after (sonni/vps/copie-privee.mjs). It never calls the runtime, never writes, never uses the network.
 *
 * Exit codes: 0 nothing blocks (every À DÉCIDER point's key is listed in --accepter-a-decider); 1 at least one
 * BLOQUANT, or an À DÉCIDER point whose key is not listed (the guide stops there; --accepter-a-decider never
 * lifts a BLOQUANT; a listed key that matches no point is reported as INFO and lifts nothing); 2 refused or
 * usage error (nothing read; also --accepter-a-decider without its list of keys); 3 technical error (not
 * SQLite, not a copy of Sonni's memory, unreadable file, or the file changed during the check); 130
 * interrupted (temporary copy removed). The last line of stdout is
 * `RÉSULTAT : code=<n> bloquants=<b> a_decider=<d> infos=<i>` (a_decider counts every point to decide, accepted
 * or not). When points to decide remain, the conclusion prints the exact option that accepts them all:
 * `Pour accepter exactement ces points : --accepter-a-decider <clé1>,<clé2>`.
 *
 * Usage: node sonni/vps/controle-predeploiement.mjs <copie> [--config <automaton.json>] [--maintenant <ISO>]
 *          [--accepter-a-decider <clé1,clé2,…>] [--resume]
 *   --config: trader.staleMinutes, fees, slippage and followed assets (default ~/.automaton/automaton.json if
 *     readable, else 15 min and the runtime's default fees); --maintenant: the restart moment to predict
 *     (default the copy's newest stored price); --accepter-a-decider: the keys of the points to decide the
 *     owner's GO accepted, comma-separated (the option may be repeated); --resume: a short report for Telegram
 *     (at most 3,500 characters).
 *   e.g. node sonni/vps/controle-predeploiement.mjs ~/.automaton/predeploiement/state.db.predeploiement-20261010T080000Z
 */

import os from "os";
import fs from "fs";
import path from "path";
import { HUGE, count, fr, isMain, openPrivateCopy, price, refusal, sha256File } from "./copie-privee.mjs";
import { auditPrices, averagedPositions, hasPortfolio, invalidFigures, ledgerReplay, marketFillDrifts } from "./audit-prix.mjs";

/** Runtime defaults (src/trader/config.ts DEFAULT_PORTFOLIO and the example configuration). */
export const DEFAULT_STALE_MINUTES = 15;
export const DEFAULT_PORTFOLIO = { takerFeePct: 0.8, makerFeePct: 0.4, slippageBps: 5, monthlyEur: 50 };
/** src/trader/portfolio.ts MARKET_ORDER_TTL_HOURS and SPREAD_MAX_AGE_HOURS. */
export const MARKET_ORDER_TTL_HOURS = 24;
const SPREAD_MAX_AGE_HOURS = 2;
/** A fill at a stored price older than this before the restart is the owner's decision. */
export const OLD_FILL_MINUTES = 60;
/** Market fills further than this from the market (ten times the configured 0.05 % slippage). */
export const DRIFT_ALERT_PCT = 0.5;
/** An averaged position whose stored cost differs from the ledger by this much or more. */
export const GAP_ALERT_EUR = 0.01;
/** Telegram summary limit (the sender cuts at 4,000). */
export const RESUME_MAX = 3500;

export const LEVEL = { B: "BLOQUANT", D: "À DÉCIDER", I: "INFO" };

/** A key as the owner types it after --accepter-a-decider: a kind, a colon, an asset or an order id. */
export const KEY_PATTERN = /^[a-z][a-z-]*:[A-Za-z0-9_.%-]+$/;

/**
 * The stable key of a point to decide: its kind (ecart-moyen, derive, prix-ancien, ordre-refuse, ordre-expire,
 * prevision-echouee, actif-non-suivi, sans-stop, stop-franchi) and the asset or order id it is about. Bytes
 * outside [A-Za-z0-9_.-] are percent-encoded, so a key never holds a comma, a space or a shell character and two
 * different ids never share a key.
 */
export function pointKey(kind, ident) {
  const raw = String(ident ?? "");
  let out = "";
  for (const byte of Buffer.from(raw === "" ? "?" : raw, "utf-8")) {
    const c = String.fromCharCode(byte);
    out += byte < 128 && /[A-Za-z0-9_.-]/.test(c) ? c : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return `${kind}:${out}`;
}

/** A refusal or usage error (exit 2) or a technical error the owner can read (exit 3). */
export class Stop extends Error {
  constructor(code, message) {
    super(message);
    this.exitCode = code;
  }
}

// ─── Mirrors of src/trader (same arithmetic, same SQL, same order) ──────────

const round2 = (v) => Math.round(v * 100) / 100;
const round8 = (v) => Math.round(v * 1e8) / 1e8;
const roundPrice = (v) => Number(v.toPrecision(12));
const positive = (v) => Number.isFinite(v) && v > 0;
export const isoSeconds = (date) => date.toISOString().slice(0, 19) + "Z";
const ageMinutes = (point, now) => (now.getTime() - Date.parse(point.ts)) / 60_000;
const hasTable = (db, table) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);

/**
 * The moment the copy was made, as the check reads it: its newest stored price ({ts, now}). Null when the copy
 * holds no readable price; the caller then predicts at the current time. A copy is up to a day old in Phase 1:
 * predicting at the current time would report orders the running Sonni settled minutes after the copy.
 */
export function copyMoment(db) {
  try {
    if (!hasTable(db, "trader_prices")) return null;
    const ts = db.prepare("SELECT MAX(ts) AS ts FROM trader_prices").get()?.ts;
    const t = Date.parse(ts ?? "");
    return typeof ts === "string" && Number.isFinite(t) ? { ts, now: new Date(t) } : null;
  } catch {
    return null;
  }
}

/** positionProblem of src/trader/portfolio.ts, on a trader_positions row. */
export function positionProblem(p) {
  if (!positive(p.quantity)) return "quantity";
  if (!positive(p.avg_cost)) return "avg_cost";
  return null;
}

/** figureProblem and reasonOf of src/trader/portfolio.ts. */
function figureProblem(figures, positiveNames) {
  for (const [name, v] of Object.entries(figures)) {
    if (!Number.isFinite(v) || (positiveNames.includes(name) && v <= 0)) return `${name}=${v}`;
  }
  return null;
}
const reasonOf = (name) => (name === "fill_price" || name === "avg_cost" || name === "price" ? "price" : name === "quantity" || name === "total_quantity" ? "quantity" : "amount");

function latestPrice(db, asset) {
  return db.prepare("SELECT asset, ts, price FROM trader_prices WHERE asset = ? ORDER BY ts DESC LIMIT 1").get(asset);
}

/**
 * What the first broker tick at `now` would do with this copy: brokerTick of src/trader/portfolio.ts replayed in
 * memory (pending orders by placed_at, each fill changing the positions the next orders see, then the stops and
 * the horizons). Funding and the snapshot change nothing these decisions read. Options: now (default the copy's
 * newest stored price, see copyMoment), staleMinutes,
 * portfolio ({takerFeePct, makerFeePct, slippageBps}), assets (the followed symbols, or null when unknown:
 * a stop on an asset that is not followed cannot be placed).
 */
export function simulateFirstTick(db, opts = {}) {
  const now = opts.now ?? copyMoment(db)?.now ?? new Date();
  const staleMinutes = opts.staleMinutes ?? DEFAULT_STALE_MINUTES;
  const pc = { ...DEFAULT_PORTFOLIO, ...(opts.portfolio ?? {}) };
  const followed = opts.assets ? new Set(opts.assets) : null;
  const nowIso = isoSeconds(now);
  const today = now.toISOString().slice(0, 10);
  const get = (sql, ...params) => db.prepare(sql).get(...params);
  const withKv = hasTable(db, "kv");
  const withUpdates = hasTable(db, "trader_position_updates");
  const withMetrics = hasTable(db, "trader_metrics");
  const withTrades = hasTable(db, "trader_trades");

  // Simulated state over the copy's rows: the positions cache, the kv keys the tick writes, and the fees of the
  // simulated fills (carriedEntryFees reads them back).
  const positions = new Map(db.prepare("SELECT * FROM trader_positions").all().map((r) => [r.asset, { ...r }]));
  const kv = new Map();
  const getKV = (key) => (kv.has(key) ? kv.get(key) : withKv ? get("SELECT value FROM kv WHERE key = ?", key)?.value : undefined);
  const simBuys = [];
  const simBooked = [];
  const openPositions = () => [...positions.values()].filter((p) => p.quantity > 0).sort((a, b) => (a.asset < b.asset ? -1 : a.asset > b.asset ? 1 : 0));

  const carriedEntryFees = (asset, openedAt, openOrderId) => {
    let bought = get("SELECT COALESCE(SUM(fee_eur), 0) AS f FROM trader_ledger WHERE kind = 'buy' AND asset = ? AND at >= ?", asset, openedAt).f;
    for (const b of simBuys) if (b.asset === asset && b.at >= openedAt) bought += b.fee;
    let booked = withTrades ? get(
      `SELECT COALESCE(SUM(MAX(0, t.fees_eur - COALESCE(o.fee_eur, 0))), 0) AS f FROM trader_trades t
       LEFT JOIN trader_orders o ON o.id = t.close_order_id WHERE t.asset = ? AND t.open_order_id = ?`, asset, openOrderId).f : 0;
    for (const b of simBooked) if (b.asset === asset && b.openOrderId === openOrderId) booked += b.share;
    return Math.max(0, bought - booked);
  };

  // valuation(db) of src/trader/portfolio.ts: which positions cannot be valued, and whether the total is known.
  const valuation = () => {
    const cash = round2(get("SELECT COALESCE(SUM(amount_eur), 0) AS cash FROM trader_ledger").cash);
    const contributed = round2(get("SELECT COALESCE(SUM(amount_eur), 0) AS v FROM trader_ledger WHERE kind IN ('capital', 'contribution')").v);
    const invalid = [];
    for (const p of openPositions()) {
      let problem = positionProblem(p);
      if (!problem) {
        const last = latestPrice(db, p.asset);
        const value = round2(p.quantity * (last ? last.price : p.avg_cost));
        const cost = p.quantity * p.avg_cost + carriedEntryFees(p.asset, p.opened_at, p.open_order_id);
        const pnl = round2(value - cost);
        if (Number.isFinite(value) && Number.isFinite(pnl) && cost > 0) continue;
        problem = "value";
      }
      invalid.push({ asset: p.asset, problem });
    }
    return { invalid, complete: invalid.length === 0 && Number.isFinite(cash) && Number.isFinite(contributed) };
  };

  const slippageFraction = (asset) => {
    const row = withMetrics ? get(
      `SELECT a.value AS ask, b.value AS bid, a.ts FROM trader_metrics a JOIN trader_metrics b
       ON a.source_id = b.source_id AND a.ts = b.ts AND a.metric = 'ask' AND b.metric = 'bid'
       WHERE a.source_id = ? ORDER BY a.ts DESC LIMIT 1`, `kraken_spread_${asset.toLowerCase()}`) : undefined;
    if (row && positive(row.bid) && positive(row.ask) && row.ask > row.bid && now.getTime() - Date.parse(row.ts) <= SPREAD_MAX_AGE_HOURS * 3_600_000) {
      const fraction = (row.ask - row.bid) / ((row.ask + row.bid) / 2) / 2;
      if (Number.isFinite(fraction) && fraction >= 0) return fraction;
    }
    return pc.slippageBps / 10_000;
  };

  // applyFill: every figure is checked before anything is "written" (here: before the simulated state changes).
  const applyFill = (order, px, slip, feePct, at) => {
    const reject = (reason, detail) => ({ outcome: "reject", reason, detail });
    if (!positive(px)) return reject("price", `price=${px}`);
    if (order.side === "buy") {
      if (!valuation().complete) return reject("suspended", "");
      const amount = order.amount_eur;
      const fillPrice = roundPrice(px * (1 + slip));
      const fee = round2(amount * (feePct / 100));
      const quantity = round8((amount - fee) / fillPrice);
      const slippage = round2(quantity * (fillPrice - px));
      const current = positions.get(order.asset);
      const opening = !current || current.quantity <= 0;
      if (!opening) {
        const problem = positionProblem(current);
        if (problem) return reject("position", problem);
      }
      const totalQty = opening ? quantity : round8(current.quantity + quantity);
      const avg = opening ? roundPrice((amount - fee) / quantity) : roundPrice((current.quantity * current.avg_cost + (amount - fee)) / totalQty);
      const bad = figureProblem(
        { amount, fill_price: fillPrice, quantity, total_quantity: totalQty, avg_cost: avg, fee, slippage },
        ["amount", "fill_price", "quantity", "total_quantity", "avg_cost"],
      );
      if (bad) return reject(reasonOf(bad.split("=")[0]), bad);
      simBuys.push({ asset: order.asset, at, fee });
      if (opening) {
        positions.set(order.asset, {
          asset: order.asset, quantity, avg_cost: avg, opened_at: at, open_order_id: order.id, invalidation: order.invalidation,
          horizon_until: order.horizon_until, thesis: order.thesis, updated_at: at,
        });
      } else {
        Object.assign(current, { quantity: totalQty, avg_cost: avg, invalidation: order.invalidation ?? current.invalidation, horizon_until: order.horizon_until, thesis: order.thesis, updated_at: at });
      }
      return { outcome: "fill", fillPrice, fillQuantity: quantity };
    }
    const position = positions.get(order.asset);
    if (!position || position.quantity <= 0) return reject("nothing", "");
    const problem = positionProblem(position);
    if (problem) return reject("position", problem);
    let quantity = Math.min(order.quantity, position.quantity);
    if (!(round8(position.quantity - quantity) > 0)) quantity = position.quantity;
    const left = quantity === position.quantity ? 0 : round8(position.quantity - quantity);
    const fillPrice = roundPrice(px * (1 - slip));
    const proceeds = round2(quantity * fillPrice);
    const fee = round2(proceeds * (feePct / 100));
    const slippage = round2(quantity * (px - fillPrice));
    const entryFee = (carriedEntryFees(order.asset, position.opened_at, position.open_order_id) * quantity) / position.quantity;
    const cost = quantity * position.avg_cost;
    const pnl = round2(proceeds - fee - cost);
    const pnlPct = (pnl / cost) * 100;
    const bad = figureProblem(
      { fill_price: fillPrice, quantity, proceeds, fee, slippage, entry_fee: entryFee, cost, pnl, pnl_pct: pnlPct, left },
      ["fill_price", "quantity", "cost"],
    );
    if (bad) return reject(reasonOf(bad.split("=")[0]), bad);
    simBooked.push({ asset: order.asset, openOrderId: position.open_order_id, share: Math.max(0, round2(entryFee + fee) - fee) });
    position.quantity = left;
    position.updated_at = at;
    return { outcome: "fill", fillPrice, fillQuantity: quantity };
  };

  // restoreStopLevel: a rejected stop puts the cleared level back once a day (the stop phase may place it again).
  const restoreStopLevel = (order) => {
    const p = positions.get(order.asset);
    if (!p || !(p.quantity > 0) || p.invalidation !== null) return;
    if (positionProblem(p)) return;
    const row = withUpdates ? get(
      "SELECT old_value FROM trader_position_updates WHERE asset = ? AND field = 'invalidation' AND by = 'code' AND new_value IS NULL ORDER BY at DESC, id DESC LIMIT 1",
      order.asset) : undefined;
    const level = Number(row?.old_value ?? NaN);
    const key = `sonni.stop_restored.${order.asset}`;
    if (positive(level) && getKV(key) !== today) {
      kv.set(key, today);
      p.invalidation = level;
    }
  };

  const orders = [];
  for (const o of db.prepare("SELECT * FROM trader_orders WHERE status = 'pending' ORDER BY placed_at").all()) {
    const base = { id: o.id, asset: o.asset, side: o.side, kind: o.kind, origin: o.origin, placedAt: o.placed_at, limitPrice: o.limit_price, horizonUntil: o.horizon_until };
    try {
      const after = isoSeconds(new Date(Date.parse(o.placed_at) + 1000));
      const point = o.kind === "market"
        ? db.prepare("SELECT asset, ts, price FROM trader_prices WHERE asset = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC LIMIT 1").get(o.asset, after, nowIso)
        : db.prepare(`SELECT asset, ts, price FROM trader_prices WHERE asset = ? AND ts >= ? AND ts <= ? AND price ${o.side === "buy" ? "<=" : ">="} ? ORDER BY ts ASC LIMIT 1`)
          .get(o.asset, after, nowIso, o.limit_price);
      if (point) {
        const slip = o.kind === "market" ? slippageFraction(o.asset) : 0;
        const fee = o.kind === "market" ? pc.takerFeePct : pc.makerFeePct;
        const result = applyFill(o, o.kind === "market" ? point.price : o.limit_price, slip, fee, point.ts);
        if (result.outcome === "reject" && o.origin === "stop") {
          try { restoreStopLevel(o); } catch { /* the runtime records an incident and goes on */ }
        }
        orders.push({ ...base, ...result, priceTs: point.ts, price: point.price });
        continue;
      }
      const ttl = o.kind === "market" ? Date.parse(o.placed_at) + MARKET_ORDER_TTL_HOURS * 3_600_000 : Date.parse(o.horizon_until);
      orders.push({ ...base, outcome: now.getTime() > ttl ? "expire" : "wait", until: Number.isFinite(ttl) ? new Date(ttl).toISOString() : null });
    } catch (err) {
      // The runtime leaves such an order pending (a broker incident) and retries it at the next tick.
      orders.push({ ...base, outcome: "wait", reason: "error", detail: String(err instanceof Error ? err.message : err).slice(0, 160) });
    }
  }

  const { invalid, complete } = valuation();
  const invalidAssets = new Set(invalid.map((p) => p.asset));
  const sellWaiting = (asset) => orders.find((r) => r.outcome === "wait" && r.asset === asset && r.side === "sell");
  const stops = [];
  const stopChecks = [];
  for (const p of openPositions()) {
    if (p.invalidation === null) continue;
    const last = latestPrice(db, p.asset);
    let decision;
    if (invalidAssets.has(p.asset)) decision = "invalid";
    else if (!last) decision = "no_price";
    else if (last.price > p.invalidation) decision = "not_crossed";
    else if (ageMinutes(last, now) > staleMinutes) decision = "stale";
    else if (sellWaiting(p.asset)) decision = "pending_sell";
    else if (followed && !followed.has(p.asset)) decision = "not_followed";
    else decision = "placed";
    if (decision === "placed") stops.push(p.asset);
    stopChecks.push({ asset: p.asset, decision, invalidation: p.invalidation, last: last ?? null, pendingSell: sellWaiting(p.asset)?.id ?? null });
  }
  const horizons = [];
  for (const p of openPositions()) {
    if (!p.horizon_until || p.horizon_until > nowIso || invalidAssets.has(p.asset)) continue;
    if (getKV(`sonni.horizon_seen.${p.asset}`) === p.horizon_until) continue;
    horizons.push({ asset: p.asset, horizonUntil: p.horizon_until });
  }
  return { orders, stops, stopChecks, horizons, invalid, complete, positionsAfter: openPositions() };
}

/** Predicted outcome of each pending order at the first broker tick at `now`, in brokerTick's order. */
export function predictPendingOrders(db, opts = {}) {
  return simulateFirstTick(db, opts).orders;
}

/** Assets whose stop the first broker tick at `now` places (a market sell of the whole position). */
export function predictStops(db, opts = {}) {
  return simulateFirstTick(db, opts).stops;
}

// ─── Configuration ───────────────────────────────────────────────

/**
 * Reads what the check needs from automaton.json: trader.staleMinutes, the fees and slippage, the monthly
 * contribution and the configured assets. Nothing else of the file (keys, tokens) is read or printed. An
 * explicit file that cannot be read is a usage error; the default file is optional.
 */
export function readConfig(file, explicit) {
  const result = { file: null, staleMinutes: DEFAULT_STALE_MINUTES, portfolio: { ...DEFAULT_PORTFOLIO }, assets: null, notes: [] };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (err) {
    // Never the parser's message: it can quote the file, and the file holds secrets.
    const why = err && err.code === "ENOENT" ? "fichier introuvable" : err && err.code ? "fichier illisible" : "JSON invalide";
    if (explicit) throw new Stop(2, `Configuration illisible (${why}) : ${file}`);
    result.notes.push(`aucune configuration lisible (${file}) : prix jugé ancien après ${DEFAULT_STALE_MINUTES} min (valeur par défaut), frais et glissement par défaut`);
    return result;
  }
  result.file = file;
  const trader = raw && typeof raw === "object" ? raw.trader : undefined;
  const stale = trader?.staleMinutes;
  if (Number.isInteger(stale) && stale >= 2 && stale <= 1440) result.staleMinutes = stale;
  else result.notes.push(`trader.staleMinutes absent ou invalide dans ${file} : prix jugé ancien après ${DEFAULT_STALE_MINUTES} min (valeur par défaut)`);
  if (Array.isArray(trader?.assets)) {
    const symbols = trader.assets.map((a) => a?.symbol).filter((s) => typeof s === "string");
    if (symbols.length > 0) result.assets = symbols;
  }
  const limits = { takerFeePct: [0, 5], makerFeePct: [0, 5], slippageBps: [0, 500], monthlyEur: [0, 100_000] };
  for (const [key, [min, max]] of Object.entries(limits)) {
    const v = trader?.portfolio?.[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max) result.portfolio[key] = v;
  }
  return result;
}

/**
 * The followed assets as the runtime computes them (src/trader/universe.ts activeAssets): the configured assets
 * (from the configuration, else the list the last start recorded in kv sonni.config_assets), then the
 * trader_universe log replayed in order. Null when the configured assets are unknown.
 */
export function followedAssets(db, configAssets) {
  let base = configAssets;
  if (!base && hasTable(db, "kv")) {
    try {
      const parsed = JSON.parse(db.prepare("SELECT value FROM kv WHERE key = 'sonni.config_assets'").get()?.value ?? "null");
      if (Array.isArray(parsed)) base = parsed.map((a) => a?.symbol).filter((s) => typeof s === "string");
    } catch {
      base = null;
    }
  }
  if (!base || base.length === 0) return null;
  const set = new Set(base);
  if (hasTable(db, "trader_universe")) {
    for (const row of db.prepare("SELECT asset, action FROM trader_universe ORDER BY recorded_at ASC, rowid ASC").all()) {
      if (row.action === "follow") set.add(row.asset);
      else set.delete(row.asset);
    }
  }
  return set.size > 0 ? [...set] : base;
}

// ─── French formatting ───────────────────────────────────────────

const pad = (n) => String(n).padStart(2, "0");
/** "2026-10-07T08:00:00Z" → "07/10/2026 08:00 UTC"; anything unreadable is shown as stored. */
export function when(ts) {
  const d = new Date(ts ?? "");
  if (!ts || Number.isNaN(d.getTime())) return String(ts ?? "inconnu");
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}
/** A duration in French: "45 min", "3 h 05", "4 jours". */
export function duration(ms) {
  const min = Math.floor(Math.abs(ms) / 60_000);
  if (min < 1) return "moins d'une minute";
  if (min < 60) return `${min} min`;
  if (min < 48 * 60) return `${Math.floor(min / 60)} h ${pad(min % 60)}`;
  return `${Math.floor(min / 1440)} jours`;
}
/** How old a timestamp is at `now`. */
const ago = (ts, now) => {
  const ms = now.getTime() - Date.parse(ts);
  if (!Number.isFinite(ms)) return "date illisible";
  return ms < 0 ? `${duration(ms)} après le moment contrôlé` : `il y a ${duration(ms)}`;
};
const sideFr = (side) => (side === "buy" ? "achat" : side === "sell" ? "vente" : side);
const kindFr = (kind) => (kind === "market" ? "au marché" : kind === "limit" ? "à cours limité" : kind);
const REJECT_FR = {
  price: "prix d'exécution nul, négatif ou non fini",
  quantity: "quantité nulle, négative ou non finie",
  amount: "montant en euros non fini",
  position: "la position enregistrée a des chiffres invalides",
  nothing: "rien à vendre",
  suspended: "achats suspendus : une position enregistrée ne peut pas être évaluée",
};
const PROBLEM_FR = { quantity: "quantité non finie ou invalide", avg_cost: "coût moyen nul ou invalide", value: "valeur incalculable" };
/** detailFr of src/trader/portfolio.ts: "quantity=0" → "quantité = 0". */
const FIGURE_FR = {
  price: "prix du marché", fill_price: "prix d'exécution", quantity: "quantité", total_quantity: "quantité totale", avg_cost: "coût moyen",
  amount: "montant", fee: "frais", slippage: "glissement", proceeds: "produit de la vente", entry_fee: "frais d'achat", cost: "coût",
  pnl: "résultat", pnl_pct: "résultat en %", left: "reste", value: "valeur",
};
const VALUE_FR = (v) => (v === "Infinity" ? "infini" : v === "-Infinity" ? "moins l'infini" : v === "NaN" ? "indéfini" : v.replace(".", ","));
function detailFr(reason, detail) {
  if (!detail) return "";
  if (reason === "position" && detail in PROBLEM_FR) return PROBLEM_FR[detail];
  const m = /^(\w+)=(.*)$/.exec(detail);
  return m ? `${FIGURE_FR[m[1]] ?? m[1]} = ${VALUE_FR(m[2])}` : detail;
}
const INCIDENT_FR = {
  pause: "pause automatique", cap: "plafond atteint", unknown_cost: "coût d'inférence inconnu", errors: "série d'erreurs",
  truncated: "réponse coupée", unknown_stop: "raison d'arrêt inconnue", no_progress: "cycles sans progrès",
  source_disabled: "source désactivée", reader_refused: "IA lectrice refusée", backup: "sauvegarde", loop: "boucle",
  brain_offline: "second cerveau injoignable", brain_recount: "compteur du second cerveau remis à zéro", broker: "courtier virtuel",
};
const qty = (v) => (Number.isFinite(v) ? v.toLocaleString("fr-FR", { maximumFractionDigits: 8 }) : "non finie");
/** "0,5 unité enregistrée", "3 unités enregistrées" (French plural from 2). */
const units = (v, one, many) => `${qty(v)} ${Number.isFinite(v) && Math.abs(v) < 2 ? one : many}`;
/** SQLite and file-system error codes in French. */
const ERROR_CODE_FR = {
  SQLITE_CORRUPT: "fichier de base endommagé", SQLITE_NOTADB: "ce fichier n'est pas une base SQLite", SQLITE_IOERR: "erreur de lecture du disque",
  SQLITE_FULL: "espace disque insuffisant", SQLITE_CANTOPEN: "fichier impossible à ouvrir", ENOENT: "fichier introuvable", EACCES: "accès refusé",
  EPERM: "accès refusé", ENOSPC: "espace disque insuffisant", EIO: "erreur de lecture du disque",
};
/**
 * A technical error for the owner, in French: the usual SQLite messages are translated; anything else keeps the
 * raw message after a French label (it never holds a secret: it comes from SQLite or the file system).
 */
export function technicalFr(err) {
  const message = String(err instanceof Error ? err.message : err).slice(0, 160);
  if (/^Ce fichier n'est pas une base SQLite/.test(message)) return "Ce fichier n'est pas une base SQLite.";
  const table = /no such table: (\S+)/.exec(message);
  if (table) return `table manquante dans la copie : ${table[1]}`;
  const column = /no such column: (\S+)/.exec(message);
  if (column) return `colonne manquante dans la copie : ${column[1]}`;
  if (/malformed/.test(message)) return "fichier de base endommagé";
  const code = err && typeof err === "object" && typeof err.code === "string" ? err.code : "";
  const known = ERROR_CODE_FR[code] ?? ERROR_CODE_FR[code.split("_").slice(0, 2).join("_")];
  return known ? `${known} (détail technique : ${message})` : `détail technique : ${message}`;
}
const examples = (list, n = 5) => `${list.slice(0, n).join(", ")}${list.length > n ? ` … (+${list.length - n})` : ""}`;

// ─── The check ───────────────────────────────────────────────────

/**
 * Runs sections A to H on an open read-only copy. Returns the report lines and the findings
 * ({level: "B" | "D" | "I", text, key}; every À DÉCIDER finding has a key, see pointKey); throws Stop(3) when
 * the copy is not Sonni's memory.
 */
export function controle(db, ctx) {
  const now = ctx.now;
  const nowIso = isoSeconds(now);
  const staleMinutes = ctx.staleMinutes ?? DEFAULT_STALE_MINUTES;
  const lines = [];
  const findings = [];
  const say = (line = "") => lines.push(line);
  const add = (level, text, key) => {
    const f = key ? { level, text, key } : { level, text };
    findings.push(f);
    say(`   ${findingLine(f)}`);
  };
  const get = (sql, ...params) => db.prepare(sql).get(...params);
  const all = (sql, ...params) => db.prepare(sql).all(...params);
  const section = (title, body) => {
    say(title);
    try {
      body();
    } catch (err) {
      if (err instanceof Stop) throw err;
      add("B", `section illisible (copie endommagée ?) : ${technicalFr(err)}`);
    }
    say("");
  };
  for (const note of ctx.notes ?? []) add("I", note);
  if (ctx.notes?.length) say("");

  let readable = true;
  section("A. Intégrité", () => {
    let result;
    try {
      result = db.pragma("integrity_check").map((r) => String(Object.values(r)[0]));
    } catch (err) {
      if (err && err.code === "SQLITE_NOTADB") throw new Stop(3, "Ce fichier n'est pas une base SQLite.");
      result = [technicalFr(err)];
    }
    if (result.length === 1 && result[0] === "ok") add("I", "contrôle d'intégrité SQLite : ok");
    // SQLite's own diagnostics have no French version: shown after a French label.
    else add("B", `contrôle d'intégrité SQLite en échec (${count(result.length, "problème", "problèmes")}) ; détail technique : ${examples(result.map((r) => r.slice(0, 120)), 3)}`);
    let portfolio;
    try {
      portfolio = hasPortfolio(db);
    } catch (err) {
      if (err && err.code === "SQLITE_NOTADB") throw new Stop(3, "Ce fichier n'est pas une base SQLite.");
      readable = false;
      add("B", `tables illisibles : ${technicalFr(err)}`);
      return;
    }
    if (!portfolio) throw new Stop(3, "Ce n'est pas une copie de la mémoire de Sonni (tables du portefeuille virtuel absentes).");
  });
  if (!readable) return { lines, findings };

  section("B. Fraîcheur de la copie", () => {
    const newest = [
      ["trader_prices", "ts", "dernier prix enregistré"],
      ["trader_orders", "placed_at", "dernier ordre passé"],
      ["trader_orders", "settled_at", "dernier ordre réglé"],
      ["trader_ledger", "at", "dernière ligne du registre"],
    ];
    for (const [table, column, label] of newest) {
      if (!hasTable(db, table)) continue;
      const ts = get(`SELECT MAX(${column}) AS ts FROM ${table}`).ts;
      add("I", ts ? `${label} : ${when(ts)} (${ago(ts, now)})` : `${label} : aucun`);
    }
    if (hasTable(db, "trader_prices")) {
      const perAsset = all("SELECT asset, MAX(ts) AS ts FROM trader_prices GROUP BY asset ORDER BY asset");
      if (perAsset.length) add("I", `derniers prix par actif : ${perAsset.map((r) => `${r.asset} ${ago(r.ts, now)}`).join(", ")}`);
    }
  });

  section("C. Audit des prix (même rapport que audit-prix.mjs)", () => {
    auditPrices(db, (line = "") => say(line ? `   ${line}` : ""));
    say("   Classement :");
    let classified = 0;
    for (const group of invalidFigures(db)) {
      if (group.rows.length === 0) continue;
      classified += 1;
      const n = group.rows.length;
      if (group.key === "positions") {
        add("B", `${count(n, "position ouverte invalide", "positions ouvertes invalides")} (${examples(group.rows.map((r) => r.asset))}) : ` +
          "la nouvelle version suspend les achats, les décisions et les instantanés et ne pose aucun stop sur elle");
      } else {
        add("B", `${count(n, group.label[0], group.label[1])} avec un chiffre invalide (prix nul, quantité nulle ou infinie, montant infini) : ${examples(group.rows.map((r) => String(r.id ?? r.day ?? r.asset)))}`);
      }
    }
    for (const a of averagedPositions(db)) {
      if (Math.abs(a.gap) < GAP_ALERT_EUR) continue;
      classified += 1;
      add("D", `${a.asset} : coût moyen enregistré ${price(a.storedAvg)} contre ${price(a.ledgerAvg)} d'après le registre, écart ${fr(a.gap)} € sur la position : écart historique d'arrondi, aucune réparation automatique`,
        pointKey("ecart-moyen", a.asset));
    }
    const byAsset = new Map();
    for (const f of marketFillDrifts(db)) {
      if (!(f.driftPct > DRIFT_ALERT_PCT)) continue;
      const a = byAsset.get(f.asset) ?? { n: 0, max: 0 };
      a.n += 1;
      a.max = Math.max(a.max, f.driftPct);
      byAsset.set(f.asset, a);
    }
    for (const [asset, a] of byAsset) {
      classified += 1;
      add("D", `${asset} : ${count(a.n, "exécution au marché", "exécutions au marché")} à plus de ${fr(DRIFT_ALERT_PCT, 1)} % du prix du marché (jusqu'à ${fr(a.max)} %, dix fois le glissement configuré) : écart historique d'arrondi, aucune réparation automatique`,
        pointKey("derive", asset));
    }
    if (classified === 0) say("   - rien à classer");
  });

  section("D. Rapprochement du portefeuille", () => {
    let problems = 0;
    const cash = get("SELECT COALESCE(SUM(amount_eur), 0) AS cash FROM trader_ledger").cash;
    if (!Number.isFinite(cash) || round2(cash) < 0) {
      problems += 1;
      add("B", `liquidités ${Number.isFinite(cash) ? `négatives : ${fr(cash)} €` : "non calculables"} d'après le registre`);
    } else say(`   - liquidités d'après le registre : ${fr(cash)} €`);
    // Each open position against the ledger replayed from its opening order.
    const replayed = new Set();
    for (const p of all("SELECT * FROM trader_positions WHERE quantity > 0 AND quantity <= ? ORDER BY asset", HUGE)) {
      const replay = ledgerReplay(db, p);
      const diff = replay.held - p.quantity;
      if (!(Math.abs(diff) <= 1e-6)) {
        problems += 1;
        replayed.add(p.asset);
        add("B", `position ${p.asset} : ${units(p.quantity, "unité enregistrée", "unités enregistrées")}, le registre en donne ${qty(replay.held)} (écart ${qty(diff)})` +
          `${replay.fromOpeningOrder ? "" : " ; ligne d'achat de l'ordre d'ouverture introuvable, registre relu depuis la date d'ouverture"}`);
      }
    }
    // The other way: every asset of the ledger (and of the positions table) nets to its position, 0 when there is
    // no row or the row is closed. Catches units the ledger still holds without a position, and a closed position
    // whose ledger does not come back to 0. Assets already reported above, and figures section C reports as
    // invalid (an infinite or missing ledger quantity, an infinite position), are not counted twice.
    const ledgerMoves = new Map();
    for (const m of all("SELECT asset, kind, quantity FROM trader_ledger WHERE kind IN ('buy', 'sell') AND asset IS NOT NULL ORDER BY at, rowid")) {
      const a = ledgerMoves.get(m.asset) ?? { net: 0, peak: 0, unreadable: false };
      if (typeof m.quantity !== "number" || !Number.isFinite(m.quantity)) a.unreadable = true;
      else {
        a.net += m.kind === "buy" ? m.quantity : -m.quantity;
        a.peak = Math.max(a.peak, Math.abs(a.net), Math.abs(m.quantity));
      }
      ledgerMoves.set(m.asset, a);
    }
    const positionRows = new Map(all("SELECT asset, quantity FROM trader_positions").map((r) => [r.asset, r]));
    const netMismatches = [];
    for (const asset of [...new Set([...ledgerMoves.keys(), ...positionRows.keys()])].sort()) {
      if (replayed.has(asset)) continue;
      const moves = ledgerMoves.get(asset) ?? { net: 0, peak: 0, unreadable: false };
      const row = positionRows.get(asset);
      if (moves.unreadable || (row && typeof row.quantity === "number" && row.quantity > HUGE)) continue;
      const held = row ? (typeof row.quantity === "number" ? row.quantity : NaN) : 0;
      const diff = moves.net - held;
      // Float sums of round8 quantities: a millionth of a unit, or a billionth of the largest quantity involved.
      const tolerance = Math.max(1e-6, 1e-9 * Math.max(Math.abs(held), moves.peak));
      if (Math.abs(diff) <= tolerance) continue;
      netMismatches.push(asset);
      add("B", `actif ${asset} : le registre en donne ${units(moves.net, "unité", "unités")} au total (achats moins ventes), ` +
        `${!row ? "aucune position enregistrée" : held > 0 ? `la position en compte ${qty(held)}` : `la position enregistrée est à ${qty(held)} (close)`} (écart ${qty(diff)})`);
    }
    problems += netMismatches.length;
    const unbooked = all(
      `SELECT * FROM (SELECT o.id, o.asset, o.side, o.settled_at,
         (SELECT COUNT(*) FROM trader_ledger l WHERE l.order_id = o.id AND l.kind IN ('buy', 'sell')) AS n
       FROM trader_orders o WHERE o.status = 'filled') WHERE n != 1 ORDER BY settled_at`);
    if (unbooked.length) {
      problems += 1;
      add("B", `${count(unbooked.length, "ordre exécuté", "ordres exécutés")} sans exactement une ligne d'achat ou de vente au registre : ` +
        examples(unbooked.map((o) => `${o.id} (${sideFr(o.side)} ${o.asset} le ${when(o.settled_at)}, ${count(o.n, "ligne", "lignes")})`)));
    }
    if (hasTable(db, "trader_trades")) {
      const orphan = all(
        `SELECT t.id, t.asset, t.closed_at, t.close_order_id, o.status FROM trader_trades t LEFT JOIN trader_orders o ON o.id = t.close_order_id
         WHERE o.id IS NULL OR o.status != 'filled' ORDER BY t.closed_at`);
      if (orphan.length) {
        problems += 1;
        add("B", `${count(orphan.length, "opération close", "opérations closes")} par un ordre qui n'est pas exécuté : ` +
          examples(orphan.map((t) => `${t.id} (${t.asset} le ${when(t.closed_at)}, ordre ${t.close_order_id} ${t.status ? `au statut ${t.status}` : "introuvable"})`)));
      }
    }
    if (problems === 0) say("   - registre, positions, ordres et opérations concordent");
  });

  let sim = null;
  section(`E. Ordres en attente : ce que ferait le premier relevé du ${when(nowIso)}`, () => {
    say("   (prévision avec les prix de la copie ; au redémarrage, Sonni relève d'abord un nouveau prix : un ordre qui attend");
    say("   ou qui expirerait peut alors s'exécuter à ce nouveau prix)");
    sim = simulateFirstTick(db, { now, staleMinutes, portfolio: ctx.portfolio, assets: ctx.assets });
    if (sim.orders.length === 0) say("   - aucun ordre en attente");
    for (const o of sim.orders) {
      const head = `${o.id} : ${sideFr(o.side)} ${kindFr(o.kind)} ${o.asset}${o.origin === "stop" ? " (stop)" : ""} passé le ${when(o.placedAt)}`;
      if (o.outcome === "fill") {
        const old = now.getTime() - Date.parse(o.priceTs) > OLD_FILL_MINUTES * 60_000;
        const text = `${head} : exécuté au prix enregistré du ${when(o.priceTs)} (${price(o.price)} ; prix d'exécution ${price(o.fillPrice)})`;
        if (old) add("D", `${text} : exécution à un prix ancien du ${when(o.priceTs)} (${ago(o.priceTs, now)})`, pointKey("prix-ancien", o.id));
        else add("I", text);
      } else if (o.outcome === "reject") {
        const detail = detailFr(o.reason, o.detail);
        add("D", `${head} : refusé (${REJECT_FR[o.reason] ?? o.reason}${detail ? ` : ${detail}` : ""}) ; rien n'est inscrit au registre, un incident « courtier virtuel » est noté`,
          pointKey("ordre-refuse", o.id));
      } else if (o.outcome === "expire") {
        add("D", o.kind === "market"
          ? `${head} : expiré (aucun prix enregistré dans les ${MARKET_ORDER_TTL_HOURS} h suivant l'ordre)`
          : `${head} : expiré (limite ${price(o.limitPrice)} non atteinte avant l'échéance du ${when(o.horizonUntil)})`, pointKey("ordre-expire", o.id));
      } else if (o.reason === "error") {
        add("D", `${head} : la prévision échoue (${technicalFr(o.detail)}) ; le courtier le laisserait en attente avec un incident`, pointKey("prevision-echouee", o.id));
      } else {
        add("I", o.kind === "market"
          ? `${head} : attend un prix (exécuté au premier prix relevé, expiré après le ${when(o.until)})`
          : `${head} : attend que le prix atteigne ${price(o.limitPrice)} (jusqu'au ${when(o.horizonUntil)})`);
      }
    }
  });

  section("F. Stops et protections", () => {
    if (!sim) {
      add("B", "prévision du premier relevé impossible (voir E) : stops non contrôlés");
      return;
    }
    // Judged on the positions as the first tick leaves them (section E): a buy that fills can open a position or
    // replace its level, a rejected stop can put its level back, a sale can close it. The stop phase reads that.
    say("   (positions et niveaux de stop tels que le premier relevé prévu en E les laisse)");
    const checks = new Map(sim.stopChecks.map((c) => [c.asset, c]));
    const invalidAfter = new Map(sim.invalid.map((x) => [x.asset, x.problem]));
    const followed = ctx.assets ? new Set(ctx.assets) : null;
    const stored = new Map(all("SELECT * FROM trader_positions WHERE quantity > 0").map((p) => [p.asset, p]));
    const after = new Map(sim.positionsAfter.map((p) => [p.asset, p]));
    const assets = [...new Set([...stored.keys(), ...after.keys()])].sort();
    if (assets.length === 0) say("   - aucune position ouverte");
    const sellWaiting = (asset) => sim.orders.find((o) => o.asset === asset && o.side === "sell" && o.outcome === "wait");
    for (const asset of assets) {
      const before = stored.get(asset);
      const p = after.get(asset);
      if (before && positionProblem(before)) {
        say(`   - ${asset} : position invalide, aucun stop possible (voir C)`);
        continue;
      }
      if (!p) {
        const sold = sim.orders.filter((o) => o.asset === asset && o.side === "sell" && o.outcome === "fill").pop();
        add("I", `${asset} : position vendue au premier relevé${sold ? ` (ordre ${sold.id})` : ""}, plus de stop à poser`);
        continue;
      }
      if (invalidAfter.has(asset)) {
        add("B", `${asset} : position impossible à évaluer après le premier relevé (${PROBLEM_FR[invalidAfter.get(asset)] ?? invalidAfter.get(asset)}) : ` +
          "la nouvelle version suspend les achats, les décisions et les instantanés et ne pose aucun stop sur elle");
        continue;
      }
      const level = p.invalidation;
      // Where the level comes from when the tick changes it (the copy's own level is shown as stored).
      const origin = !before ? " ; position ouverte au premier relevé par un achat en attente"
        : before.invalidation !== level ? ` ; niveau fixé au premier relevé (niveau enregistré : ${before.invalidation === null ? "aucun" : price(before.invalidation)})` : "";
      if (followed && !followed.has(asset)) {
        add("D", `${asset} : actif plus suivi d'après la configuration, aucun prix ne sera relevé et aucun stop ne peut être posé`, pointKey("actif-non-suivi", asset));
      }
      const last = latestPrice(db, asset);
      if (level === null) {
        const waiting = sellWaiting(asset);
        if (waiting) add("I", `${asset} : pas de niveau de stop, une vente est en attente (ordre ${waiting.id})${origin}`);
        else add("D", `${asset} : position sans stop (aucun niveau d'invalidation, aucune vente en attente)${origin}`, pointKey("sans-stop", asset));
        continue;
      }
      const check = checks.get(asset);
      if (last && last.price <= level) {
        const fresh = ageMinutes(last, now) <= staleMinutes;
        let next;
        if (check?.decision === "placed") next = `prix frais (${ago(last.ts, now)}) : la nouvelle version pose le stop dès le premier relevé`;
        else if (check?.decision === "pending_sell") next = `une vente est déjà en attente (ordre ${check.pendingSell}) : pas de nouveau stop`;
        else if (check?.decision === "not_followed") next = "actif plus suivi : le stop ne peut pas être posé";
        else if (!fresh) next = `prix ancien (${ago(last.ts, now)}, au-delà de ${staleMinutes} min) : le stop sera posé dès qu'un prix frais arrive, s'il reste sous le niveau`;
        else next = "le stop n'est pas posé au premier relevé";
        add("D", `${asset} : stop franchi d'après le dernier prix connu (${price(last.price)} le ${when(last.ts)}) : vente au premier relevé si le prix reste sous ${price(level)} ; ${next}${origin}`,
          pointKey("stop-franchi", asset));
      } else if (last) {
        add("I", `${asset} : stop à ${price(level)}, ${fr(((last.price - level) / last.price) * 100)} % sous le dernier prix (${price(last.price)} le ${when(last.ts)})${origin}`);
      } else {
        add("I", `${asset} : stop à ${price(level)}, aucun prix enregistré${origin}`);
      }
    }
  });

  section("G. Redémarrage et coûts", () => {
    const kv = (key) => (hasTable(db, "kv") ? get("SELECT value FROM kv WHERE key = ?", key)?.value : undefined);
    // src/index.ts: a restart while asleep keeps the sleep, unless a message from the owner waits.
    const state = kv("agent_state");
    const until = Date.parse(kv("sleep_until") ?? "");
    const waiting = hasTable(db, "inbox_messages") ? get("SELECT COUNT(*) AS n FROM inbox_messages WHERE processed_at IS NULL").n : 0;
    if (state === "sleeping" && Number.isFinite(until) && until > now.getTime() + 60_000 && waiting === 0) {
      add("I", `Sonni reprendra son sommeil jusqu'au ${when(new Date(until).toISOString())} : pas de cycle payé au redémarrage`);
    } else {
      const why = waiting > 0 ? `${count(waiting, "message de ta part attend", "messages de ta part attendent")}`
        : state !== "sleeping" ? `Sonni n'était pas endormi, état enregistré : ${state ?? "aucun"}`
          : Number.isFinite(until) ? `son sommeil finit le ${when(new Date(until).toISOString())}` : "aucune fin de sommeil enregistrée";
      add("I", `le redémarrage lancera un cycle payé : ${why}`);
    }
    const paused = kv("money_lab.paused");
    if (paused !== undefined) {
      let reason = "raison illisible";
      try {
        reason = String(JSON.parse(paused)?.reason ?? reason);
      } catch { /* an unreadable record still means paused */ }
      add("I", `Sonni est en pause (${reason.slice(0, 120)}) : aucun cycle tant que tu ne l'as pas relancé (/reprendre)`);
    }
    for (const h of sim?.horizons ?? []) add("I", `échéance de la position ${h.asset} passée (${when(h.horizonUntil)}) : réveil payé pour revoir ${h.asset}`);
    const month = kv("sonni.portfolio_month");
    const nowMonth = nowIso.slice(0, 7);
    if (month === undefined) add("I", "capital virtuel de départ inscrit au premier relevé");
    else if (month < nowMonth && (ctx.portfolio?.monthlyEur ?? DEFAULT_PORTFOLIO.monthlyEur) > 0) {
      add("I", `versement virtuel du mois au premier relevé (${fr(ctx.portfolio?.monthlyEur ?? DEFAULT_PORTFOLIO.monthlyEur)} €, dernier mois versé : ${month})`);
    }
  });

  section("H. Historique", () => {
    if (hasTable(db, "trader_portfolio_days")) {
      const days = all("SELECT day FROM trader_portfolio_days ORDER BY day").map((r) => r.day);
      if (days.length === 0) add("I", "aucun instantané quotidien");
      else {
        const have = new Set(days);
        const missing = [];
        for (let t = Date.parse(`${days[0]}T00:00:00Z`); t <= Date.parse(`${days[days.length - 1]}T00:00:00Z`); t += 86_400_000) {
          const day = new Date(t).toISOString().slice(0, 10);
          if (!have.has(day)) missing.push(day);
        }
        // Consecutive missing days shown as ranges.
        const ranges = [];
        for (const day of missing) {
          const lastRange = ranges[ranges.length - 1];
          if (lastRange && Date.parse(`${day}T00:00:00Z`) - Date.parse(`${lastRange[1]}T00:00:00Z`) === 86_400_000) lastRange[1] = day;
          else ranges.push([day, day]);
        }
        add("I", missing.length === 0
          ? `instantanés quotidiens complets du ${days[0]} au ${days[days.length - 1]}`
          : `${count(missing.length, "jour", "jours")} sans instantané entre le ${days[0]} et le ${days[days.length - 1]} : ${examples(ranges.map(([a, b]) => (a === b ? a : `${a} → ${b}`)), 8)}`);
      }
    }
    if (hasTable(db, "trader_incidents")) {
      const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
      const kinds = all("SELECT kind, COUNT(*) AS n FROM trader_incidents WHERE at >= ? AND at <= ? GROUP BY kind ORDER BY n DESC, kind", since, now.toISOString());
      if (kinds.length === 0) add("I", "aucun incident les 7 derniers jours");
      else add("I", `incidents des 7 derniers jours : ${kinds.map((k) => `${INCIDENT_FR[k.kind] ?? k.kind} ${k.n}`).join(", ")}`);
      for (const kind of ["broker", "backup"]) {
        const rows = all("SELECT at, message FROM trader_incidents WHERE kind = ? AND at >= ? AND at <= ? ORDER BY at DESC LIMIT 3", kind, since, now.toISOString());
        for (const r of rows) add("I", `incident « ${INCIDENT_FR[kind]} » du ${when(r.at)} : ${String(r.message).slice(0, 200)}`);
      }
    }
  });
  return { lines, findings };
}

// ─── Verdict ─────────────────────────────────────────────────────

/** A finding as printed: "[À DÉCIDER] (clé stop-franchi:BTC) BTC : …", "[À DÉCIDER, accepté] …" once its key is listed. */
export function findingLine(f, accepted) {
  const tag = f.level === "D" && f.key && accepted?.has(f.key) ? `${LEVEL.D}, accepté` : LEVEL[f.level];
  return `[${tag}]${f.key ? ` (clé ${f.key})` : ""} ${f.text}`;
}

/**
 * What the keys listed with --accepter-a-decider lift. Only a point to decide whose key is listed is lifted (a
 * point without a key never is); a BLOQUANT is never touched. Returns the distinct keys of all points to decide in
 * report order, the lifted keys, the points still to decide and the listed keys that match no point.
 */
export function acceptance(findings, acceptedKeys = []) {
  const accepted = new Set(acceptedKeys);
  const decide = findings.filter((f) => f.level === "D");
  const keys = [...new Set(decide.map((f) => f.key).filter(Boolean))];
  return {
    accepted,
    keys,
    lifted: keys.filter((k) => accepted.has(k)),
    remaining: decide.filter((f) => !(f.key && accepted.has(f.key))),
    unused: [...accepted].filter((k) => !keys.includes(k)),
  };
}

/** Exit code of a finished check (before the SHA-256 comparison): 1 on any BLOQUANT or any point to decide not listed. */
export function verdictCode(findings, acceptedKeys = []) {
  const b = findings.filter((f) => f.level === "B").length;
  return b > 0 || acceptance(findings, acceptedKeys).remaining.length > 0 ? 1 : 0;
}

/** INFO findings for listed keys that match no point to decide: reported, they lift nothing and block nothing. */
export function unusedKeyFindings(findings, acceptedKeys = []) {
  return acceptance(findings, acceptedKeys).unused.map((k) => ({
    level: "I", unusedKey: k, text: `clé acceptée sans objet : ${k} (aucun point à décider de cette copie ne porte cette clé ; elle ne lève rien)`,
  }));
}

const ACCEPT_PREFIX = "Pour accepter exactement ces points : ";

/** The French conclusion, addressed to the owner: the verdict and, when points to decide remain, the option to copy. */
function ruleLines(findings, acceptedKeys) {
  const b = findings.filter((f) => f.level === "B").length;
  const { accepted, keys, lifted, remaining } = acceptance(findings, acceptedKeys);
  const option = remaining.length > 0 ? [`${ACCEPT_PREFIX}--accepter-a-decider ${keys.join(",")}`] : [];
  if (b > 0) {
    return [
      "Déploiement bloqué : ne démarre pas la nouvelle version ; envoie-moi ce rapport et décide de la suite (rien n'a été modifié ; une réparation demande une procédure séparée et ton accord)." +
        (accepted.size > 0 || remaining.length > 0 ? " L'option --accepter-a-decider ne lève jamais un point bloquant." : ""),
      ...option,
    ];
  }
  if (remaining.length > 0) {
    const open = [...new Set(remaining.map((f) => f.key))];
    return [
      `Déploiement bloqué : ne démarre pas la nouvelle version ; envoie-moi ce rapport et décide de chaque point « À DÉCIDER » (${count(open.length, "point non accepté", "points non acceptés")} : ${examples(open, 10)}).`,
      ...option,
    ];
  }
  if (lifted.length > 0) return [`Conclusion : rien ne bloque (${count(lifted.length, "point à décider levé", "points à décider levés")} par --accepter-a-decider : ${examples(lifted, 20)}).`];
  return ["Conclusion : rien ne bloque, le déploiement peut continuer."];
}

const resultLine = (code, findings) =>
  `RÉSULTAT : code=${code} bloquants=${findings.filter((f) => f.level === "B").length} a_decider=${findings.filter((f) => f.level === "D").length} infos=${findings.filter((f) => f.level === "I").length}`;

/** Where the predicted moment comes from, in French. */
function momentFr(now, source) {
  const at = when(isoSeconds(now));
  if (source === "copie") return `prévision au moment de la copie : ${at}`;
  if (source === "horloge") return `prévision à l'heure actuelle : ${at}, la copie n'a aucun prix`;
  return `prévision au ${at} (--maintenant)`;
}

/**
 * The short French report for Telegram: verdict, counts, BLOQUANT and À DÉCIDER lines with their keys, the keys
 * that matched nothing, the conclusion, at most `max` characters. `nowSource`: "copie", "horloge" or "option".
 */
export function resume(findings, { file, now, nowSource = "option", accepted = [], code, unchanged = true }, max = RESUME_MAX) {
  const acc = acceptance(findings, accepted);
  const b = findings.filter((f) => f.level === "B");
  const d = findings.filter((f) => f.level === "D");
  const unused = findings.filter((f) => f.unusedKey);
  const liftedCount = d.length - acc.remaining.length;
  const head = [
    `Contrôle avant déploiement de Sonni : ${code === 0 ? "rien ne bloque" : code === 1 ? "déploiement bloqué" : "contrôle impossible"}`,
    `Copie : ${path.basename(file)} ; ${momentFr(now, nowSource)}`,
    `Bloquants : ${b.length} ; à décider : ${d.length}${liftedCount ? ` (dont ${liftedCount} accepté${liftedCount > 1 ? "s" : ""})` : ""} ; infos : ${findings.length - b.length - d.length}`,
  ];
  const size = (list) => list.reduce((s, l) => s + l.length + 1, 0);
  const tailOf = (rules) => [...rules, unchanged ? "Fichier contrôlé inchangé (SHA-256 identique avant et après)." : "ATTENTION : le fichier a changé pendant le contrôle.", resultLine(code, findings)];
  let rules = ruleLines(findings, accepted);
  let tail = tailOf(rules);
  // A very long list of keys does not fit in a message: the terminal report has it in full.
  if (size(head) + size(tail) > max - 1000) {
    rules = rules.map((l) => (l.startsWith(ACCEPT_PREFIX) ? `${ACCEPT_PREFIX}${count(acc.keys.length, "clé", "clés")}, liste trop longue pour ce message : copie-la depuis le terminal` : l));
    tail = tailOf(rules);
  }
  const body = [];
  if (b.length) body.push("BLOQUANT :", ...b.map((f) => `- ${f.text.slice(0, 300)}`));
  if (d.length) body.push("À DÉCIDER :", ...d.map((f) => `- ${`${acc.accepted.has(f.key) ? "[accepté] " : ""}(clé ${f.key}) ${f.text}`.slice(0, 300)}`));
  if (unused.length) body.push("INFO :", ...unused.map((f) => `- ${f.text.slice(0, 300)}`));
  const fixed = size(head) + size(tail);
  const kept = [];
  for (let i = 0; i < body.length; i += 1) {
    const rest = body.length - i;
    const more = `… et ${rest} autre(s) ligne(s) : rapport complet dans le terminal`;
    if (fixed + size(kept) + body[i].length + 1 + (rest > 1 ? more.length + 1 : 0) > max) {
      kept.push(more);
      break;
    }
    kept.push(body[i]);
  }
  return [...head, ...kept, ...tail].join("\n");
}

// ─── Command line ────────────────────────────────────────────────

const USAGE = "Usage : node sonni/vps/controle-predeploiement.mjs <copie> [--config <automaton.json>] [--maintenant <date ISO>] [--accepter-a-decider <clé1,clé2,…>] [--resume]";
const ACCEPT_HELP = "L'option --accepter-a-decider demande la liste des clés que ton GO accepte, séparées par des virgules, par exemple : " +
  "--accepter-a-decider stop-franchi:BTC,ecart-moyen:USDC. Lance d'abord le contrôle sans cette option : sa conclusion donne la ligne exacte à recopier.";

export function parseArgs(argv) {
  const args = { file: null, config: null, now: null, accepted: [], resume: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const value = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Stop(2, `Valeur manquante après ${a}.\n${USAGE}`);
      i += 1;
      return v;
    };
    if (a === "--config") args.config = value();
    else if (a === "--maintenant") {
      const v = value();
      const t = Date.parse(v);
      if (!/^\d{4}-\d{2}-\d{2}/.test(v) || !Number.isFinite(t)) throw new Stop(2, `Date invalide pour --maintenant : ${v} (exemple : 2026-10-10T08:00:00Z).`);
      args.now = new Date(t);
    } else if (a === "--accepter-a-decider") {
      // Never a bare flag: accepting "whatever the run finds" would lift points the owner's GO never saw.
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Stop(2, `${ACCEPT_HELP}\n${USAGE}`);
      i += 1;
      const keys = v.split(",").map((k) => k.trim()).filter(Boolean);
      if (keys.length === 0) throw new Stop(2, `${ACCEPT_HELP}\n${USAGE}`);
      for (const k of keys) {
        if (!KEY_PATTERN.test(k)) throw new Stop(2, `Clé invalide après --accepter-a-decider : « ${k.slice(0, 80)} ». ${ACCEPT_HELP}`);
        if (!args.accepted.includes(k)) args.accepted.push(k);
      }
    } else if (a === "--resume") args.resume = true;
    else if (a.startsWith("--")) throw new Stop(2, `Option inconnue : ${a}.\n${USAGE}`);
    else if (args.file === null) args.file = a;
    else throw new Stop(2, `Un seul fichier à contrôler.\n${USAGE}`);
  }
  if (!args.file) throw new Stop(2, `Fichier manquant.\n${USAGE}`);
  return args;
}

function main() {
  const say = (line = "") => process.stdout.write(`${line}\n`);
  let copy;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    // Registered before openPrivateCopy's own handlers, so this one reports and exits first.
    process.on(signal, () => {
      copy?.close();
      process.stdout.write("Interrompu : copie temporaire supprimée, rien n'a été modifié.\nRÉSULTAT : code=130 controle=interrompu\n");
      process.exit(130);
    });
  }
  const stop = (code, message) => {
    process.stderr.write(`${message}\n`);
    // The short report goes to Telegram: it says why, on stdout too (without repeating "Refusé").
    if (process.argv.includes("--resume")) {
      const why = message.split("\n")[0].replace(/^(Refusé|Contrôle impossible) : /, "");
      say(`Contrôle avant déploiement de Sonni : ${code === 2 ? "refusé" : "impossible"}. ${why.charAt(0).toUpperCase()}${why.slice(1)}`);
    }
    say(`RÉSULTAT : code=${code} controle=${code === 2 ? "refusé" : "impossible"}`);
    process.exitCode = code;
  };

  let args;
  let file;
  let cfg;
  try {
    args = parseArgs(process.argv.slice(2));
    file = path.resolve(args.file);
    const refused = refusal(file);
    if (refused) throw new Stop(2, refused);
    cfg = args.config
      ? readConfig(path.resolve(args.config), true)
      : readConfig(path.join(process.env.HOME || os.homedir(), ".automaton", "automaton.json"), false);
  } catch (err) {
    if (err instanceof Stop) return stop(err.exitCode, err.message);
    return stop(2, `Refusé : ${technicalFr(err)}`);
  }

  const clock = new Date();
  let report;
  let now;
  let moment = null;
  try {
    copy = openPrivateCopy(file, "sonni-controle-");
    // By default the restart is predicted at the moment the copy was made (its newest stored price).
    moment = args.now ? null : copyMoment(copy.db);
    now = args.now ?? moment?.now ?? clock;
    const assets = followedAssets(copy.db, cfg.assets);
    const notes = [...cfg.notes];
    if (cfg.file) notes.push(`configuration lue : ${cfg.file} (prix jugé ancien après ${cfg.staleMinutes} min)`);
    if (!assets) notes.push("actifs suivis inconnus (ni configuration ni liste enregistrée dans la copie) : stops prévus sans vérifier le suivi");
    report = controle(copy.db, { now, staleMinutes: cfg.staleMinutes, portfolio: cfg.portfolio, assets, notes });
  } catch (err) {
    copy?.close();
    if (err instanceof Stop) return stop(err.exitCode, err.message);
    return stop(3, `Contrôle impossible : ${technicalFr(err)}`);
  }
  copy.close();
  const nowSource = args.now ? "option" : moment ? "copie" : "horloge";
  const unused = unusedKeyFindings(report.findings, args.accepted);
  report.findings.push(...unused);
  const unchanged = sha256File(file) === copy.before;
  const code = unchanged ? verdictCode(report.findings, args.accepted) : 3;

  if (args.resume) {
    say(resume(report.findings, { file, now, nowSource, accepted: args.accepted, code, unchanged }));
  } else {
    const acc = acceptance(report.findings, args.accepted);
    say("Contrôle avant déploiement — copie en lecture seule (étapes 0.1 à 0.3)");
    say(`Fichier : ${file}`);
    say(`Prévision : si Sonni redémarrait le ${when(isoSeconds(now))} avec cette copie`);
    if (nowSource === "copie") {
      const age = clock.getTime() - now.getTime();
      say(`(${momentFr(now, nowSource)}, son dernier prix enregistré${age >= 60_000 ? `, il y a ${duration(age)}` : ""} ; --maintenant <date ISO> pour un autre moment)`);
    } else if (nowSource === "horloge") say("(aucun prix dans la copie : prévision à l'heure actuelle)");
    else say("(moment choisi avec --maintenant)");
    say("");
    for (const line of report.lines) say(line);
    const count3 = (level) => report.findings.filter((f) => f.level === level).length;
    say("Bilan");
    say(`- ${count(count3("B"), "point bloquant", "points bloquants")}, ${count(count3("D"), "point à décider", "points à décider")}, ${count(count3("I"), "information", "informations")}`);
    for (const level of ["B", "D"]) {
      for (const f of report.findings.filter((x) => x.level === level)) say(`- ${findingLine(f, acc.accepted)}`);
    }
    for (const f of unused) say(`- ${findingLine(f)}`);
    for (const line of ruleLines(report.findings, args.accepted)) say(line);
    say(unchanged ? "Fichier contrôlé inchangé (SHA-256 identique avant et après)." : "ATTENTION : le fichier a changé pendant le contrôle (un autre programme l'écrit ?) : contrôle à refaire sur une copie fermée.");
    say(resultLine(code, report.findings));
  }
  process.exitCode = code;
}

if (isMain(import.meta.url)) main();
