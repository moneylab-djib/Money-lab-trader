/**
 * Day, week and month summaries computed by code (plan of 2026-10-08 step 4, docs/RESEARCH.md 5.1).
 *
 * The archive level of memory v2 holds everything, but "what happened the week of 28 September?" should
 * not need forty searches. Code writes one summary per finished UTC day, ISO week (Monday to Sunday) and
 * month, once, from the append-only stores: market moves, predictions made and resolved with their Brier
 * score against code's reference, decisions, orders and closed trades, the portfolio's result net of the
 * owner's contributions, lessons added and retired, journal entries and the owner's notes. Facts only, in
 * French (the owner reads them in /memoire, Claude reads French), and each one keeps the ids it counted
 * (`sources`) so a search that lands on a summary leads to the details. A period where nothing happened
 * gets no summary. No inference: a summary costs nothing.
 */

import type Database from "better-sqlite3";
import type { TraderConfig } from "./config.js";
import { activeAssets } from "./universe.js";
import { skillBetween } from "./snapshot.js";

type DB = Database.Database;

export type SummaryPeriod = "day" | "week" | "month";
export const SUMMARY_LOOKBACK_DAYS = 120;
/** Ids shown in the text (all of them stay in `sources`). */
const IDS_IN_TEXT = 12;

export interface Summary {
  period: SummaryPeriod;
  /** First day of the period and the day after its last, UTC: [start, end). */
  start: string;
  end: string;
  content: string;
  sources: string[];
  recordedAt: string;
}

const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Finished periods in the lookback window, as [start, end) UTC dates. */
export function finishedPeriods(now: Date, lookbackDays = SUMMARY_LOOKBACK_DAYS): { period: SummaryPeriod; start: string; end: string }[] {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const oldest = today - lookbackDays * DAY;
  const out: { period: SummaryPeriod; start: string; end: string }[] = [];
  for (let t = oldest; t < today; t += DAY) out.push({ period: "day", start: iso(t), end: iso(t + DAY) });
  const monday = today - ((new Date(today).getUTCDay() + 6) % 7) * DAY; // this week's Monday
  for (let t = monday - 7 * DAY; t >= oldest; t -= 7 * DAY) out.push({ period: "week", start: iso(t), end: iso(t + 7 * DAY) });
  const d = new Date(today);
  for (let m = 1; ; m++) {
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - m, 1);
    if (start < oldest) break;
    out.push({ period: "month", start: iso(start), end: iso(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - m + 1, 1)) });
  }
  return out;
}

const pct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1).replace(".", ",")} %`;
const eur = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2).replace(".", ",")} €`;
const brier = (v: number) => v.toFixed(3).replace(".", ",");
const ACTION_FR: Record<string, string> = { buy: "acheter", add: "renforcer", hold: "garder", reduce: "alléger", sell: "vendre", stay_out: "rester dehors" };
const LABEL: Record<SummaryPeriod, (start: string, end: string) => string> = {
  day: (s) => `Journée du ${s}`,
  week: (s, e) => `Semaine du ${s} au ${iso(Date.parse(e) - DAY)}`,
  month: (s) => `Mois de ${["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"][Number(s.slice(5, 7)) - 1]} ${s.slice(0, 4)}`,
};

function hasTable(db: DB, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(name);
}

