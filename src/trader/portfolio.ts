/**
 * Sonni's virtual portfolio: a paper broker (ARCHITECTURE.md "Virtual
 * portfolio rules", decision 0003).
 *
 * The model places orders (place_order) with a thesis, a probability, an
 * invalidation level and a horizon; code alone fills them, at the first
 * price stored after the order (never the price the decision saw), with
 * Kraken fees and the order-book spread as slippage, moves the cash, keeps
 * the positions, closes trades with their profit or loss, triggers the
 * stops, adds the monthly contribution and takes a daily snapshot. Every
 * table is append-only except the positions cache and one transition out
 * of "pending" per order. Spot only: no leverage, no shorting; a position
 * may not exceed maxPositionPct of the portfolio after a buy.
 */

import type Database from "better-sqlite3";
import { ulid } from "ulid";
import { containsInjectionPatterns } from "../soul/validator.js";
import type { PortfolioConfig, TraderConfig } from "./config.js";
import { getHypothesis } from "./hypotheses.js";
import { ageMinutes, isoSeconds, latestPrice, priceAtOrAfter, type PricePoint } from "./prices.js";
import type { SoulResult } from "./soul.js";
import { getKV, setKV } from "../money-lab/journal.js";

type DB = Database.Database;

export const ORDER_SIDES = ["buy", "sell"] as const;
export const ORDER_KINDS = ["market", "limit"] as const;
export type OrderSide = (typeof ORDER_SIDES)[number];
export type OrderKind = (typeof ORDER_KINDS)[number];
export type OrderStatus = "pending" | "filled" | "cancelled" | "rejected" | "expired";

export const MIN_HORIZON_HOURS = 1;
export const MAX_HORIZON_HOURS = 24 * 90;
export const THESIS_MIN = 20;
export const THESIS_MAX = 600;
export const MAX_HYPOTHESES_PER_ORDER = 5;
/** A market order not filled within this time (no price stored) expires. */
export const MARKET_ORDER_TTL_HOURS = 24;
/** A stored spread older than this is not used for slippage. */
const SPREAD_MAX_AGE_HOURS = 2;
const KV_MONTH = "sonni.portfolio_month";

export interface Order {
  id: string;
  placedAt: string;
  asset: string;
  side: OrderSide;
  kind: OrderKind;
  amountEur: number | null;
  quantity: number | null;
  limitPrice: number | null;
  thesis: string;
  probability: number | null;
  invalidation: number | null;
  horizonUntil: string;
  hypothesisIds: string[];
  origin: "model" | "stop" | "owner";
  status: OrderStatus;
  settledAt: string | null;
  fillPrice: number | null;
  fillQuantity: number | null;
  fillEur: number | null;
  feeEur: number | null;
  slippageEur: number | null;
  note: string | null;
}

export interface Position {
  asset: string;
  quantity: number;
  avgCost: number;
  openedAt: string;
  openOrderId: string;
  invalidation: number | null;
  horizonUntil: string | null;
  thesis: string;
  updatedAt: string;
}

export interface Trade {
  id: string;
  asset: string;
  openedAt: string;
  closedAt: string;
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  /** Fees of the lot: its share of the purchase fees plus the sale fee. */
  feesEur: number;
  entryFeeEur: number;
  exitFeeEur: number;
  /** Result after every fee: what the trade added to or took from the portfolio. */
  pnlEur: number;
  /** pnlEur over what the lot cost, its purchase fees included. */
  pnlPct: number;
  /** As stored when the trade closed, before the purchase fee (see rowToTrade). */
  recordedPnlEur: number;
  openOrderId: string;
  closeOrderId: string;
  closeReason: "model" | "stop";
  thesis: string;
}

export interface Trap {
  id: string;
  name: string;
  description: string;
  warningSigns: string;
  recordedAt: string;
  hits: number;
}

function rowToOrder(row: any): Order {
  return {
    id: row.id, placedAt: row.placed_at, asset: row.asset, side: row.side, kind: row.kind,
    amountEur: row.amount_eur, quantity: row.quantity, limitPrice: row.limit_price, thesis: row.thesis,
    probability: row.probability, invalidation: row.invalidation, horizonUntil: row.horizon_until,
    hypothesisIds: JSON.parse(row.hypothesis_ids || "[]"), origin: row.origin, status: row.status,
    settledAt: row.settled_at, fillPrice: row.fill_price, fillQuantity: row.fill_quantity, fillEur: row.fill_eur,
    feeEur: row.fee_eur, slippageEur: row.slippage_eur, note: row.note,
  };
}

function rowToPosition(row: any): Position {
  return {
    asset: row.asset, quantity: row.quantity, avgCost: row.avg_cost, openedAt: row.opened_at, openOrderId: row.open_order_id,
    invalidation: row.invalidation, horizonUntil: row.horizon_until, thesis: row.thesis, updatedAt: row.updated_at,
  };
}

/** Trades with the fee of the sale that closed them (trader_trades rows are append-only and never rewritten). */
const TRADE_SELECT = "SELECT t.*, o.fee_eur AS exit_fee_eur FROM trader_trades t LEFT JOIN trader_orders o ON o.id = t.close_order_id";

