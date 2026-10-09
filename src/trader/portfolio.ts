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
import { fmtPrice, plainPrice } from "./format.js";
import { recordIncident } from "./incidents.js";

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
  /** Result after every fee: the sale's proceeds after its fee, minus what the lot cost with its purchase fees. */
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
/**
 * Unit prices (fill prices, average costs) keep 12 significant digits (step 0.3, 2026-10-09). Rounded to the
 * cent, a fill below 1 EUR moved away from the market (USDC up to ±0.58 % a leg) and a price below 0.005 EUR
 * became 0, with an infinite quantity. Twelve digits also drop float noise, so BTC and ETH fills keep their
 * cents (60130.049999999996 → 60130.05). EUR amounts stay in cents and quantities in 1e-8.
 */
export const roundPrice = (v: number) => Number(v.toPrecision(12));
const positive = (v: number) => Number.isFinite(v) && v > 0;

/** Why a stored position cannot be valued; only a fill before step 0.3 could write one (a price rounded to 0). */
export type PositionProblem = "quantity" | "avg_cost" | "value";
export const POSITION_PROBLEM_EN: Record<PositionProblem, string> = {
  quantity: "its quantity is not a finite positive number",
  avg_cost: "its average cost is not a positive number",
  value: "its value cannot be computed",
};
export const POSITION_PROBLEM_FR: Record<PositionProblem, string> = {
  quantity: "quantité non finie ou invalide",
  avg_cost: "coût moyen nul ou invalide",
  value: "valeur incalculable",
};

export function positionProblem(p: { quantity: number; avgCost: number }): PositionProblem | null {
  if (!positive(p.quantity)) return "quantity";
  if (!positive(p.avgCost)) return "avg_cost";
  return null;
}

/** Why code refuses to fill an order: the note keeps the code, /portefeuille shows the French text. */
export type RejectReason = "price" | "quantity" | "amount" | "position" | "nothing";
const REJECT_EN: Record<RejectReason, string> = {
  price: "the fill price is not a positive number",
  quantity: "the quantity is not a positive finite number",
  amount: "an amount in EUR is not a finite number",
  position: "the stored position holds figures code cannot use",
  nothing: "there is no position to sell",
};
const REJECT_FR: Record<RejectReason, string> = {
  price: "prix d'exécution nul, négatif ou non fini",
  quantity: "quantité nulle, négative ou non finie",
  amount: "montant en euros non fini",
  position: "la position enregistrée a des chiffres invalides",
  nothing: "aucune position à vendre",
};
const REJECT_NOTE = /^rejected by code \((price|quantity|amount|position|nothing)\)(?:: [^[]*)?(?: \[(.*)\])?$/;

/** The French reading of a note left by a rejection, or null for any other note. */
export function rejectionNoteFr(note: string | null): string | null {
  const m = REJECT_NOTE.exec(note ?? "");
  return m ? `refusé par le code : ${REJECT_FR[m[1] as RejectReason]}${m[2] ? ` (${m[2]})` : ""}` : null;
}

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
 * The purchase fees a position still carries: the fees of its buys since it opened, minus the shares already
 * booked to its earlier sales. A sale books the share of what it sells (the average-cost rule), so the shares
 * add up to the buy fees in any order of buys and sales (a buy after a partial sale included).
 */
function carriedEntryFees(db: DB, asset: string, openedAt: string, openOrderId: string): number {
  const bought = db.prepare("SELECT COALESCE(SUM(fee_eur), 0) AS f FROM trader_ledger WHERE kind = 'buy' AND asset = ? AND at >= ?")
    .get(asset, openedAt) as { f: number };
  // Same purchase share as rowToTrade reads: the lot's fees minus the sale order's fee.
  const booked = db.prepare(
    `SELECT COALESCE(SUM(MAX(0, t.fees_eur - COALESCE(o.fee_eur, 0))), 0) AS f FROM trader_trades t
     LEFT JOIN trader_orders o ON o.id = t.close_order_id WHERE t.asset = ? AND t.open_order_id = ?`,
  ).get(asset, openOrderId) as { f: number };
  return Math.max(0, bought.f - booked.f);
}

export interface InvalidPosition { asset: string; quantity: number; avgCost: number; problem: PositionProblem }

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
  /**
   * Stored positions code cannot value (step 0.3). While one exists the totals (positionsEur, equityEur, pnlEur,
   * pnlPct) are NaN: unknown, never a partial figure passed off as the total; validPositionsEur is what the
   * other positions are worth, for a display that says it is partial.
   */
  invalid: InvalidPosition[];
  validPositionsEur: number;
  complete: boolean;
}

