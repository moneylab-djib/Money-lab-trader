/**
 * Cycles (step C2): how prices react around the dated events code knows
 * (Fed decisions, US inflation and jobs releases), measured once per
 * event, asset and window from the stored candles and 5-minute prices,
 * and the cycles the model names on top of them (name_pattern), whose
 * statistics code computes with the same z score as the hypotheses.
 * Nothing here is written by the model except a cycle's name, note and
 * claim; the numbers are code's.
 */

import type Database from "better-sqlite3";
import { ulid } from "ulid";
import { containsInjectionPatterns } from "../soul/validator.js";
import { loadDaily } from "./candles.js";
import type { TraderConfig } from "./config.js";
import { EVENT_LABEL_FR, EVENT_TYPES, type EventType } from "./events.js";
import { fmtDay } from "./format.js";
import { priceAtOrAfter, priceAtOrBefore } from "./prices.js";
import { SUPPORT_Z } from "./rules.js";
import type { SoulResult } from "./soul.js";
import { activeAssets } from "./universe.js";

type DB = Database.Database;

/** Windows measured around an event day d: close d-2 → close d-1 (run-up), close d-1 → close d, close d-1 → first close at or after d+7, and the first hour after the release. */
export const WINDOWS = ["run_up", "day", "week", "hour"] as const;
export type Window = (typeof WINDOWS)[number];
export const DIRECTIONS = ["up", "down", "big_move"] as const;
export type Direction = (typeof DIRECTIONS)[number];
/** Release times (UTC) for the first-hour window. */
export const RELEASE_UTC: Record<EventType, { h: number; m: number }> = { fomc: { h: 18, m: 0 }, cpi: { h: 12, m: 30 }, jobs: { h: 12, m: 30 } };
/** Events are rare (8 to 12 a year): fewer cases than the hypotheses' 30 count, said so in the verdict. */
export const MIN_PATTERN_CASES = 10;
export const MAX_PATTERNS = 30;
export const DEFAULT_BIG_MOVE_PCT = 2;
const HOUR_TOLERANCE_MIN = 20;

export const WINDOW_LABEL_FR: Record<Window, string> = { run_up: "la veille", day: "le jour", week: "la semaine", hour: "la première heure" };
export const WINDOW_LABEL_EN: Record<Window, string> = { run_up: "day before", day: "event day", week: "week after", hour: "first hour" };
export const DIRECTION_LABEL_FR: Record<Direction, string> = { up: "hausse", down: "baisse", big_move: "grand mouvement" };

export interface Reaction { type: EventType; day: string; asset: string; window: Window; returnPct: number }

export interface Pattern {
  id: string;
  name: string;
  eventType: EventType;
  asset: string;
  window: Window;
  direction: Direction;
  thresholdPct: number | null;
  note: string;
  recordedAt: string;
}

export interface WindowStats {
  window: Window;
  n: number;
  mean: number | null;
  meanAbs: number | null;
  upShare: number | null;
  /** Share of up moves and mean absolute move over all days of the same window length, for comparison. */
  baseUpShare: number | null;
  baseMeanAbs: number | null;
  last: { day: string; returnPct: number }[];
}

export interface PatternStats {
  cases: number;
  hits: number;
  rate: number | null;
  baseRate: number | null;
  z: number | null;
  verdict: "supported" | "refuted" | "inconclusive" | "insufficient";
}

const pct = (from: number, to: number) => ((to - from) / from) * 100;

// ─── Measuring reactions ────────────────────────────────────────

function candleReturns(candles: { day: string; close: number }[], window: Exclude<Window, "hour">): Map<string, number> {
  const out = new Map<string, number>();
  const byDay = new Map(candles.map((c) => [c.day, c.close]));
  const days = candles.map((c) => c.day);
  for (let i = 1; i < candles.length; i++) {
    const d = candles[i].day;
    const prev = candles[i - 1].close;
    if (window === "day") out.set(d, pct(prev, candles[i].close));
    else if (window === "run_up") {
      if (i >= 2) out.set(d, pct(candles[i - 2].close, prev));
    } else {
      const target = new Date(Date.parse(d) + 7 * 86_400_000).toISOString().slice(0, 10);
      const after = days.find((x) => x >= target);
      if (after && byDay.has(after)) out.set(d, pct(prev, byDay.get(after)!));
    }
  }
  return out;
}