/** The facts of one period, or null when nothing happened in it. */
export function summarize(db: DB, cfg: TraderConfig, period: SummaryPeriod, start: string, end: string): { content: string; sources: string[] } | null {
  const from = `${start}T00:00:00.000Z`;
  const to = `${end}T00:00:00.000Z`;
  const rows = <T>(sql: string): T[] => db.prepare(sql).all(from, to) as T[];
  const made = rows<{ id: string; asset: string }>("SELECT id, asset FROM trader_predictions WHERE made_at >= ? AND made_at < ? ORDER BY made_at");
  const resolved = rows<{ id: string; brier: number | null }>("SELECT id, brier FROM trader_predictions WHERE resolved_at >= ? AND resolved_at < ? ORDER BY resolved_at");
  const decisions = hasTable(db, "trader_decisions")
    ? rows<{ id: string; asset: string; action: string }>("SELECT id, asset, action FROM trader_decisions WHERE made_at >= ? AND made_at < ? ORDER BY made_at")
    : [];
  const orders = rows<{ id: string; side: string; asset: string }>(
    "SELECT id, side, asset FROM trader_orders WHERE origin = 'model' AND placed_at >= ? AND placed_at < ? ORDER BY placed_at",
  );
  const trades = rows<{ id: string; asset: string; pnl_eur: number }>("SELECT id, asset, pnl_eur FROM trader_trades WHERE closed_at >= ? AND closed_at < ? ORDER BY closed_at");
  const added = rows<{ id: string }>("SELECT id FROM trader_lessons WHERE recorded_at >= ? AND recorded_at < ?");
  const retired = rows<{ id: string }>("SELECT id FROM trader_lessons WHERE retired_at >= ? AND retired_at < ?");
  const reflections = rows<{ id: string; kind: string }>("SELECT id, kind FROM trader_reflections WHERE recorded_at >= ? AND recorded_at < ?");
  const notes = rows<{ id: string }>("SELECT id FROM trader_owner_notes WHERE at >= ? AND at < ?");
  const happened = made.length + resolved.length + decisions.length + orders.length + trades.length + added.length + retired.length + reflections.length + notes.length;
  if (happened === 0) return null;

  const parts: string[] = [];
  // Market: each followed asset's move over the period, from the daily closes before and at its end.
  // An asset without a traded day inside the period shows no move rather than a false 0 %.
  const moves = activeAssets(db, cfg).map((a) => {
    const close = (before: string) => db.prepare("SELECT day, close FROM trader_candles WHERE asset = ? AND day < ? AND volume > 0 ORDER BY day DESC LIMIT 1").get(a.symbol, before) as { day: string; close: number } | undefined;
    const first = close(start);
    const last = close(end);
    return first && last && last.day >= start ? `${a.symbol} ${pct((last.close / first.close - 1) * 100)}` : null;
  }).filter(Boolean);
  if (moves.length) parts.push(`marché ${moves.join(", ")}`);
  if (made.length || resolved.length) {
    const scored = resolved.filter((r) => r.brier !== null);
    const skill = skillBetween(db, from, to);
    let line = `prédictions : ${made.length} faite(s)`;
    if (made.length) {
      const per = new Map<string, number>();
      for (const p of made) per.set(p.asset, (per.get(p.asset) ?? 0) + 1);
      line += ` (${[...per].map(([a, n]) => `${a} ${n}`).join(", ")})`;
    }
    line += `, ${scored.length} résolue(s)`;
    if (scored.length) {
      line += `, Brier moyen ${brier(scored.reduce((s, r) => s + r.brier!, 0) / scored.length)}`;
      if (skill.n > 0 && skill.refBrier !== null && skill.skill !== null) line += ` contre ${brier(skill.refBrier)} pour la référence du code (compétence ${pct(skill.skill * 100)})`;
    }
    parts.push(line);
  }
  if (decisions.length) {
    const last = new Map<string, string>();
    for (const d of decisions) last.set(d.asset, d.action);
    parts.push(`décisions : ${decisions.length} (dernière par actif : ${[...last].map(([a, act]) => `${a} ${ACTION_FR[act] ?? act}`).join(", ")})`);
  }
  if (orders.length || trades.length) {
    const buys = orders.filter((o) => o.side === "buy").length;
    let line = `ordres : ${buys} achat(s), ${orders.length - buys} vente(s)`;
    if (trades.length) line += ` ; ${trades.length} opération(s) close(s), ${eur(trades.reduce((s, t) => s + t.pnl_eur, 0))}`;
    parts.push(line);
  }
  if (hasTable(db, "trader_portfolio_days")) {
    const mark = (before: string) => db.prepare("SELECT day, equity_eur, contributed_eur FROM trader_portfolio_days WHERE day < ? ORDER BY day DESC LIMIT 1").get(before) as { day: string; equity_eur: number; contributed_eur: number } | undefined;
    const a = mark(start);
    const b = mark(end);
    if (a && b && a.day !== b.day) parts.push(`portefeuille ${b.equity_eur.toFixed(2).replace(".", ",")} € (résultat ${eur(b.equity_eur - b.contributed_eur - (a.equity_eur - a.contributed_eur))} hors apports)`);
  }
  if (added.length || retired.length) parts.push(`leçons : +${added.length}, −${retired.length}`);
  if (reflections.length || notes.length) {
    const kinds = new Map<string, number>();
    for (const r of reflections) kinds.set(r.kind, (kinds.get(r.kind) ?? 0) + 1);
    parts.push(`journal : ${reflections.length} note(s)${kinds.size ? ` (${[...kinds].map(([k, n]) => `${k} ${n}`).join(", ")})` : ""}` + (notes.length ? ` ; tes notes : ${notes.length}` : ""));
  }
  const sources = [...made, ...resolved, ...decisions, ...orders, ...trades, ...added, ...retired, ...reflections, ...notes].map((r) => r.id);
  const unique = [...new Set(sources)];
  const shown = unique.slice(0, IDS_IN_TEXT);
  const content = `${LABEL[period](start, end)} (calculé par le code) : ${parts.join(" ; ")}.` +
    ` Sources : ${shown.join(", ")}${unique.length > shown.length ? ` et ${unique.length - shown.length} autre(s)` : ""}.`;
  return { content, sources: unique };
}

/** Writes the summaries of finished periods that have none yet; returns how many. Cheap: run it hourly. */
export function writeSummaries(db: DB, cfg: TraderConfig, now: Date = new Date()): number {
  const exists = db.prepare("SELECT 1 FROM trader_summaries WHERE period = ? AND start_day = ?");
  const insert = db.prepare("INSERT OR IGNORE INTO trader_summaries (period, start_day, end_day, content, sources, recorded_at) VALUES (?, ?, ?, ?, ?, ?)");
  let written = 0;
  for (const p of finishedPeriods(now)) {
    if (exists.get(p.period, p.start)) continue;
    const s = summarize(db, cfg, p.period, p.start, p.end);
    if (!s) continue;
    written += insert.run(p.period, p.start, p.end, s.content, JSON.stringify(s.sources), now.toISOString()).changes;
  }
  return written;
}

export function listSummaries(db: DB, period?: SummaryPeriod, limit = 20): Summary[] {
  return (db.prepare(`SELECT * FROM trader_summaries${period ? " WHERE period = ?" : ""} ORDER BY start_day DESC, period LIMIT ?`)
    .all(...(period ? [period, limit] : [limit])) as any[]).map((r) => ({
    period: r.period, start: r.start_day, end: r.end_day, content: r.content, sources: JSON.parse(r.sources), recordedAt: r.recorded_at,
  }));
}
