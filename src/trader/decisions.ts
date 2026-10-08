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

export interface DecisionStats {
  total: number;
  scored24h: number;
  good24h: number;
  scored7d: number;
  good7d: number;
  /** Flat decisions scored at 7 days: losses avoided (price fell) and gains missed (price rose). */
  flatAvoided: number;
  flatMissed: number;
  byAction: Partial<Record<DecisionAction, number>>;
}

export function decisionStats(db: DB, since: string): DecisionStats {
  const ds = listDecisions(db, since);
  const s: DecisionStats = { total: ds.length, scored24h: 0, good24h: 0, scored7d: 0, good7d: 0, flatAvoided: 0, flatMissed: 0, byAction: {} };
  for (const d of ds) {
    s.byAction[d.action] = (s.byAction[d.action] ?? 0) + 1;
    const o1 = decisionOutcome(db, d, 24);
    if (o1) { s.scored24h++; if (o1.good) s.good24h++; }
    const o7 = decisionOutcome(db, d, 168);
    if (o7) {
      s.scored7d++;
      if (o7.good) s.good7d++;
      if (!isLong(d)) { if (o7.movePct <= 0) s.flatAvoided++; else s.flatMissed++; }
    }
  }
  return s;
}

/** For the memory pack (English): the latest decision per asset with code's score, and which are due. */
export function decisionsPackLines(db: DB, cfg: TraderConfig, now: Date = new Date()): string[] {
  const lines: string[] = [];
  for (const a of activeAssets(db, cfg)) {
    const d = listDecisions(db, undefined, a.symbol)[0];
    if (!d) { lines.push(`- ${a.symbol}: no decision yet.`); continue; }
    const o = decisionOutcome(db, d, 24);
    lines.push(`- ${a.symbol}: ${d.action} at ${d.price} EUR on ${d.madeAt.slice(0, 16).replace("T", " ")} UTC` +
      (o ? `; 24 h later ${o.movePct >= 0 ? "+" : ""}${o.movePct.toFixed(2)} % (${o.good ? "right side" : "wrong side"})` : "; not scored yet"));
  }
  const due = decisionsDue(db, cfg, now);
  if (due.length) lines.push(`Due now (no decision in ${DECISION_HOURS} h): ${due.join(", ")}.`);
  return lines;
}
