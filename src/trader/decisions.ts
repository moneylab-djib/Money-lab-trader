/**
 * Explicit decisions per asset (step 1 of the 2026-10-08 plan).
 *
 * On 2026-10-07 Sonni kept its 1,000 EUR in cash all day: nothing made
 * staying out a choice it had to state, and staying out was never
 * measured. Now each followed asset gets a stated decision (buy, add,
 * hold, reduce, sell or stay out) with a reason when none was recorded in
 * the last DECISION_HOURS; code stores the market snapshot with it
 * (append-only) and scores it from stored prices, so cash is a decision
 * judged like the others. No trade is forced. This is a per-decision
 * measure, not a benchmark against passive investing (decision 0001).
 */

import type Database from "better-sqlite3";
import { ulid } from "ulid";
import { containsInjectionPatterns } from "../soul/validator.js";
import type { TraderConfig } from "./config.js";
import { activeAssets } from "./universe.js";
import { ageMinutes, isoSeconds, latestPrice, priceAtOrAfter } from "./prices.js";
import { valuation } from "./portfolio.js";
import type { SoulResult } from "./soul.js";

type DB = Database.Database;

export const DECISION_ACTIONS = ["buy", "add", "hold", "reduce", "sell", "stay_out"] as const;
export type DecisionAction = (typeof DECISION_ACTIONS)[number];
/** A followed asset without a decision for this long is due one. */
export const DECISION_HOURS = 8;
/** At most one decision per asset in this many minutes. */
export const DECISION_MIN_GAP_MINUTES = 60;
export const DECISION_REASON_MIN = 20;
export const DECISION_REASON_MAX = 600;
export const MAX_DECISIONS_PER_CALL = 30;
/** Horizons at which code scores a decision. */
export const DECISION_HORIZONS_HOURS = [24, 168] as const;

export const ACTION_FR: Record<DecisionAction, string> = {
  buy: "acheter", add: "renforcer", hold: "garder", reduce: "alléger", sell: "vendre", stay_out: "rester en dehors",
};

export interface Decision {
  id: string;
  madeAt: string;
  asset: string;
  action: DecisionAction;
  reason: string;
  price: number;
  positionEur: number;
  equityEur: number;
  orderId: string | null;
}

function rowToDecision(r: any): Decision {
  return {
    id: r.id, madeAt: r.made_at, asset: r.asset, action: r.action, reason: r.reason, price: r.price,
    positionEur: r.position_eur, equityEur: r.equity_eur, orderId: r.order_id,
  };
}

export function getDecision(db: DB, id: string): Decision | undefined {
  const row = db.prepare("SELECT * FROM trader_decisions WHERE id = ?").get(id);
  return row ? rowToDecision(row) : undefined;
}

/** Exposure the decision leaves: long after buy, add, hold of a held position; flat otherwise. */
export function isLong(d: Pick<Decision, "action" | "positionEur">): boolean {
  return d.action === "buy" || d.action === "add" || (d.action === "hold" && d.positionEur > 0);
}

export interface DecisionInput {
  asset: unknown;
  action: unknown;
  reason: unknown;
  orderId?: unknown;
}

