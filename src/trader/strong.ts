/**
 * Big decisions go to the stronger model (step 1 of the 2026-10-08 plan).
 *
 * A buy of at least `portfolio.bigOrderPct` of the portfolio is not placed
 * on an ordinary turn: place_order holds it, and the loop runs the next turn
 * on the stronger model (the weekly review's), which places it again or
 * drops it; the hold is cleared once that turn has run, or after two hours. The stronger model's spend is limited to STRONG_DAILY_SHARE of
 * the daily cap; once that share is used, a big order is placed on the
 * ordinary turn with a note, so the share cannot block trading.
 */

import type Database from "better-sqlite3";
import { deleteKV, getKV, setKV } from "../money-lab/journal.js";

type DB = Database.Database;

export const STRONG_DAILY_SHARE = 0.5;
/** Set by the loop before a turn's tools run: "1" on a stronger-model turn. */
export const KV_STRONG_TURN = "sonni.strong_turn";
const KV_PENDING = "sonni.big_order_pending";
/** A held order not confirmed within this time is dropped. */
export const PENDING_MAX_MINUTES = 120;

export interface PendingBigOrder {
  at: string;
  asset: string;
  amountEur: number;
  sharePct: number;
}

export function isStrongTurn(db: DB): boolean {
  return getKV(db, KV_STRONG_TURN) === "1";
}

export function setStrongTurn(db: DB, strong: boolean): void {
  setKV(db, KV_STRONG_TURN, strong ? "1" : "0");
}

/** Spend on the stronger (Opus) model today, UTC day, in cents. */
export function strongSpendTodayCents(db: DB, now: Date = new Date()): number {
  const day = now.toISOString().slice(0, 10);
  const row = db.prepare(
    "SELECT COALESCE(SUM(cost_cents), 0) AS c FROM inference_costs WHERE model LIKE '%opus%' AND created_at >= ? AND created_at < date(?, '+1 day')",
  ).get(day, day) as { c: number };
  return row.c;
}

/** False once the stronger model used its share of the daily cap (no cap: always true). */
export function strongBudgetLeft(db: DB, dailyCapCents: number | null, now: Date = new Date()): boolean {
  if (dailyCapCents === null) return true;
  return strongSpendTodayCents(db, now) < dailyCapCents * STRONG_DAILY_SHARE;
}

export function isBigOrder(bigOrderPct: number, equityEur: number, amountEur: number): boolean {
  return equityEur > 0 && amountEur >= (bigOrderPct / 100) * equityEur;
}

export function readPendingBigOrder(db: DB, now: Date = new Date()): PendingBigOrder | null {
  const raw = getKV(db, KV_PENDING);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as PendingBigOrder;
    if (now.getTime() - Date.parse(p.at) > PENDING_MAX_MINUTES * 60_000) {
      deleteKV(db, KV_PENDING);
      return null;
    }
    return p;
  } catch {
    deleteKV(db, KV_PENDING);
    return null;
  }
}

export function holdBigOrder(db: DB, asset: string, amountEur: number, sharePct: number, now: Date = new Date()): void {
  setKV(db, KV_PENDING, JSON.stringify({ at: now.toISOString(), asset, amountEur, sharePct } satisfies PendingBigOrder));
}

export function clearBigOrder(db: DB): void {
  deleteKV(db, KV_PENDING);
}

export function bigOrderInstructions(p: PendingBigOrder): string {
  return `SONNI BIG DECISION (this turn runs on your stronger model): an ordinary turn proposed a buy of ` +
    `${p.amountEur.toFixed(2)} EUR of ${p.asset} (${p.sharePct.toFixed(1)} % of the portfolio). It was NOT placed. ` +
    "Re-examine it from scratch: your dossier, the odds code computes (market_odds), open positions and traps. " +
    "To confirm, call place_order again with the arguments you judge right (same or smaller); otherwise say in one " +
    "sentence why you drop it.";
}