function hourReturn(db: DB, type: EventType, day: string, asset: string): number | null {
  const { h, m } = RELEASE_UTC[type];
  const release = new Date(`${day}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`);
  const before = priceAtOrBefore(db, asset, release.toISOString());
  if (!before || release.getTime() - Date.parse(before.ts) > HOUR_TOLERANCE_MIN * 60_000) return null;
  const target = new Date(release.getTime() + 3_600_000);
  const after = priceAtOrAfter(db, asset, target.toISOString(), new Date(target.getTime() + HOUR_TOLERANCE_MIN * 60_000).toISOString());
  if (!after) return null;
  return pct(before.price, after.price);
}

/**
 * Measures the missing reactions for past events of every followed
 * asset; each (event, asset, window) is written once. Returns how many
 * rows were added. Called after the daily history and the calendar.
 */
export function reactionsTick(db: DB, cfg: TraderConfig, now: Date = new Date()): number {
  const today = now.toISOString().slice(0, 10);
  const events = db.prepare("SELECT type, day FROM trader_events WHERE day < ? ORDER BY day ASC").all(today) as { type: EventType; day: string }[];
  if (events.length === 0) return 0;
  const insert = db.prepare("INSERT OR IGNORE INTO trader_reactions (type, day, asset, window, return_pct, computed_at) VALUES (?, ?, ?, ?, ?, ?)");
  const exists = db.prepare("SELECT 1 FROM trader_reactions WHERE type = ? AND day = ? AND asset = ? AND window = ?");
  let added = 0;
  for (const a of activeAssets(db, cfg)) {
    const candles = loadDaily(db, a.symbol);
    const returns = { run_up: candleReturns(candles, "run_up"), day: candleReturns(candles, "day"), week: candleReturns(candles, "week") };
    for (const e of events) {
      for (const w of WINDOWS) {
        if (exists.get(e.type, e.day, a.symbol, w)) continue;
        const r = w === "hour" ? hourReturn(db, e.type, e.day, a.symbol) : returns[w].get(e.day) ?? null;
        if (r === null || !Number.isFinite(r)) continue;
        added += insert.run(e.type, e.day, a.symbol, w, Math.round(r * 100) / 100, now.toISOString()).changes;
      }
    }
  }
  return added;
}

export function listReactions(db: DB, type: EventType, asset: string, window: Window): Reaction[] {
  return (db.prepare("SELECT type, day, asset, window, return_pct AS returnPct FROM trader_reactions WHERE type = ? AND asset = ? AND window = ? ORDER BY day ASC")
    .all(type, asset, window) as Reaction[]);
}

export function windowStats(db: DB, type: EventType, asset: string, window: Window): WindowStats {
  const rows = listReactions(db, type, asset, window);
  const values = rows.map((r) => r.returnPct);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  let baseUpShare: number | null = null;
  let baseMeanAbs: number | null = null;
  if (window !== "hour") {
    const all = [...candleReturns(loadDaily(db, asset), window).values()];
    if (all.length) {
      baseUpShare = all.filter((x) => x > 0).length / all.length;
      baseMeanAbs = mean(all.map(Math.abs));
    }
  }
  return {
    window, n: rows.length, mean: mean(values), meanAbs: mean(values.map(Math.abs)),
    upShare: rows.length ? values.filter((x) => x > 0).length / rows.length : null,
    baseUpShare, baseMeanAbs, last: rows.slice(-3).map((r) => ({ day: r.day, returnPct: r.returnPct })),
  };
}

/** Event types with at least one measured reaction, with every window per followed asset. */
export function cycleTable(db: DB, cfg: TraderConfig): { type: EventType; cases: number; assets: { asset: string; windows: WindowStats[] }[] }[] {
  const out: { type: EventType; cases: number; assets: { asset: string; windows: WindowStats[] }[] }[] = [];
  for (const type of EVENT_TYPES) {
    const cases = (db.prepare("SELECT COUNT(DISTINCT day) AS n FROM trader_reactions WHERE type = ?").get(type) as { n: number }).n;
    if (cases === 0) continue;
    out.push({ type, cases, assets: activeAssets(db, cfg).map((a) => ({ asset: a.symbol, windows: WINDOWS.map((w) => windowStats(db, type, a.symbol, w)) })) });
  }
  return out;
}

// ─── Named cycles (patterns) ────────────────────────────────────

function rowToPattern(row: any): Pattern {
  return { id: row.id, name: row.name, eventType: row.event_type, asset: row.asset, window: row.window, direction: row.direction, thresholdPct: row.threshold_pct, note: row.note, recordedAt: row.recorded_at };
}

export function listPatterns(db: DB): Pattern[] {
  return (db.prepare("SELECT * FROM trader_patterns ORDER BY recorded_at ASC").all() as any[]).map(rowToPattern);
}