/** Cash plus positions at the latest stored prices (stale or not: it is a valuation, not a decision). */
export function valuation(db: DB): Valuation {
  const cash = cashEur(db);
  const contributed = contributedEur(db);
  const invalid: InvalidPosition[] = [];
  const positions: Valuation["positions"] = [];
  for (const p of listPositions(db)) {
    let problem = positionProblem(p);
    if (!problem) {
      const last = latestPrice(db, p.asset);
      const price = last ? last.price : p.avgCost;
      const value = round2(p.quantity * price);
      const fees = carriedEntryFees(db, p.asset, p.openedAt, p.openOrderId);
      const cost = p.quantity * p.avgCost + fees;
      const pnl = round2(value - cost);
      if (Number.isFinite(value) && Number.isFinite(pnl) && cost > 0) {
        positions.push({ ...p, lastPrice: last ? last.price : null, valueEur: value, entryFeesEur: round2(fees), pnlEur: pnl, pnlPct: ((value - cost) / cost) * 100 });
        continue;
      }
      problem = "value";
    }
    invalid.push({ asset: p.asset, quantity: p.quantity, avgCost: p.avgCost, problem });
  }
  const validPositionsEur = round2(positions.reduce((s, p) => s + p.valueEur, 0));
  const complete = invalid.length === 0 && Number.isFinite(cash) && Number.isFinite(contributed);
  const positionsEur = complete ? validPositionsEur : NaN;
  const equity = complete ? round2(cash + positionsEur) : NaN;
  return {
    cashEur: cash, positionsEur, equityEur: equity, contributedEur: contributed,
    pnlEur: complete ? round2(equity - contributed) : NaN,
    pnlPct: !complete ? NaN : contributed > 0 ? ((equity - contributed) / contributed) * 100 : 0,
    positions, invalid, validPositionsEur, complete,
  };
}

/**
 * Why buys and decisions are suspended (English, for the model), or null when the portfolio can be valued:
 * the position cap and the decisions' equity need the total, which a corrupt stored position makes unknown.
 * Sales and stops of the other positions keep working.
 */
export function suspensionReason(v: Valuation): string | null {
  if (v.complete) return null;
  const what = v.invalid.length
    ? v.invalid.map((p) => `the stored ${p.asset} position (${POSITION_PROBLEM_EN[p.problem]})`).join(", ")
    : "the cash ledger";
  return `${what} cannot be valued, so the portfolio value and the position cap are unknown; buys and decisions are suspended until the owner repairs it (sales and stops of the other positions still work)`;
}

/** The same, in French, for the owner. */
export function suspensionFr(v: Valuation): string | null {
  if (v.complete) return null;
  const what = v.invalid.length
    ? v.invalid.map((p) => `la position ${p.asset} (${POSITION_PROBLEM_FR[p.problem]})`).join(", ")
    : "le registre des liquidités";
  return `${what} ne peut pas être évaluée : la valeur totale et le plafond par position sont inconnus. Achats et décisions suspendus jusqu'à réparation (ton accord nécessaire) ; les ventes et les stops des autres positions continuent.`;
}

// ─── Capital, contributions, snapshots ──────────────────────────

