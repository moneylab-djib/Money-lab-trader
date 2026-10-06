/**
 * Sonni event calendar (docs/MEMORY.md section 3.1, step 2)
 *
 * Dated macro events that move markets, by UTC day:
 * - fomc: Federal Reserve rate decisions, read from the public FOMC
 *   calendar page (decision = last day of the meeting; notation votes and
 *   unscheduled meetings skipped). No key.
 * - cpi, jobs: US inflation and employment releases, from the FRED API
 *   (release 10 and 50) when the owner provides a free FRED_API_KEY.
 * Code only: no inference. Reactions are computed from daily candles.
 */

import type Database from "better-sqlite3";
import { loadDaily } from "./candles.js";

type DB = Database.Database;
type FetchFn = typeof fetch;

export const EVENT_TYPES = ["fomc", "cpi", "jobs"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const FOMC_CALENDAR_URL = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm";
export const FRED_RELEASE_DATES_URL = "https://api.stlouisfed.org/fred/release/dates";
const FRED_RELEASES: Record<Exclude<EventType, "fomc">, number> = { cpi: 10, jobs: 50 };
const FETCH_TIMEOUT_MS = 20_000;
/** Release dates are read from this day on (the daily history starts later). */
const FRED_FROM = "2023-01-01";

export const EVENT_LABEL_FR: Record<EventType, string> = {
  fomc: "décision de taux de la Fed",
  cpi: "inflation américaine (CPI)",
  jobs: "emploi américain",
};

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_ABBR = MONTHS.map((m) => m.slice(0, 3));

function monthIndex(name: string): number {
  const n = name.trim().toLowerCase();
  const full = MONTHS.indexOf(n);
  return full >= 0 ? full : MONTH_ABBR.indexOf(n.slice(0, 3));
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Decision days from the FOMC calendar page HTML. A meeting spans one or
 * two days ("27-28", "30-1" across "Apr/May"); the decision is announced
 * on the last day.
 */
export function parseFomcCalendar(html: string): string[] {
  const days: string[] = [];
  const parts = html.split(/(\d{4}) FOMC Meetings/);
  for (let i = 1; i < parts.length; i += 2) {
    const year = Number(parts[i]);
    const body = parts[i + 1] ?? "";
    const re = /fomc-meeting__month[^>]*>\s*<strong>([^<]+)<\/strong>[\s\S]*?fomc-meeting__date[^>]*>([^<]+)</g;
    for (const m of body.matchAll(re)) {
      const months = m[1].split("/").map(monthIndex);
      const text = m[2].trim();
      if (/notation|unscheduled|cancel/i.test(text) || months.some((x) => x < 0)) continue;
      const nums = text.replace(/\*/g, "").split("-").map((x) => Number(x.trim()));
      if (nums.some((x) => !Number.isInteger(x) || x < 1 || x > 31)) continue;
      const lastDay = nums.at(-1)!;
      // "30-1" with "Apr/May": the last day is in the second month.
      const month = months.length > 1 && nums.length > 1 && lastDay < nums[0] ? months[1] : months.at(-1)!;
      days.push(`${year}-${pad(month + 1)}-${pad(lastDay)}`);
    }
  }
  return [...new Set(days)].sort();
}

async function fetchText(url: string, fetchFn: FetchFn): Promise<string> {
  const resp = await fetchFn(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { "User-Agent": "Mozilla/5.0 (Sonni calendar)" } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.text();
}

async function fetchFredDates(releaseId: number, apiKey: string, fetchFn: FetchFn): Promise<string[]> {
  const url = `${FRED_RELEASE_DATES_URL}?release_id=${releaseId}&api_key=${encodeURIComponent(apiKey)}&file_type=json` +
    `&include_release_dates_with_no_data=true&realtime_start=${FRED_FROM}&sort_order=asc&limit=1000`;
  const resp = await fetchFn(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  // Never put the URL (it holds the key) in an error.
  if (!resp.ok) throw new Error(`FRED release ${releaseId}: HTTP ${resp.status}`);
  const data = (await resp.json()) as { release_dates?: { date?: string }[] };
  const days = (data.release_dates ?? []).map((d) => String(d.date ?? "")).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  return [...new Set(days)].sort();
}

/** Refresh the calendar. FOMC always; CPI and jobs only with a FRED key. */
export async function collectEvents(
  db: DB,
  fredApiKey: string | undefined,
  fetchFn: FetchFn = fetch,
): Promise<{ stored: number; errors: string[] }> {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO trader_events (type, day, source, recorded_at) VALUES (?, ?, ?, ?)",
  );
  const now = new Date().toISOString();
  let stored = 0;
  const errors: string[] = [];
  try {
    const days = parseFomcCalendar(await fetchText(FOMC_CALENDAR_URL, fetchFn));
    if (days.length === 0) throw new Error("no meeting found (page layout changed?)");
    for (const d of days) stored += insert.run("fomc", d, "federalreserve.gov", now).changes;
  } catch (err: any) {
    errors.push(`FOMC calendar: ${err?.message ?? err}`);
  }
  if (fredApiKey) {
    for (const [type, id] of Object.entries(FRED_RELEASES)) {
      try {
        for (const d of await fetchFredDates(id, fredApiKey, fetchFn)) stored += insert.run(type, d, "fred", now).changes;
      } catch (err: any) {
        errors.push(String(err?.message ?? err));
      }
    }
  }
  return { stored, errors };
}

/** Event days by type, for rule evaluation. */
export function eventDays(db: DB): Record<EventType, Set<string>> {
  const out = Object.fromEntries(EVENT_TYPES.map((t) => [t, new Set<string>()])) as Record<EventType, Set<string>>;
  for (const row of db.prepare("SELECT type, day FROM trader_events").all() as { type: EventType; day: string }[]) {
    out[row.type]?.add(row.day);
  }
  return out;
}

export function upcomingEvents(db: DB, from: Date, days: number): { type: EventType; day: string }[] {
  const start = from.toISOString().slice(0, 10);
  const end = new Date(from.getTime() + days * 86_400_000).toISOString().slice(0, 10);
  return db.prepare(
    "SELECT type, day FROM trader_events WHERE day >= ? AND day <= ? ORDER BY day ASC, type ASC",
  ).all(start, end) as { type: EventType; day: string }[];
}

export interface EventReaction {
  type: EventType;
  asset: string;
  past: number;
  meanAbsMove: number | null;
  meanAbsMoveAllDays: number | null;
  last: { day: string; move: number }[];
}

/**
 * How an asset moved on each type's event days (close of the day before
 * to close of the event day), against all days. Computed from daily
 * candles; a day-level view, since releases land at a given hour.
 */
export function eventReactions(db: DB, asset: string, now: Date = new Date()): EventReaction[] {
  const candles = loadDaily(db, asset);
  const moves = new Map<string, number>();
  for (let i = 1; i < candles.length; i++) {
    moves.set(candles[i].day, ((candles[i].close - candles[i - 1].close) / candles[i - 1].close) * 100);
  }
  const all = [...moves.values()].map(Math.abs);
  const meanAll = all.length ? all.reduce((a, b) => a + b, 0) / all.length : null;
  const today = now.toISOString().slice(0, 10);
  const days = eventDays(db);
  return EVENT_TYPES.filter((t) => days[t].size > 0).map((type) => {
    const past = [...days[type]].filter((d) => d < today && moves.has(d)).sort();
    const abs = past.map((d) => Math.abs(moves.get(d)!));
    return {
      type, asset, past: past.length,
      meanAbsMove: abs.length ? abs.reduce((a, b) => a + b, 0) / abs.length : null,
      meanAbsMoveAllDays: meanAll,
      last: past.slice(-3).map((d) => ({ day: d, move: moves.get(d)! })),
    };
  });
}