function rowToTrade(row: any): Trade {
  // pnl_eur was recorded as proceeds − sale fee − quantity × entry price, and the entry price is the fill
  // price: the purchase fee was left out (2026-10-09 audit). fees_eur holds the purchase fee share plus the
  // sale fee, and the sale order keeps its own fee, so the purchase share is their difference. Should the
  // sale order be missing, every fee of the lot is counted as a purchase fee: the result can only read lower.
  const exitFee = row.exit_fee_eur ?? 0;
  const entryFee = round2(Math.max(0, row.fees_eur - exitFee));
  const pnl = round2(row.pnl_eur - entryFee);
  const basis = row.quantity * row.entry_price + entryFee;
  return {
    id: row.id, asset: row.asset, openedAt: row.opened_at, closedAt: row.closed_at, quantity: row.quantity,
    entryPrice: row.entry_price, exitPrice: row.exit_price, feesEur: row.fees_eur, entryFeeEur: entryFee, exitFeeEur: round2(exitFee),
    pnlEur: pnl, pnlPct: basis > 0 ? (pnl / basis) * 100 : 0, recordedPnlEur: row.pnl_eur,
    openOrderId: row.open_order_id, closeOrderId: row.close_order_id, closeReason: row.close_reason, thesis: row.thesis,
  };
}

const round2 = (v: number) => Math.round(v * 100) / 100;
const round8 = (v: number) => Math.round(v * 1e8) / 1e8;

// ─── Reads ──────────────────────────────────────────────────────

export function cashEur(db: DB): number {
  const row = db.prepare("SELECT COALESCE(SUM(amount_eur), 0) AS cash FROM trader_ledger").get() as { cash: number };
  return round2(row.cash);
}

/** Capital and contributions so far (what the owner virtually put in). */
export function contributedEur(db: DB): number {
  const row = db.prepare("SELECT COALESCE(SUM(amount_eur), 0) AS v FROM trader_ledger WHERE kind IN ('capital', 'contribution')").get() as { v: number };
  return round2(row.v);
}

export function listPositions(db: DB): Position[] {
  return (db.prepare("SELECT * FROM trader_positions WHERE quantity > 0 ORDER BY asset").all() as any[]).map(rowToPosition);
}

export function getPosition(db: DB, asset: string): Position | undefined {
  const row = db.prepare("SELECT * FROM trader_positions WHERE asset = ? AND quantity > 0").get(asset);
  return row ? rowToPosition(row) : undefined;
}

export function getOrder(db: DB, id: string): Order | undefined {
  const row = db.prepare("SELECT * FROM trader_orders WHERE id = ?").get(id);
  return row ? rowToOrder(row) : undefined;
}

export function pendingOrders(db: DB, asset?: string): Order[] {
  const rows = asset
    ? db.prepare("SELECT * FROM trader_orders WHERE status = 'pending' AND asset = ? ORDER BY placed_at").all(asset)
    : db.prepare("SELECT * FROM trader_orders WHERE status = 'pending' ORDER BY placed_at").all();
  return (rows as any[]).map(rowToOrder);
}

export function recentOrders(db: DB, limit = 10, since?: string): Order[] {
  const rows = since
    ? db.prepare("SELECT * FROM trader_orders WHERE placed_at >= ? OR settled_at >= ? ORDER BY placed_at DESC LIMIT ?").all(since, since, limit)
    : db.prepare("SELECT * FROM trader_orders ORDER BY placed_at DESC LIMIT ?").all(limit);
  return (rows as any[]).map(rowToOrder);
}

export function listTrades(db: DB, limit = 20, since?: string): Trade[] {
  const rows = since
    ? db.prepare(`${TRADE_SELECT} WHERE t.closed_at >= ? ORDER BY t.closed_at DESC LIMIT ?`).all(since, limit)
    : db.prepare(`${TRADE_SELECT} ORDER BY t.closed_at DESC LIMIT ?`).all(limit);
  return (rows as any[]).map(rowToTrade);
}

export function getTrade(db: DB, id: string): Trade | undefined {
  const row = db.prepare(`${TRADE_SELECT} WHERE t.id = ?`).get(id);
  return row ? rowToTrade(row) : undefined;
}

/**
 * The purchase fees a quantity of a position carries: the buy fees since the position opened, in
 * proportion of that quantity (the average-cost rule, used both when a part is sold and for what is held).
 */
function entryFeeShare(db: DB, asset: string, openedAt: string, quantity: number): number {
  const b = db.prepare("SELECT COALESCE(SUM(fee_eur), 0) AS f, COALESCE(SUM(quantity), 0) AS q FROM trader_ledger WHERE kind = 'buy' AND asset = ? AND at >= ?")
    .get(asset, openedAt) as { f: number; q: number };
  return b.q > 0 ? (b.f * Math.min(quantity, b.q)) / b.q : 0;
}

export interface Valuation {
  cashEur: number;
  positionsEur: number;
  equityEur: number;
  contributedEur: number;
  /** Equity minus contributions: the result of Sonni's decisions, fees included. */
  pnlEur: number;
  pnlPct: number;
  /**
   * Position values; null price when none is stored. A position's result counts the purchase fees it
   * carries (paid already), not the sale fee still to come.
   */
  positions: (Position & { lastPrice: number | null; valueEur: number; entryFeesEur: number; pnlEur: number; pnlPct: number })[];
}