export function recordDecision(db: DB, cfg: TraderConfig, input: DecisionInput, now: Date = new Date()): SoulResult<Decision> {
  const asset = String(input.asset ?? "").toUpperCase().trim();
  if (!cfg.assets.some((a) => a.symbol === asset)) return { ok: false, error: `Unknown asset ${asset || "(none)"}: you follow ${cfg.assets.map((a) => a.symbol).join(", ")}.` };
  const action = String(input.action ?? "") as DecisionAction;
  if (!DECISION_ACTIONS.includes(action)) return { ok: false, error: `action must be one of ${DECISION_ACTIONS.join(", ")}.` };
  const reason = String(input.reason ?? "").trim();
  if (reason.length < DECISION_REASON_MIN || reason.length > DECISION_REASON_MAX) {
    return { ok: false, error: `reason: ${DECISION_REASON_MIN} to ${DECISION_REASON_MAX} characters, in French.` };
  }
  if (containsInjectionPatterns(reason)) return { ok: false, error: "reason contains a prompt-boundary pattern." };
  const last = latestPrice(db, asset);
  if (!last) return { ok: false, error: `No ${asset} price stored yet.` };
  if (ageMinutes(last, now) > cfg.staleMinutes) return { ok: false, error: `The last ${asset} price is stale: no decision on a stale price.` };
  const v = valuation(db);
  const held = v.positions.find((p) => p.asset === asset);
  const positionEur = held ? held.valueEur : 0;
  if ((action === "reduce" || action === "sell" || action === "add") && positionEur <= 0) {
    return { ok: false, error: `You hold no ${asset}: ${action} needs a position (use buy or stay_out).` };
  }
  let orderId: string | null = null;
  if (input.orderId !== undefined && input.orderId !== null && String(input.orderId).trim() !== "") {
    orderId = String(input.orderId).trim();
    const order = db.prepare("SELECT asset FROM trader_orders WHERE id = ?").get(orderId) as { asset: string } | undefined;
    if (!order || order.asset !== asset) return { ok: false, error: `Order ${orderId} is not an order on ${asset}.` };
  }
  const since = isoSeconds(new Date(now.getTime() - DECISION_MIN_GAP_MINUTES * 60_000));
  if (db.prepare("SELECT 1 FROM trader_decisions WHERE asset = ? AND made_at > ?").get(asset, since)) {
    return { ok: false, error: `A decision on ${asset} was recorded less than ${DECISION_MIN_GAP_MINUTES} minutes ago.` };
  }
  const id = `d_${ulid()}`;
  db.prepare(
    `INSERT INTO trader_decisions (id, made_at, asset, action, reason, price, position_eur, equity_eur, order_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, isoSeconds(now), asset, action, reason, last.price, positionEur, v.equityEur, orderId);
  return { ok: true, value: rowToDecision(db.prepare("SELECT * FROM trader_decisions WHERE id = ?").get(id)) };
}

export function listDecisions(db: DB, since?: string, asset?: string): Decision[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (since) { where.push("made_at >= ?"); params.push(since); }
  if (asset) { where.push("asset = ?"); params.push(asset); }
  return (db.prepare(`SELECT * FROM trader_decisions${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY made_at DESC`)
    .all(...params) as any[]).map(rowToDecision);
}

/** Followed assets without a decision in the last DECISION_HOURS. */
export function decisionsDue(db: DB, cfg: TraderConfig, now: Date = new Date()): string[] {
  const since = isoSeconds(new Date(now.getTime() - DECISION_HOURS * 3_600_000));
  return activeAssets(db, cfg).map((a) => a.symbol)
    .filter((s) => !db.prepare("SELECT 1 FROM trader_decisions WHERE asset = ? AND made_at >= ?").get(s, since));
}

export interface DecisionOutcome {
  /** Price change in % from the decision to the first stored price at or after the horizon. */
  movePct: number;
  /** True when the exposure the decision left was on the right side of the move. */
  good: boolean;
}

/** Scored by code from stored prices; null until a price exists after the horizon (within a day). */
export function decisionOutcome(db: DB, d: Decision, horizonHours: number): DecisionOutcome | null {
  const at = new Date(Date.parse(d.madeAt) + horizonHours * 3_600_000);
  const p = priceAtOrAfter(db, d.asset, isoSeconds(at), isoSeconds(new Date(at.getTime() + 24 * 3_600_000)));
  if (!p) return null;
  const movePct = (p.price / d.price - 1) * 100;
  return { movePct, good: isLong(d) ? movePct > 0 : movePct <= 0 };
}

/**
 * The rise a market buy needs before its market sale pays back what it cost: the taker fee on both legs and
 * the configured slippage on both fills, in %. A flat round trip loses a little less than this (about 1.69 %
 * of the stake for 1.72 %); limit orders pay the lower maker fee, and a fresh order-book spread can make a
 * real fill cheaper or dearer.
 */
export function breakEvenMovePct(cfg: TraderConfig): number {
  const fee = cfg.portfolio.takerFeePct / 100;
  const slip = cfg.portfolio.slippageBps / 10_000;
  return ((1 + slip) / ((1 - fee) ** 2 * (1 - slip)) - 1) * 100;
}

export interface DecisionStats {
  total: number;
  /** Right side: the direction of the move matched the exposure the decision left (fees aside). */
  scored24h: number;
  good24h: number;
  scored7d: number;
  good7d: number;
  /** Buys and adds scored at 7 days, and those whose move beat the round-trip break-even (profitable after fees). */
  entries7d: number;
  entriesPaid7d: number;
  /**
   * Flat decisions scored at 7 days. A rise counts as a missed gain only when a buy would have paid its fees:
   * beyond the break-even move after staying out, beyond 0 after selling or reducing (the sale was paid either
   * way). Every other move is a loss avoided; flatSmallRises counts the rises inside the fees among them.
   */
  flatAvoided: number;
  flatMissed: number;
  flatSmallRises: number;
  breakEvenPct: number;
  byAction: Partial<Record<DecisionAction, number>>;
}

/** Decisions made at or after `since` (and before `until` when given), scored by code. */
export function decisionStats(db: DB, cfg: TraderConfig, since: string, until?: string): DecisionStats {
  const ds = listDecisions(db, since).filter((d) => until === undefined || d.madeAt < until);
  const breakEven = breakEvenMovePct(cfg);
  const s: DecisionStats = {
    total: ds.length, scored24h: 0, good24h: 0, scored7d: 0, good7d: 0, entries7d: 0, entriesPaid7d: 0,
    flatAvoided: 0, flatMissed: 0, flatSmallRises: 0, breakEvenPct: breakEven, byAction: {},
  };
  for (const d of ds) {
    s.byAction[d.action] = (s.byAction[d.action] ?? 0) + 1;
    const o1 = decisionOutcome(db, d, 24);
    if (o1) { s.scored24h++; if (o1.good) s.good24h++; }
    const o7 = decisionOutcome(db, d, 168);
    if (o7) {
      s.scored7d++;
      if (o7.good) s.good7d++;
      if (d.action === "buy" || d.action === "add") { s.entries7d++; if (o7.movePct > breakEven) s.entriesPaid7d++; }
      if (!isLong(d)) {
        const threshold = d.action === "sell" || d.action === "reduce" ? 0 : breakEven;
        if (o7.movePct > threshold) s.flatMissed++;
        else { s.flatAvoided++; if (o7.movePct > 0) s.flatSmallRises++; }
      }
    }
  }
  return s;
}

/** For the memory pack (English): the latest decision per asset with code's score, and which are due. */
export function decisionsPackLines(db: DB, cfg: TraderConfig, now: Date = new Date()): string[] {
  const lines: string[] = [];
  const breakEven = breakEvenMovePct(cfg);
  for (const a of activeAssets(db, cfg)) {
    const d = listDecisions(db, undefined, a.symbol)[0];
    if (!d) { lines.push(`- ${a.symbol}: no decision yet.`); continue; }
    const o = decisionOutcome(db, d, 24);
    const entry = d.action === "buy" || d.action === "add";
    lines.push(`- ${a.symbol}: ${d.action} at ${d.price} EUR on ${d.madeAt.slice(0, 16).replace("T", " ")} UTC` +
      (o ? `; 24 h later ${o.movePct >= 0 ? "+" : ""}${o.movePct.toFixed(2)} % (${o.good ? "right side" : "wrong side"}` +
        `${entry ? `, ${o.movePct > breakEven ? "beyond" : "not beyond"} the ${breakEven.toFixed(2)} % rise a market round trip needs to pay its fees and slippage` : ""})` : "; not scored yet"));
  }
  const due = decisionsDue(db, cfg, now);
  if (due.length) lines.push(`Due now (no decision in ${DECISION_HOURS} h): ${due.join(", ")}.`);
  return lines;
}