export function namePattern(
  db: DB,
  cfg: TraderConfig,
  input: { name: unknown; eventType: unknown; asset: unknown; window: unknown; direction: unknown; thresholdPct?: unknown; note: unknown },
  now: Date = new Date(),
): SoulResult<{ pattern: Pattern; stats: PatternStats }> {
  const name = String(input.name ?? "").replace(/\s+/g, " ").trim();
  if (name.length < 3 || name.length > 60 || containsInjectionPatterns(name)) return { ok: false, error: "name must be 3 to 60 plain characters." };
  const eventType = String(input.eventType ?? "") as EventType;
  if (!EVENT_TYPES.includes(eventType)) return { ok: false, error: `event_type must be one of ${EVENT_TYPES.join(", ")}.` };
  const asset = String(input.asset ?? "").toUpperCase().trim();
  const followed = activeAssets(db, cfg).map((a) => a.symbol);
  if (!followed.includes(asset)) return { ok: false, error: `Unknown asset ${asset || "(none)"}: you follow ${followed.join(", ")}.` };
  const window = String(input.window ?? "") as Window;
  if (!WINDOWS.includes(window)) return { ok: false, error: `window must be one of ${WINDOWS.join(", ")}.` };
  const direction = String(input.direction ?? "") as Direction;
  if (!DIRECTIONS.includes(direction)) return { ok: false, error: `direction must be one of ${DIRECTIONS.join(", ")}.` };
  let threshold: number | null = null;
  if (direction === "big_move") {
    threshold = input.thresholdPct === undefined || input.thresholdPct === null ? DEFAULT_BIG_MOVE_PCT : Number(input.thresholdPct);
    if (!Number.isFinite(threshold) || threshold < 0.1 || threshold > 50) return { ok: false, error: "threshold_pct must be between 0.1 and 50 (percent)." };
  }
  const note = String(input.note ?? "").replace(/\s+/g, " ").trim();
  if (note.length < 10 || note.length > 300 || containsInjectionPatterns(note)) return { ok: false, error: "note must be 10 to 300 plain characters (why this cycle would exist)." };
  if (db.prepare("SELECT 1 FROM trader_patterns WHERE lower(name) = lower(?)").get(name)) return { ok: false, error: `A cycle named "${name}" exists.` };
  if (listPatterns(db).length >= MAX_PATTERNS) return { ok: false, error: `Already ${MAX_PATTERNS} named cycles.` };
  const id = `cy_${ulid()}`;
  db.prepare(
    "INSERT INTO trader_patterns (id, name, event_type, asset, window, direction, threshold_pct, note, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, name, eventType, asset, window, direction, threshold, note, now.toISOString());
  const pattern = rowToPattern(db.prepare("SELECT * FROM trader_patterns WHERE id = ?").get(id));
  return { ok: true, value: { pattern, stats: patternStats(db, pattern) } };
}

/** Cases, hits, base rate and verdict, computed from the measured reactions; never written by the model. */
export function patternStats(db: DB, p: Pattern): PatternStats {
  const values = listReactions(db, p.eventType, p.asset, p.window).map((r) => r.returnPct);
  const hit = (x: number) => (p.direction === "up" ? x > 0 : p.direction === "down" ? x < 0 : Math.abs(x) >= (p.thresholdPct ?? DEFAULT_BIG_MOVE_PCT));
  const cases = values.length;
  const hits = values.filter(hit).length;
  const rate = cases ? hits / cases : null;
  let baseRate: number | null = null;
  if (p.window === "hour") {
    baseRate = p.direction === "big_move" ? null : 0.5;
  } else {
    const all = [...candleReturns(loadDaily(db, p.asset), p.window).values()];
    if (all.length) baseRate = all.filter(hit).length / all.length;
  }
  let z: number | null = null;
  if (rate !== null && baseRate !== null && baseRate > 0 && baseRate < 1) z = (rate - baseRate) / Math.sqrt((baseRate * (1 - baseRate)) / cases);
  let verdict: PatternStats["verdict"];
  if (cases < MIN_PATTERN_CASES || baseRate === null) verdict = "insufficient";
  else if (z !== null && z >= SUPPORT_Z) verdict = "supported";
  else if (z !== null && z <= 0) verdict = "refuted";
  else verdict = "inconclusive";
  return { cases, hits, rate, baseRate, z, verdict };
}

export function describePatternStats(s: PatternStats): string {
  const r = s.rate === null ? "n/a" : `${Math.round(s.rate * 100)} %`;
  const b = s.baseRate === null ? "no base rate" : `${Math.round(s.baseRate * 100)} % on all days`;
  return `${s.hits}/${s.cases} = ${r} vs ${b}${s.z === null ? "" : `, z=${s.z.toFixed(2)}`} -> ${s.verdict.toUpperCase()}${s.cases < MIN_PATTERN_CASES ? ` (fewer than ${MIN_PATTERN_CASES} cases)` : ""}`;
}

// ─── Views ──────────────────────────────────────────────────────

const signed = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)} %`;
const signedFr = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2).replace(".", ",")} %`;