function addLedger(db: DB, row: { at: string; kind: "capital" | "contribution" | "buy" | "sell"; asset?: string | null; quantity?: number | null; price?: number | null; amountEur: number; feeEur?: number; orderId?: string | null; note?: string | null }): void {
  // Last line of defence (step 0.3): the ledger is append-only, so a wrong row could never be corrected.
  const trade = row.kind === "buy" || row.kind === "sell";
  if (!Number.isFinite(row.amountEur) || !Number.isFinite(row.feeEur ?? 0) || (trade && (!positive(row.quantity ?? NaN) || !positive(row.price ?? NaN)))) {
    throw new Error(`refusing a ledger row with a non-finite or non-positive figure (${row.kind} ${row.asset ?? ""})`);
  }
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

/**
 * One equity snapshot per UTC day (the first tick of the day), for returns and drawdown. None while the
 * portfolio cannot be valued: a partial total would be stored for good (the table is append-only).
 */
export function snapshotTick(db: DB, now: Date = new Date()): boolean {
  const day = now.toISOString().slice(0, 10);
  const exists = db.prepare("SELECT 1 FROM trader_portfolio_days WHERE day = ?").get(day);
  if (exists) return false;
  const v = valuation(db);
  if (!v.complete || ![v.cashEur, v.positionsEur, v.equityEur, v.contributedEur].every(Number.isFinite)) return false;
  db.prepare(
    "INSERT INTO trader_portfolio_days (day, at, cash_eur, positions_eur, equity_eur, contributed_eur) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(day, now.toISOString(), v.cashEur, v.positionsEur, v.equityEur, v.contributedEur);
  return true;
}

export interface Snapshot { day: string; equityEur: number; contributedEur: number; cashEur: number; positionsEur: number }

/** Daily snapshots, oldest first; a day stored with a non-finite figure (before step 0.3) is left out, like a day without a tick. */
export function snapshots(db: DB, limit = 400): Snapshot[] {
  return (db.prepare("SELECT day, equity_eur, contributed_eur, cash_eur, positions_eur FROM trader_portfolio_days ORDER BY day DESC LIMIT ?").all(limit) as any[])
    .map((r) => ({ day: r.day, equityEur: r.equity_eur, contributedEur: r.contributed_eur, cashEur: r.cash_eur, positionsEur: r.positions_eur }))
    .filter((s) => [s.equityEur, s.contributedEur, s.cashEur, s.positionsEur].every(Number.isFinite))
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

/**
 * Quantity not yet committed to pending sell orders. Never more than held: from 2^25 units (about 33.5 M)
 * round8 can move a stored quantity up by one step, and a sale of "all" would then exceed the position.
 */
export function availableQuantity(db: DB, asset: string): number {
  const held = getPosition(db, asset)?.quantity ?? 0;
  const reserved = (db.prepare("SELECT COALESCE(SUM(quantity), 0) AS v FROM trader_orders WHERE status = 'pending' AND side = 'sell' AND asset = ?").get(asset) as { v: number }).v;
  return reserved === 0 ? held : Math.min(held, round8(held - reserved));
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
  if (kind === "limit" && side === "buy" && limitPrice! >= last.price) return { ok: false, error: `A buy limit must be below the current price (${plainPrice(last.price)} EUR); use a market order to buy now.` };
  if (kind === "limit" && side === "sell" && limitPrice! <= last.price) return { ok: false, error: `A sell limit must be above the current price (${plainPrice(last.price)} EUR); use a market order to sell now.` };
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
    const suspended = suspensionReason(v);
    if (suspended) return { ok: false, error: `Buying is suspended: ${suspended}.` };
    const held = v.positions.find((p) => p.asset === asset)?.valueEur ?? 0;
    const cap = (v.equityEur * pc.maxPositionPct) / 100;
    if (held + amountEur > cap + 0.005) {
      return { ok: false, error: `Position cap: ${asset} would be ${(held + amountEur).toFixed(2)} EUR, above ${pc.maxPositionPct} % of the portfolio (${cap.toFixed(2)} EUR).` };
    }
    invalidation = num(input.invalidation);
    if (origin === "model") {
      if (invalidation === null || Number.isNaN(invalidation)) return { ok: false, error: "A buy needs invalidation: the price (EUR) below which your thesis is wrong; code sells there." };
      const reference = kind === "limit" ? limitPrice! : last.price;
      if (invalidation >= reference) return { ok: false, error: `invalidation (${plainPrice(invalidation)}) must be below the entry price (${plainPrice(reference)} EUR).` };
      if (invalidation < reference * 0.5) return { ok: false, error: "invalidation must be within 50 % of the entry price." };
    }
  } else {
    const stored = getPosition(db, asset);
    const problem = stored ? positionProblem(stored) : null;
    if (problem) return { ok: false, error: `No sale: the stored ${asset} position cannot be used (${POSITION_PROBLEM_EN[problem]}); the owner must repair it.` };
    const held = availableQuantity(db, asset);
    if (held <= 0) return { ok: false, error: `No ${asset} to sell (or all of it is in a pending sell).` };
    const q = input.quantity === "all" || input.quantity === undefined ? held : num(input.quantity);
    if (q === null || Number.isNaN(q) || q <= 0) return { ok: false, error: "quantity must be a positive number or \"all\"." };
    quantity = q >= held ? held : Math.min(held, round8(q));
    if (!(quantity > 0)) return { ok: false, error: "quantity must be at least 0.00000001." };
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

/**
 * Half the relative spread from the stored order-book top, when fresh and sound (both sides positive and
 * finite, ask above bid); else the configured slippage. A sound but very wide quote is used as it is: capping
 * it would change the fee model (deferred by the owner, 2026-10-09).
 */
function slippageFraction(db: DB, asset: string, cfg: PortfolioConfig, now: Date): { fraction: number; source: string } {
  const row = db.prepare(
    `SELECT a.value AS ask, b.value AS bid, a.ts FROM trader_metrics a JOIN trader_metrics b
     ON a.source_id = b.source_id AND a.ts = b.ts AND a.metric = 'ask' AND b.metric = 'bid'
     WHERE a.source_id = ? ORDER BY a.ts DESC LIMIT 1`,
  ).get(`kraken_spread_${asset.toLowerCase()}`) as { ask: number; bid: number; ts: string } | undefined;
  if (row && positive(row.bid) && positive(row.ask) && row.ask > row.bid && now.getTime() - Date.parse(row.ts) <= SPREAD_MAX_AGE_HOURS * 3_600_000) {
    const fraction = (row.ask - row.bid) / ((row.ask + row.bid) / 2) / 2;
    if (Number.isFinite(fraction) && fraction >= 0) return { fraction, source: "carnet d'ordres Kraken" };
  }
  return { fraction: cfg.slippageBps / 10_000, source: "glissement configuré" };
}

export interface Fill { order: Order; trade: Trade | null }

type FillResult = { fill: Fill } | { rejected: Order };

/**
 * Settles a pending order as rejected (the one other way out of pending the schema allows) with a note the
 * model reads, and an incident in French for the owner. Nothing else is written. Null when the order was no
 * longer pending.
 */
function rejectOrder(db: DB, order: Order, reason: RejectReason, detail: string, now: Date): Order | null {
  const note = `rejected by code (${reason}): ${REJECT_EN[reason]}${detail ? ` [${detail}]` : ""}`;
  const changed = db.prepare("UPDATE trader_orders SET status = 'rejected', settled_at = ?, note = ? WHERE id = ? AND status = 'pending'")
    .run(isoSeconds(now), note, order.id).changes;
  if (changed !== 1) return null;
  recordIncident(db, "broker", `ordre ${order.id} (${order.side === "buy" ? "achat" : "vente"} ${order.asset}) refusé par le courtier virtuel : ` +
    `${REJECT_FR[reason]}${detail ? ` (${detail})` : ""}. Rien n'a été inscrit au registre.`, now);
  return getOrder(db, order.id)!;
}

/** The first problem among named figures: each must be finite, and the `positive` ones above 0. */
function figureProblem(figures: Record<string, number>, positiveNames: string[]): string | null {
  for (const [name, v] of Object.entries(figures)) {
    if (!Number.isFinite(v) || (positiveNames.includes(name) && v <= 0)) return `${name}=${v}`;
  }
  return null;
}

/** Which rejection a figure named by figureProblem stands for. */
function reasonOf(name: string): RejectReason {
  return name === "fill_price" || name === "avg_cost" || name === "price" ? "price" : name === "quantity" || name === "total_quantity" ? "quantity" : "amount";
}

/**
 * Fills one order at `price` (the market price, or the limit). Every figure is computed and checked before
 * anything is written (step 0.3): a zero, negative or non-finite price, quantity or amount settles the order
 * as rejected and writes no ledger, position or trade row.
 */
function applyFill(db: DB, cfg: TraderConfig, order: Order, price: number, slippageFraction: number, feePct: number, at: string, now: Date): FillResult {
  const reject = (reason: RejectReason, detail: string): FillResult => {
    const rejected = rejectOrder(db, order, reason, detail, now);
    return { rejected: rejected ?? getOrder(db, order.id)! };
  };
  if (!positive(price)) return reject("price", `price=${price}`);
  let trade: Trade | null = null;
  if (order.side === "buy") {
    const amount = order.amountEur!;
    const fillPrice = roundPrice(price * (1 + slippageFraction));
    const fee = round2(amount * (feePct / 100));
    const quantity = round8((amount - fee) / fillPrice);
    const slippage = round2(quantity * (fillPrice - price));
    const current = db.prepare("SELECT * FROM trader_positions WHERE asset = ?").get(order.asset) as any;
    const opening = !current || current.quantity <= 0;
    if (!opening) {
      const problem = positionProblem({ quantity: current.quantity, avgCost: current.avg_cost });
      if (problem) return reject("position", problem);
    }
    const totalQty = opening ? quantity : round8(current.quantity + quantity);
    // Average cost: what the units cost after the fee, so quantity × avg_cost is the cash paid for them.
    const avg = opening ? roundPrice((amount - fee) / quantity) : roundPrice((current.quantity * current.avg_cost + (amount - fee)) / totalQty);
    const bad = figureProblem(
      { amount, fill_price: fillPrice, quantity, total_quantity: totalQty, avg_cost: avg, fee, slippage },
      ["amount", "fill_price", "quantity", "total_quantity", "avg_cost"],
    );
    if (bad) return reject(reasonOf(bad.split("=")[0]), bad);
    db.transaction(() => {
      db.prepare(
        `UPDATE trader_orders SET status = 'filled', settled_at = ?, fill_price = ?, fill_quantity = ?, fill_eur = ?, fee_eur = ?, slippage_eur = ? WHERE id = ? AND status = 'pending'`,
      ).run(at, fillPrice, quantity, amount, fee, slippage, order.id);
      addLedger(db, { at, kind: "buy", asset: order.asset, quantity, price: fillPrice, amountEur: -amount, feeEur: fee, orderId: order.id });
      if (opening) {
        db.prepare(
          `INSERT OR REPLACE INTO trader_positions (asset, quantity, avg_cost, opened_at, open_order_id, invalidation, horizon_until, thesis, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(order.asset, quantity, avg, at, order.id, order.invalidation, order.horizonUntil, order.thesis, at);
      } else {
        // Adding to a position: the newer order's levels replace the older ones (the thesis is refreshed too).
        db.prepare(
          "UPDATE trader_positions SET quantity = ?, avg_cost = ?, invalidation = COALESCE(?, invalidation), horizon_until = ?, thesis = ?, updated_at = ? WHERE asset = ?",
        ).run(totalQty, avg, order.invalidation, order.horizonUntil, order.thesis, at, order.asset);
      }
    })();
  } else {
    const position = db.prepare("SELECT * FROM trader_positions WHERE asset = ?").get(order.asset) as any;
    if (!position || position.quantity <= 0) return reject("nothing", "");
    const problem = positionProblem({ quantity: position.quantity, avgCost: position.avg_cost });
    if (problem) return reject("position", problem);
    // Both quantities are on the 1e-8 grid: no second rounding (round8 is not idempotent from 2^25 units), and
    // a sale that would leave less than one step takes the whole position, so nothing is left behind.
    let quantity = Math.min(order.quantity!, position.quantity);
    if (!(round8(position.quantity - quantity) > 0)) quantity = position.quantity;
    const left = quantity === position.quantity ? 0 : round8(position.quantity - quantity);
    const fillPrice = roundPrice(price * (1 - slippageFraction));
    const proceeds = round2(quantity * fillPrice);
    const fee = round2(proceeds * (feePct / 100));
    const slippage = round2(quantity * (price - fillPrice));
    // Fees of the lot: the purchase fees the position carries in proportion of the quantity sold, plus this sale's fee.
    const entryFee = (carriedEntryFees(db, order.asset, position.opened_at, position.open_order_id) * quantity) / position.quantity;
    const cost = quantity * position.avg_cost;
    // Recorded before the purchase fee, as every trade since the first (the table is append-only):
    // rowToTrade subtracts the purchase share, so readers get the result after every fee.
    const pnl = round2(proceeds - fee - cost);
    const pnlPct = (pnl / cost) * 100;
    const bad = figureProblem(
      { fill_price: fillPrice, quantity, proceeds, fee, slippage, entry_fee: entryFee, cost, pnl, pnl_pct: pnlPct, left },
      ["fill_price", "quantity", "cost"],
    );
    if (bad) return reject(reasonOf(bad.split("=")[0]), bad);
    const tradeId = `t_${ulid()}`;
    db.transaction(() => {
      db.prepare(
        `UPDATE trader_orders SET status = 'filled', settled_at = ?, fill_price = ?, fill_quantity = ?, fill_eur = ?, fee_eur = ?, slippage_eur = ? WHERE id = ? AND status = 'pending'`,
      ).run(at, fillPrice, quantity, proceeds, fee, slippage, order.id);
      addLedger(db, { at, kind: "sell", asset: order.asset, quantity, price: fillPrice, amountEur: proceeds - fee, feeEur: fee, orderId: order.id });
      db.prepare(
        `INSERT INTO trader_trades (id, asset, opened_at, closed_at, quantity, entry_price, exit_price, fees_eur, pnl_eur, pnl_pct, open_order_id, close_order_id, close_reason, thesis)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(tradeId, order.asset, position.opened_at, at, quantity, position.avg_cost, fillPrice, round2(entryFee + fee), pnl, pnlPct,
        position.open_order_id, order.id, order.origin === "stop" ? "stop" : "model", position.thesis);
      db.prepare("UPDATE trader_positions SET quantity = ?, updated_at = ? WHERE asset = ?").run(left, at, order.asset);
    })();
    trade = getTrade(db, tradeId)!;
  }
  return { fill: { order: getOrder(db, order.id)!, trade } };
}

export interface BrokerOutcome {
  fills: Fill[];
  expired: Order[];
  stops: Order[];
  /** Orders code refused to fill because a figure was invalid (nothing written for them). */
  rejected: Order[];
  /** Orders left pending after an unexpected error (retried at the next tick, or they expire). */
  failed: string[];
  /** Positions whose horizon passed since the last tick (the model is asked what to do). */
  horizons: Position[];
  funded: { capital: boolean; contribution: boolean };
  snapshot: boolean;
}

/** One broker incident per key and UTC day: a lasting problem is reported, not repeated at every tick. */
function brokerIncidentOnce(db: DB, key: string, message: string, now: Date): void {
  const day = now.toISOString().slice(0, 10);
  if (getKV(db, key) === day) return;
  setKV(db, key, day);
  recordIncident(db, "broker", message, now);
}

/**
 * Code places a stop by clearing the position's invalidation level. When that stop is rejected, the level is
 * put back once a day (the next tick places the stop again) so the position is never left without a stop
 * silently; a second rejection the same day leaves it without one, with an incident.
 */
function restoreStopLevel(db: DB, order: Order, now: Date): void {
  const position = getPosition(db, order.asset);
  if (!position || position.invalidation !== null) return;
  const row = db.prepare(
    "SELECT old_value FROM trader_position_updates WHERE asset = ? AND field = 'invalidation' AND by = 'code' AND new_value IS NULL ORDER BY at DESC, id DESC LIMIT 1",
  ).get(order.asset) as { old_value: string | null } | undefined;
  const level = Number(row?.old_value ?? NaN);
  const day = now.toISOString().slice(0, 10);
  const key = `sonni.stop_restored.${order.asset}`;
  if (positive(level) && getKV(db, key) !== day) {
    setKV(db, key, day);
    const nowIso = isoSeconds(now);
    db.prepare("UPDATE trader_positions SET invalidation = ?, updated_at = ? WHERE asset = ? AND invalidation IS NULL").run(level, nowIso, order.asset);
    db.prepare("INSERT INTO trader_position_updates (id, asset, at, field, old_value, new_value, reason, by) VALUES (?, ?, ?, 'invalidation', NULL, ?, ?, 'code')")
      .run(`u_${ulid()}`, order.asset, nowIso, String(level), `stop order ${order.id} rejected by the broker: level restored, the stop is placed again at the next tick`);
    recordIncident(db, "broker", `stop de ${order.asset} refusé par le courtier virtuel : niveau ${fmtPrice(level)} rétabli, le code le replace au prochain relevé.`, now);
  } else {
    recordIncident(db, "broker", `stop de ${order.asset} refusé par le courtier virtuel : la position reste sans stop jusqu'à demain (niveau déjà rétabli une fois aujourd'hui). Vérifie /portefeuille.`, now);
  }
}

/**
 * Runs after each price collection: funding, fills at the first price
 * stored after each order (market) or at the limit when crossed (limit),
 * expiries, stops on positions whose invalidation level is reached, and
 * the daily snapshot. Deterministic; no inference. One order that cannot
 * be processed never stops the others, the stops or the snapshot (step 0.3).
 */
export function brokerTick(db: DB, cfg: TraderConfig, now: Date = new Date()): BrokerOutcome {
  const out: BrokerOutcome = { fills: [], expired: [], stops: [], rejected: [], failed: [], horizons: [], funded: fundingTick(db, cfg.portfolio, now), snapshot: false };
  const nowIso = isoSeconds(now);
  for (const order of pendingOrders(db)) {
    try {
      const after = isoSeconds(new Date(Date.parse(order.placedAt) + 1000));
      const point: PricePoint | undefined = order.kind === "market"
        ? priceAtOrAfter(db, order.asset, after, nowIso)
        : firstCrossing(db, order, after, nowIso);
      if (point) {
        const slip = order.kind === "market" ? slippageFraction(db, order.asset, cfg.portfolio, now) : { fraction: 0, source: "limite" };
        const fee = order.kind === "market" ? cfg.portfolio.takerFeePct : cfg.portfolio.makerFeePct;
        const price = order.kind === "market" ? point.price : order.limitPrice!;
        const result = applyFill(db, cfg, order, price, slip.fraction, fee, point.ts, now);
        if ("fill" in result) out.fills.push(result.fill);
        else {
          out.rejected.push(result.rejected);
          if (order.origin === "stop") restoreStopLevel(db, order, now);
        }
        continue;
      }
      const ttl = order.kind === "market" ? Date.parse(order.placedAt) + MARKET_ORDER_TTL_HOURS * 3_600_000 : Date.parse(order.horizonUntil);
      if (now.getTime() > ttl) {
        db.prepare("UPDATE trader_orders SET status = 'expired', settled_at = ?, note = ? WHERE id = ? AND status = 'pending'")
          .run(nowIso, order.kind === "market" ? "no price stored within 24 h" : "limit not reached before the horizon", order.id);
        out.expired.push(getOrder(db, order.id)!);
      }
    } catch (err) {
      // Nothing of this order was written (its fill is one transaction); it stays pending and is retried.
      out.failed.push(order.id);
      const message = err instanceof Error ? err.message : String(err);
      brokerIncidentOnce(db, `sonni.broker_failed.${order.id}`,
        `ordre ${order.id} (${order.side === "buy" ? "achat" : "vente"} ${order.asset}) : échec technique du courtier virtuel, l'ordre reste en attente (${message.slice(0, 160)}).`, now);
    }
  }
  // Positions code cannot value (stored before step 0.3): reported once a day, never sold or stopped by code.
  const v = valuation(db);
  const invalid = new Set(v.invalid.map((p) => p.asset));
  for (const p of v.invalid) {
    brokerIncidentOnce(db, `sonni.invalid_position.${p.asset}`,
      `position ${p.asset} invalide (${POSITION_PROBLEM_FR[p.problem]}) : valeur du portefeuille inconnue, achats, décisions et instantanés suspendus, ` +
      `aucun stop possible sur elle. Une réparation demande ton accord.`, now);
  }
  // Stops: a position whose invalidation level is reached gets a market sell from code, filled at the next price.
  for (const p of listPositions(db)) {
    if (p.invalidation === null || invalid.has(p.asset)) continue;
    const last = latestPrice(db, p.asset);
    if (!last || ageMinutes(last, now) > cfg.staleMinutes || last.price > p.invalidation) continue;
    if (pendingOrders(db, p.asset).some((o) => o.side === "sell")) continue;
    const stop = placeOrder(db, cfg, {
      asset: p.asset, side: "sell", kind: "market", quantity: "all",
      thesis: `Stop: ${p.asset} reached the invalidation level ${plainPrice(p.invalidation)} EUR (last price ${plainPrice(last.price)} EUR); the thesis was: ${p.thesis}`.slice(0, THESIS_MAX),
      horizonHours: 24,
    }, now, "stop");
    if (stop.ok) {
      db.prepare("UPDATE trader_positions SET invalidation = NULL, updated_at = ? WHERE asset = ?").run(nowIso, p.asset);
      db.prepare("INSERT INTO trader_position_updates (id, asset, at, field, old_value, new_value, reason, by) VALUES (?, ?, ?, 'invalidation', ?, NULL, ?, 'code')")
        .run(`u_${ulid()}`, p.asset, nowIso, String(p.invalidation), `stop triggered at ${plainPrice(last.price)} EUR (order ${stop.value.id})`);
      out.stops.push(stop.value);
    }
  }
  // Horizons: once per position horizon, the model is asked what to do (the position stays).
  for (const p of listPositions(db)) {
    if (!p.horizonUntil || p.horizonUntil > nowIso || invalid.has(p.asset)) continue;
    if (getKV(db, `sonni.horizon_seen.${p.asset}`) === p.horizonUntil) continue;
    setKV(db, `sonni.horizon_seen.${p.asset}`, p.horizonUntil);
    out.horizons.push(p);
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
    if (level >= last.price) return { ok: false, error: `The invalidation level (${plainPrice(level)}) must be below the current price (${plainPrice(last.price)} EUR): it is where code sells.` };
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
  /** False while a corrupt stored position makes the value unknown: equity and result are then NaN, the changes null. */
  complete: boolean;
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
    if (!v.complete) return null;
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
    complete: v.complete,
    equityEur: v.equityEur, contributedEur: v.contributedEur, pnlEur: v.pnlEur, pnlPct: v.pnlPct,
    change7dPct: change(7), change30dPct: change(30), change90dPct: change(90),
    maxDrawdownPct: maxDd, tradesClosed: trades.length,
    winRate: trades.length ? wins / trades.length : null,
    avgTradePct: trades.length ? trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length : null,
    feesEur: fees,
    selfFundingRatio: v.complete && spentEur > 0 ? v.pnlEur / spentEur : null,
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