/** Cash plus positions at the latest stored prices (stale or not: it is a valuation, not a decision). */
export function valuation(db: DB): Valuation {
  const cash = cashEur(db);
  const contributed = contributedEur(db);
  const positions = listPositions(db).map((p) => {
    const last = latestPrice(db, p.asset);
    const price = last ? last.price : p.avgCost;
    const value = round2(p.quantity * price);
    const fees = entryFeeShare(db, p.asset, p.openedAt, p.quantity);
    const cost = p.quantity * p.avgCost + fees;
    return {
      ...p, lastPrice: last ? last.price : null, valueEur: value, entryFeesEur: round2(fees),
      pnlEur: round2(value - cost), pnlPct: cost > 0 ? ((value - cost) / cost) * 100 : 0,
    };
  });
  const positionsEur = round2(positions.reduce((s, p) => s + p.valueEur, 0));
  const equity = round2(cash + positionsEur);
  return {
    cashEur: cash, positionsEur, equityEur: equity, contributedEur: contributed,
    pnlEur: round2(equity - contributed), pnlPct: contributed > 0 ? ((equity - contributed) / contributed) * 100 : 0, positions,
  };
}

// ─── Capital, contributions, snapshots ──────────────────────────

function addLedger(db: DB, row: { at: string; kind: "capital" | "contribution" | "buy" | "sell"; asset?: string | null; quantity?: number | null; price?: number | null; amountEur: number; feeEur?: number; orderId?: string | null; note?: string | null }): void {
  db.prepare(
    `INSERT INTO trader_ledger (id, at, kind, asset, quantity, price, amount_eur, fee_eur, order_id, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(`l_${ulid()}`, row.at, row.kind, row.asset ?? null, row.quantity ?? null, row.price ?? null, round2(row.amountEur), round2(row.feeEur ?? 0), row.orderId ?? null, row.note ?? null);
}

/**
 * The starting capital at the first tick, then the contribution on the
 * first tick of each later month (UTC). Idempotent: the month is kept in
 * the database.
 */
export function fundingTick(db: DB, cfg: PortfolioConfig, now: Date = new Date()): { capital: boolean; contribution: boolean } {
  const month = now.toISOString().slice(0, 7);
  const started = getKV(db, KV_MONTH);
  if (!started) {
    addLedger(db, { at: now.toISOString(), kind: "capital", amountEur: cfg.startEur, note: "capital virtuel de départ" });
    setKV(db, KV_MONTH, month);
    return { capital: true, contribution: false };
  }
  if (started < month && cfg.monthlyEur > 0) {
    addLedger(db, { at: now.toISOString(), kind: "contribution", amountEur: cfg.monthlyEur, note: `versement virtuel ${month}` });
    setKV(db, KV_MONTH, month);
    return { capital: false, contribution: true };
  }
  return { capital: false, contribution: false };
}

/** One equity snapshot per UTC day (the first tick of the day), for returns and drawdown. */
export function snapshotTick(db: DB, now: Date = new Date()): boolean {
  const day = now.toISOString().slice(0, 10);
  const exists = db.prepare("SELECT 1 FROM trader_portfolio_days WHERE day = ?").get(day);
  if (exists) return false;
  const v = valuation(db);
  db.prepare(
    "INSERT INTO trader_portfolio_days (day, at, cash_eur, positions_eur, equity_eur, contributed_eur) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(day, now.toISOString(), v.cashEur, v.positionsEur, v.equityEur, v.contributedEur);
  return true;
}

export interface Snapshot { day: string; equityEur: number; contributedEur: number; cashEur: number; positionsEur: number }

export function snapshots(db: DB, limit = 400): Snapshot[] {
  return (db.prepare("SELECT day, equity_eur, contributed_eur, cash_eur, positions_eur FROM trader_portfolio_days ORDER BY day DESC LIMIT ?").all(limit) as any[])
    .map((r) => ({ day: r.day, equityEur: r.equity_eur, contributedEur: r.contributed_eur, cashEur: r.cash_eur, positionsEur: r.positions_eur }))
    .reverse();
}

// ─── Orders ─────────────────────────────────────────────────────

export interface OrderInput {
  asset: unknown;
  side: unknown;
  kind?: unknown;
  amountEur?: unknown;
  quantity?: unknown;
  limitPrice?: unknown;
  thesis: unknown;
  probability?: unknown;
  invalidation?: unknown;
  horizonHours?: unknown;
  hypothesisIds?: unknown;
}

function cleanThesis(raw: unknown): SoulResult<string> {
  const text = String(raw ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (text.length < THESIS_MIN) return { ok: false, error: `The thesis must be at least ${THESIS_MIN} characters.` };
  if (text.length > THESIS_MAX) return { ok: false, error: `The thesis must be at most ${THESIS_MAX} characters (got ${text.length}).` };
  if (containsInjectionPatterns(text)) return { ok: false, error: "The thesis contains a prompt-boundary pattern; rewrite it as plain text." };
  return { ok: true, value: text };
}

function num(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/** Cash not yet committed to pending buy orders. */
export function availableCash(db: DB): number {
  const reserved = (db.prepare("SELECT COALESCE(SUM(amount_eur), 0) AS v FROM trader_orders WHERE status = 'pending' AND side = 'buy'").get() as { v: number }).v;
  return round2(cashEur(db) - reserved);
}

/** Quantity not yet committed to pending sell orders. */
export function availableQuantity(db: DB, asset: string): number {
  const held = getPosition(db, asset)?.quantity ?? 0;
  const reserved = (db.prepare("SELECT COALESCE(SUM(quantity), 0) AS v FROM trader_orders WHERE status = 'pending' AND side = 'sell' AND asset = ?").get(asset) as { v: number }).v;
  return round8(held - reserved);
}

/**
 * Record an order from the model. Everything is checked here: followed
 * asset, fresh price, cash and quantity available, the position cap, the
 * thesis, the invalidation level and the horizon. Pending until code fills
 * it at a later price.
 */
export function placeOrder(db: DB, cfg: TraderConfig, input: OrderInput, now: Date = new Date(), origin: Order["origin"] = "model"): SoulResult<Order> {
  const pc = cfg.portfolio;
  const asset = String(input.asset ?? "").toUpperCase().trim();
  if (!cfg.assets.some((a) => a.symbol === asset)) return { ok: false, error: `Unknown asset ${asset || "(none)"}: you follow ${cfg.assets.map((a) => a.symbol).join(", ")}.` };
  const side = String(input.side ?? "") as OrderSide;
  if (!ORDER_SIDES.includes(side)) return { ok: false, error: "side must be buy or sell." };
  const kind = (input.kind === undefined ? "market" : String(input.kind)) as OrderKind;
  if (!ORDER_KINDS.includes(kind)) return { ok: false, error: "kind must be market or limit." };
  const thesis = cleanThesis(input.thesis);
  if (!thesis.ok) return thesis;
  const last = latestPrice(db, asset);
  if (!last) return { ok: false, error: `No ${asset} price stored yet.` };
  if (ageMinutes(last, now) > cfg.staleMinutes) return { ok: false, error: `The last ${asset} price is stale (${Math.round(ageMinutes(last, now))} min old): no order on a stale price.` };
  const probability = num(input.probability);
  if (probability !== null && (Number.isNaN(probability) || probability < 0.05 || probability > 0.95)) return { ok: false, error: "probability must be between 0.05 and 0.95." };
  const horizonHours = num(input.horizonHours) ?? 24 * 7;
  if (Number.isNaN(horizonHours) || horizonHours < MIN_HORIZON_HOURS || horizonHours > MAX_HORIZON_HOURS) {
    return { ok: false, error: `horizon_hours must be between ${MIN_HORIZON_HOURS} and ${MAX_HORIZON_HOURS}.` };
  }
  const horizonUntil = isoSeconds(new Date(now.getTime() + horizonHours * 3_600_000));
  const limitPrice = num(input.limitPrice);
  if (kind === "limit" && (limitPrice === null || Number.isNaN(limitPrice) || limitPrice <= 0)) return { ok: false, error: "A limit order needs limit_price (EUR)." };
  if (kind === "limit" && side === "buy" && limitPrice! >= last.price) return { ok: false, error: `A buy limit must be below the current price (${last.price} EUR); use a market order to buy now.` };
  if (kind === "limit" && side === "sell" && limitPrice! <= last.price) return { ok: false, error: `A sell limit must be above the current price (${last.price} EUR); use a market order to sell now.` };
  const ids: string[] = Array.isArray(input.hypothesisIds) ? input.hypothesisIds.map(String) : [];
  if (ids.length > MAX_HYPOTHESES_PER_ORDER) return { ok: false, error: `At most ${MAX_HYPOTHESES_PER_ORDER} hypothesis ids.` };
  for (const id of ids) if (!getHypothesis(db, id)) return { ok: false, error: `Unknown hypothesis ${id}.` };
  if (pendingOrders(db, asset).some((o) => o.side === side)) return { ok: false, error: `A ${side} order on ${asset} is already pending; cancel it first (cancel_order).` };
  if (origin === "model") {
    const dayStart = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
    const today = (db.prepare("SELECT COUNT(*) AS n FROM trader_orders WHERE origin = 'model' AND placed_at >= ?").get(dayStart) as { n: number }).n;
    if (today >= pc.maxOrdersPerDay) {
      return { ok: false, error: `Daily order cap: ${today} orders placed today (max ${pc.maxOrdersPerDay} per UTC day, cancelled ones included). Fewer, better-reasoned orders; the cap resets at 00:00 UTC.` };
    }
  }

  let amountEur: number | null = null;
  let quantity: number | null = null;
  let invalidation: number | null = null;
  if (side === "buy") {
    amountEur = num(input.amountEur);
    if (amountEur === null || Number.isNaN(amountEur)) return { ok: false, error: "A buy needs amount_eur (cash to spend, fees included)." };
    amountEur = round2(amountEur);
    if (amountEur < pc.minOrderEur) return { ok: false, error: `The smallest order is ${pc.minOrderEur} EUR.` };
    const cash = availableCash(db);
    if (amountEur > cash) return { ok: false, error: `Only ${cash.toFixed(2)} EUR available (cash minus pending buys).` };
    const v = valuation(db);
    const held = v.positions.find((p) => p.asset === asset)?.valueEur ?? 0;
    const cap = (v.equityEur * pc.maxPositionPct) / 100;
    if (held + amountEur > cap + 0.005) {
      return { ok: false, error: `Position cap: ${asset} would be ${(held + amountEur).toFixed(2)} EUR, above ${pc.maxPositionPct} % of the portfolio (${cap.toFixed(2)} EUR).` };
    }
    invalidation = num(input.invalidation);
    if (origin === "model") {
      if (invalidation === null || Number.isNaN(invalidation)) return { ok: false, error: "A buy needs invalidation: the price (EUR) below which your thesis is wrong; code sells there." };
      const reference = kind === "limit" ? limitPrice! : last.price;
      if (invalidation >= reference) return { ok: false, error: `invalidation (${invalidation}) must be below the entry price (${reference} EUR).` };
      if (invalidation < reference * 0.5) return { ok: false, error: "invalidation must be within 50 % of the entry price." };
    }
  } else {
    const held = availableQuantity(db, asset);
    if (held <= 0) return { ok: false, error: `No ${asset} to sell (or all of it is in a pending sell).` };
    const q = input.quantity === "all" || input.quantity === undefined ? held : num(input.quantity);
    if (q === null || Number.isNaN(q) || q <= 0) return { ok: false, error: "quantity must be a positive number or \"all\"." };
    quantity = round8(Math.min(q, held));
    if (quantity * last.price < pc.minOrderEur && quantity < held) return { ok: false, error: `The smallest order is ${pc.minOrderEur} EUR; sell everything with quantity "all".` };
  }
  const id = `o_${ulid()}`;
  db.prepare(
    `INSERT INTO trader_orders (id, placed_at, asset, side, kind, amount_eur, quantity, limit_price, thesis, probability, invalidation, horizon_until, hypothesis_ids, origin, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
  ).run(id, now.toISOString(), asset, side, kind, amountEur, quantity, limitPrice, thesis.value, probability, invalidation, horizonUntil, JSON.stringify(ids), origin);
  return { ok: true, value: getOrder(db, id)! };
}

export function cancelOrder(db: DB, id: unknown, now: Date = new Date(), by: "model" | "owner" = "model"): SoulResult<Order> {
  const order = getOrder(db, String(id ?? ""));
  if (!order) return { ok: false, error: `Unknown order ${String(id ?? "")}.` };
  if (order.status !== "pending") return { ok: false, error: `Order ${order.id} is already ${order.status}.` };
  if (order.origin === "stop" && by === "model") return { ok: false, error: "A stop order is code's: it cannot be cancelled. Change the invalidation level before it triggers (manage_position)." };
  db.prepare("UPDATE trader_orders SET status = 'cancelled', settled_at = ?, note = ? WHERE id = ? AND status = 'pending'").run(now.toISOString(), `cancelled by ${by}`, order.id);
  return { ok: true, value: getOrder(db, order.id)! };
}

// ─── Fills ──────────────────────────────────────────────────────

/** Half the relative spread from the stored order-book top, when fresh; else the configured slippage. */
function slippageFraction(db: DB, asset: string, cfg: PortfolioConfig, now: Date): { fraction: number; source: string } {
  const row = db.prepare(
    `SELECT a.value AS ask, b.value AS bid, a.ts FROM trader_metrics a JOIN trader_metrics b
     ON a.source_id = b.source_id AND a.ts = b.ts AND a.metric = 'ask' AND b.metric = 'bid'
     WHERE a.source_id = ? ORDER BY a.ts DESC LIMIT 1`,
  ).get(`kraken_spread_${asset.toLowerCase()}`) as { ask: number; bid: number; ts: string } | undefined;
  if (row && row.ask > row.bid && now.getTime() - Date.parse(row.ts) <= SPREAD_MAX_AGE_HOURS * 3_600_000) {
    const mid = (row.ask + row.bid) / 2;
    return { fraction: (row.ask - row.bid) / mid / 2, source: "carnet d'ordres Kraken" };
  }
  return { fraction: cfg.slippageBps / 10_000, source: "glissement configuré" };
}

export interface Fill { order: Order; trade: Trade | null }

function applyFill(db: DB, cfg: TraderConfig, order: Order, price: number, slippageFraction: number, feePct: number, at: string): Fill {
  let trade: Trade | null = null;
  db.transaction(() => {
    if (order.side === "buy") {
      const fillPrice = round2(price * (1 + slippageFraction));
      const fee = round2(order.amountEur! * (feePct / 100));
      const quantity = round8((order.amountEur! - fee) / fillPrice);
      const slippage = round2(quantity * (fillPrice - price));
      db.prepare(
        `UPDATE trader_orders SET status = 'filled', settled_at = ?, fill_price = ?, fill_quantity = ?, fill_eur = ?, fee_eur = ?, slippage_eur = ? WHERE id = ? AND status = 'pending'`,
      ).run(at, fillPrice, quantity, order.amountEur, fee, slippage, order.id);
      addLedger(db, { at, kind: "buy", asset: order.asset, quantity, price: fillPrice, amountEur: -order.amountEur!, feeEur: fee, orderId: order.id });
      const current = db.prepare("SELECT * FROM trader_positions WHERE asset = ?").get(order.asset) as any;
      if (!current || current.quantity <= 0) {
        db.prepare(
          `INSERT OR REPLACE INTO trader_positions (asset, quantity, avg_cost, opened_at, open_order_id, invalidation, horizon_until, thesis, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(order.asset, quantity, round2((order.amountEur! - fee) / quantity), at, order.id, order.invalidation, order.horizonUntil, order.thesis, at);
      } else {
        const totalQty = round8(current.quantity + quantity);
        const avg = round2((current.quantity * current.avg_cost + (order.amountEur! - fee)) / totalQty);
        // Adding to a position: the newer order's levels replace the older ones (the thesis is refreshed too).
        db.prepare(
          "UPDATE trader_positions SET quantity = ?, avg_cost = ?, invalidation = COALESCE(?, invalidation), horizon_until = ?, thesis = ?, updated_at = ? WHERE asset = ?",
        ).run(totalQty, avg, order.invalidation, order.horizonUntil, order.thesis, at, order.asset);
      }
    } else {
      const position = db.prepare("SELECT * FROM trader_positions WHERE asset = ?").get(order.asset) as any;
      const quantity = round8(Math.min(order.quantity!, position?.quantity ?? 0));
      const fillPrice = round2(price * (1 - slippageFraction));
      const proceeds = round2(quantity * fillPrice);
      const fee = round2(proceeds * (feePct / 100));
      const slippage = round2(quantity * (price - fillPrice));
      db.prepare(
        `UPDATE trader_orders SET status = 'filled', settled_at = ?, fill_price = ?, fill_quantity = ?, fill_eur = ?, fee_eur = ?, slippage_eur = ? WHERE id = ? AND status = 'pending'`,
      ).run(at, fillPrice, quantity, proceeds, fee, slippage, order.id);
      addLedger(db, { at, kind: "sell", asset: order.asset, quantity, price: fillPrice, amountEur: proceeds - fee, feeEur: fee, orderId: order.id });
      if (position && quantity > 0) {
        // Fees of the lot: the buy fees in proportion of the quantity sold, plus this sale's fee.
        const entryFee = entryFeeShare(db, order.asset, position.opened_at, quantity);
        const cost = quantity * position.avg_cost;
        // Recorded before the purchase fee, as every trade since the first (the table is append-only):
        // rowToTrade subtracts the purchase share, so readers get the result after every fee.
        const pnl = round2(proceeds - fee - cost);
        const tradeId = `t_${ulid()}`;
        db.prepare(
          `INSERT INTO trader_trades (id, asset, opened_at, closed_at, quantity, entry_price, exit_price, fees_eur, pnl_eur, pnl_pct, open_order_id, close_order_id, close_reason, thesis)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(tradeId, order.asset, position.opened_at, at, quantity, position.avg_cost, fillPrice, round2(entryFee + fee), pnl, cost > 0 ? (pnl / cost) * 100 : 0,
          position.open_order_id, order.id, order.origin === "stop" ? "stop" : "model", position.thesis);
        const left = round8(position.quantity - quantity);
        db.prepare("UPDATE trader_positions SET quantity = ?, updated_at = ? WHERE asset = ?").run(left, at, order.asset);
        trade = getTrade(db, tradeId)!;
      }
    }
  })();
  return { order: getOrder(db, order.id)!, trade };
}

export interface BrokerOutcome {
  fills: Fill[];
  expired: Order[];
  stops: Order[];
  /** Positions whose horizon passed since the last tick (the model is asked what to do). */
  horizons: Position[];
  funded: { capital: boolean; contribution: boolean };
  snapshot: boolean;
}

/**
 * Runs after each price collection: funding, fills at the first price
 * stored after each order (market) or at the limit when crossed (limit),
 * expiries, stops on positions whose invalidation level is reached, and
 * the daily snapshot. Deterministic; no inference.
 */
export function brokerTick(db: DB, cfg: TraderConfig, now: Date = new Date()): BrokerOutcome {
  const out: BrokerOutcome = { fills: [], expired: [], stops: [], horizons: [], funded: fundingTick(db, cfg.portfolio, now), snapshot: false };
  const nowIso = isoSeconds(now);
  for (const order of pendingOrders(db)) {
    const after = isoSeconds(new Date(Date.parse(order.placedAt) + 1000));
    const point: PricePoint | undefined = order.kind === "market"
      ? priceAtOrAfter(db, order.asset, after, nowIso)
      : firstCrossing(db, order, after, nowIso);
    if (point) {
      const slip = order.kind === "market" ? slippageFraction(db, order.asset, cfg.portfolio, now) : { fraction: 0, source: "limite" };
      const fee = order.kind === "market" ? cfg.portfolio.takerFeePct : cfg.portfolio.makerFeePct;
      const price = order.kind === "market" ? point.price : order.limitPrice!;
      out.fills.push(applyFill(db, cfg, order, price, slip.fraction, fee, point.ts));
      continue;
    }
    const ttl = order.kind === "market" ? Date.parse(order.placedAt) + MARKET_ORDER_TTL_HOURS * 3_600_000 : Date.parse(order.horizonUntil);
    if (now.getTime() > ttl) {
      db.prepare("UPDATE trader_orders SET status = 'expired', settled_at = ?, note = ? WHERE id = ? AND status = 'pending'")
        .run(nowIso, order.kind === "market" ? "no price stored within 24 h" : "limit not reached before the horizon", order.id);
      out.expired.push(getOrder(db, order.id)!);
    }
  }
  // Stops: a position whose invalidation level is reached gets a market sell from code, filled at the next price.
  for (const p of listPositions(db)) {
    if (p.invalidation === null) continue;
    const last = latestPrice(db, p.asset);
    if (!last || ageMinutes(last, now) > cfg.staleMinutes || last.price > p.invalidation) continue;
    if (pendingOrders(db, p.asset).some((o) => o.side === "sell")) continue;
    const stop = placeOrder(db, cfg, {
      asset: p.asset, side: "sell", kind: "market", quantity: "all",
      thesis: `Stop: ${p.asset} reached the invalidation level ${p.invalidation} EUR (last price ${last.price} EUR); the thesis was: ${p.thesis}`.slice(0, THESIS_MAX),
      horizonHours: 24,
    }, now, "stop");
    if (stop.ok) {
      db.prepare("UPDATE trader_positions SET invalidation = NULL, updated_at = ? WHERE asset = ?").run(nowIso, p.asset);
      db.prepare("INSERT INTO trader_position_updates (id, asset, at, field, old_value, new_value, reason, by) VALUES (?, ?, ?, 'invalidation', ?, NULL, ?, 'code')")
        .run(`u_${ulid()}`, p.asset, nowIso, String(p.invalidation), `stop triggered at ${last.price} EUR (order ${stop.value.id})`);
      out.stops.push(stop.value);
    }
  }
  // Horizons: once per position horizon, the model is asked what to do (the position stays).
  for (const p of listPositions(db)) {
    if (!p.horizonUntil || p.horizonUntil > nowIso) continue;
    const key = `horizon:${p.asset}:${p.horizonUntil}`;
    if (getKV(db, `sonni.horizon_seen.${p.asset}`) === p.horizonUntil) continue;
    setKV(db, `sonni.horizon_seen.${p.asset}`, p.horizonUntil);
    out.horizons.push(p);
    void key;
  }
  out.snapshot = snapshotTick(db, now);
  return out;
}

function firstCrossing(db: DB, order: Order, from: string, to: string): PricePoint | undefined {
  const cmp = order.side === "buy" ? "<=" : ">=";
  return db.prepare(
    `SELECT asset, ts, price FROM trader_prices WHERE asset = ? AND ts >= ? AND ts <= ? AND price ${cmp} ? ORDER BY ts ASC LIMIT 1`,
  ).get(order.asset, from, to, order.limitPrice) as PricePoint | undefined;
}

// ─── Position management by the model ───────────────────────────

export function updatePosition(
  db: DB,
  cfg: TraderConfig,
  input: { asset: unknown; field: unknown; value: unknown; reason: unknown },
  now: Date = new Date(),
): SoulResult<Position> {
  const asset = String(input.asset ?? "").toUpperCase().trim();
  const position = getPosition(db, asset);
  if (!position) return { ok: false, error: `No open position in ${asset || "(none)"}.` };
  const reason = cleanThesis(input.reason);
  if (!reason.ok) return { ok: false, error: reason.error.replace("The thesis", "The reason") };
  const field = String(input.field ?? "");
  const nowIso = isoSeconds(now);
  let oldValue: string | null;
  let newValue: string;
  if (field === "invalidation") {
    const level = num(input.value);
    const last = latestPrice(db, asset);
    if (level === null || Number.isNaN(level) || level <= 0) return { ok: false, error: "value must be a price in EUR." };
    if (!last) return { ok: false, error: `No ${asset} price stored.` };
    if (level >= last.price) return { ok: false, error: `The invalidation level (${level}) must be below the current price (${last.price} EUR): it is where code sells.` };
    oldValue = position.invalidation === null ? null : String(position.invalidation);
    newValue = String(level);
    db.prepare("UPDATE trader_positions SET invalidation = ?, updated_at = ? WHERE asset = ?").run(level, nowIso, asset);
  } else if (field === "horizon_until") {
    const hours = num(input.value);
    if (hours === null || Number.isNaN(hours) || hours < MIN_HORIZON_HOURS || hours > MAX_HORIZON_HOURS) return { ok: false, error: `value must be hours from now, ${MIN_HORIZON_HOURS} to ${MAX_HORIZON_HOURS}.` };
    oldValue = position.horizonUntil;
    newValue = isoSeconds(new Date(now.getTime() + hours * 3_600_000));
    db.prepare("UPDATE trader_positions SET horizon_until = ?, updated_at = ? WHERE asset = ?").run(newValue, nowIso, asset);
  } else {
    return { ok: false, error: "field must be invalidation or horizon_until." };
  }
  db.prepare("INSERT INTO trader_position_updates (id, asset, at, field, old_value, new_value, reason, by) VALUES (?, ?, ?, ?, ?, ?, ?, 'model')")
    .run(`u_${ulid()}`, asset, nowIso, field, oldValue, newValue, reason.value);
  return { ok: true, value: getPosition(db, asset)! };
}

// ─── Traps: named mistakes ──────────────────────────────────────

export const TRAP_NAME_MAX = 60;
export const MAX_TRAPS = 40;

export function listTraps(db: DB): Trap[] {
  return (db.prepare(
    `SELECT t.*, (SELECT COUNT(*) FROM trader_trap_hits h WHERE h.trap_id = t.id) AS hits FROM trader_traps t ORDER BY hits DESC, recorded_at ASC`,
  ).all() as any[]).map((r) => ({ id: r.id, name: r.name, description: r.description, warningSigns: r.warning_signs, recordedAt: r.recorded_at, hits: r.hits }));
}

export function addTrap(db: DB, input: { name: unknown; description: unknown; warningSigns: unknown }, now: Date = new Date()): SoulResult<Trap> {
  const name = String(input.name ?? "").replace(/\s+/g, " ").trim();
  if (name.length < 3 || name.length > TRAP_NAME_MAX || containsInjectionPatterns(name)) return { ok: false, error: `name must be 3 to ${TRAP_NAME_MAX} plain characters.` };
  const description = cleanThesis(input.description);
  if (!description.ok) return { ok: false, error: description.error.replace("The thesis", "The description") };
  const signs = cleanThesis(input.warningSigns);
  if (!signs.ok) return { ok: false, error: signs.error.replace("The thesis", "warning_signs") };
  if (listTraps(db).length >= MAX_TRAPS) return { ok: false, error: `Already ${MAX_TRAPS} traps: merge before adding.` };
  if (db.prepare("SELECT 1 FROM trader_traps WHERE lower(name) = lower(?)").get(name)) return { ok: false, error: `A trap named "${name}" exists; record a hit on it instead.` };
  const id = `trap_${ulid()}`;
  db.prepare("INSERT INTO trader_traps (id, name, description, warning_signs, recorded_at) VALUES (?, ?, ?, ?, ?)").run(id, name, description.value, signs.value, now.toISOString());
  return { ok: true, value: listTraps(db).find((t) => t.id === id)! };
}

export function recordTrapHit(db: DB, input: { trapId: unknown; tradeId: unknown; note: unknown }, now: Date = new Date()): SoulResult<Trap> {
  const trap = listTraps(db).find((t) => t.id === String(input.trapId ?? "") || t.name.toLowerCase() === String(input.trapId ?? "").toLowerCase());
  if (!trap) return { ok: false, error: `Unknown trap ${String(input.trapId ?? "")}.` };
  const trade = getTrade(db, String(input.tradeId ?? ""));
  if (!trade) return { ok: false, error: `Unknown trade ${String(input.tradeId ?? "")}: a hit points to a closed trade.` };
  const note = cleanThesis(input.note);
  if (!note.ok) return { ok: false, error: note.error.replace("The thesis", "The note") };
  if (db.prepare("SELECT 1 FROM trader_trap_hits WHERE trap_id = ? AND trade_id = ?").get(trap.id, trade.id)) return { ok: false, error: "This trade is already counted for this trap." };
  db.prepare("INSERT INTO trader_trap_hits (id, trap_id, trade_id, note, recorded_at) VALUES (?, ?, ?, ?, ?)").run(`hit_${ulid()}`, trap.id, trade.id, note.value, now.toISOString());
  return { ok: true, value: listTraps(db).find((t) => t.id === trap.id)! };
}

// ─── Performance (code-computed, decision 0003 criteria) ─────────

export interface Performance {
  equityEur: number;
  contributedEur: number;
  pnlEur: number;
  pnlPct: number;
  /** Change of equity (contributions excluded) over the windows, in %; null without a snapshot. */
  change7dPct: number | null;
  change30dPct: number | null;
  change90dPct: number | null;
  maxDrawdownPct: number | null;
  tradesClosed: number;
  winRate: number | null;
  avgTradePct: number | null;
  feesEur: number;
  /** Virtual gains divided by the inference spend (USD converted at eurUsd); 1 = paid for itself. */
  selfFundingRatio: number | null;
  stops: number;
  firstDay: string | null;
}

export function performance(db: DB, cfg: TraderConfig, inferenceSpentCents: number, now: Date = new Date()): Performance {
  const v = valuation(db);
  const snaps = snapshots(db);
  const trades = listTrades(db, 10_000);
  // Results after every fee: a trade whose gain the fees ate is not a win.
  const wins = trades.filter((t) => t.pnlEur > 0).length;
  const fees = round2((db.prepare("SELECT COALESCE(SUM(fee_eur), 0) AS f FROM trader_ledger").get() as { f: number }).f);
  const change = (days: number): number | null => {
    const target = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
    const base = [...snaps].reverse().find((s) => s.day <= target) ?? snaps[0];
    if (!base || snaps.length === 0 || base.day > target && snaps[0].day > target) return null;
    // Equity net of contributions made since the base snapshot.
    const added = v.contributedEur - base.contributedEur;
    return base.equityEur > 0 ? ((v.equityEur - added - base.equityEur) / base.equityEur) * 100 : null;
  };
  let peak = 0;
  let maxDd: number | null = snaps.length ? 0 : null;
  for (const s of snaps) {
    const net = s.equityEur - s.contributedEur;
    peak = Math.max(peak, net);
    const dd = s.contributedEur > 0 ? ((peak - net) / s.contributedEur) * 100 : 0;
    if (maxDd !== null) maxDd = Math.max(maxDd, dd);
  }
  const spentEur = inferenceSpentCents / 100 / cfg.portfolio.eurUsd;
  const stops = (db.prepare("SELECT COUNT(*) AS n FROM trader_trades WHERE close_reason = 'stop'").get() as { n: number }).n;
  return {
    equityEur: v.equityEur, contributedEur: v.contributedEur, pnlEur: v.pnlEur, pnlPct: v.pnlPct,
    change7dPct: change(7), change30dPct: change(30), change90dPct: change(90),
    maxDrawdownPct: maxDd, tradesClosed: trades.length,
    winRate: trades.length ? wins / trades.length : null,
    avgTradePct: trades.length ? trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length : null,
    feesEur: fees,
    selfFundingRatio: spentEur > 0 ? v.pnlEur / spentEur : null,
    stops,
    firstDay: snaps[0]?.day ?? null,
  };
}

/** Closed trades without a post-mortem yet (the model writes one per trade). */
export function tradesAwaitingPostmortem(db: DB, limit = 10): Trade[] {
  return (db.prepare(
    `${TRADE_SELECT}
     WHERE NOT EXISTS (SELECT 1 FROM trader_reflections r WHERE r.kind = 'trade' AND r.subject_id = t.id)
     ORDER BY t.closed_at ASC LIMIT ?`,
  ).all(limit) as any[]).map(rowToTrade);
}