/** For the model's pack: measured windows per event type and asset, then its named cycles with code's verdicts. */
export function describeCycles(db: DB, cfg: TraderConfig, types: EventType[] | null): string[] {
  const lines: string[] = [];
  for (const t of cycleTable(db, cfg)) {
    if (types && !types.includes(t.type)) continue;
    for (const a of t.assets) {
      const parts = a.windows.filter((w) => w.n > 0).map((w) =>
        `${WINDOW_LABEL_EN[w.window]} ${signed(w.mean!)} mean, ${Math.round(w.upShare! * 100)} % up (n=${w.n}${w.baseUpShare !== null ? `; all days ${Math.round(w.baseUpShare * 100)} % up, |move| ${w.baseMeanAbs!.toFixed(2)} % vs ${w.meanAbs!.toFixed(2)} %` : ""})`);
      if (parts.length) lines.push(`- ${t.type} x ${a.asset} (${t.cases} events): ${parts.join("; ")}`);
    }
  }
  const patterns = listPatterns(db).filter((p) => !types || types.includes(p.eventType));
  for (const p of patterns) lines.push(`- Your cycle « ${p.name} » (${p.eventType}, ${p.asset}, ${WINDOW_LABEL_EN[p.window]}, ${p.direction}${p.thresholdPct !== null ? ` ≥ ${p.thresholdPct} %` : ""}): ${describePatternStats(patternStats(db, p))}`);
  return lines;
}

/** /cycles for the owner. */
export function formatCyclesFr(db: DB, cfg: TraderConfig): string {
  const table = cycleTable(db, cfg);
  const patterns = listPatterns(db);
  if (table.length === 0 && patterns.length === 0) {
    return "🔁 Cycles : aucune réaction mesurée encore. Le code mesure, pour chaque décision de la Fed et chaque chiffre d'inflation ou d'emploi passé, comment chaque actif a bougé la veille, le jour, la semaine et la première heure (dès que l'historique et le calendrier sont là).";
  }
  const out = ["🔁 Cycles mesurés par le code (réactions aux événements, en %) :"];
  for (const t of table) {
    out.push(`${EVENT_LABEL_FR[t.type]} — ${t.cases} cas :`);
    for (const a of t.assets) {
      const parts = a.windows.filter((w) => w.n > 0).map((w) =>
        `${WINDOW_LABEL_FR[w.window]} ${signedFr(w.mean!)} en moyenne (${Math.round(w.upShare! * 100)} % de hausses sur ${w.n}` +
        `${w.baseUpShare !== null ? ` ; jours ordinaires ${Math.round(w.baseUpShare * 100)} %` : ""})`);
      if (parts.length) out.push(`- ${a.asset} : ${parts.join(" · ")}${a.windows.find((w) => w.window === "day")?.last.length ? ` · derniers : ${a.windows.find((w) => w.window === "day")!.last.map((l) => `${fmtDay(l.day)} ${signedFr(l.returnPct)}`).join(", ")}` : ""}`);
    }
  }
  if (patterns.length) {
    out.push("", "Cycles nommés par Sonni (chiffres calculés par le code) :");
    const verdictFr = { supported: "confirmé", refuted: "contredit", inconclusive: "peu concluant", insufficient: "pas assez de cas" };
    for (const p of patterns) {
      const s = patternStats(db, p);
      out.push(`- « ${p.name} » (${EVENT_LABEL_FR[p.eventType]}, ${p.asset}, ${WINDOW_LABEL_FR[p.window]}, ${DIRECTION_LABEL_FR[p.direction]}${p.thresholdPct !== null ? ` ≥ ${String(p.thresholdPct).replace(".", ",")} %` : ""}) : ` +
        `${s.hits} sur ${s.cases}${s.rate !== null ? ` (${Math.round(s.rate * 100)} %)` : ""}${s.baseRate !== null ? `, jours ordinaires ${Math.round(s.baseRate * 100)} %` : ""}${s.z !== null ? `, z ${s.z.toFixed(2).replace(".", ",")}` : ""} → ${verdictFr[s.verdict]}. ${p.note}`);
    }
  }
  return out.join("\n");
}
