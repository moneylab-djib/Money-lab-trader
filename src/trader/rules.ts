/**
 * Sonni test rules (docs/MEMORY.md section 4)
 *
 * A small, strictly validated JSON language in which a hypothesis states
 * what code can check on daily history: "when <conditions> on day t, then
 * <outcome> over the next days happens more often than usual" (or "most
 * of the time"). Code evaluates the rule on stored daily candles; the
 * model never computes or writes the result.
 */

import type { Candle } from "./candles.js";
import { EVENT_TYPES, type EventType } from "./events.js";

export const OPS = [">", ">=", "<", "<="] as const;
export type Op = (typeof OPS)[number];
export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export const CLAIMS = ["more_often_than_usual", "most_of_the_time"] as const;
export type Claim = (typeof CLAIMS)[number];

export type Condition =
  | { kind: "return"; asset: string; days: number; op: Op; value: number }
  | { kind: "range"; asset: string; op: Op; value: number }
  | { kind: "streak"; asset: string; direction: "up" | "down"; days: number }
  | { kind: "weekday"; days: (typeof WEEKDAYS)[number][] }
  | { kind: "volume_ratio"; asset: string; op: Op; value: number }
  | { kind: "event"; types: EventType[]; offset: number };

export type Outcome =
  | { kind: "forward_return"; asset: string; days: number; op: Op; value: number }
  | { kind: "abs_forward_return"; asset: string; days: number; op: Op; value: number }
  | { kind: "relative_forward_return"; asset: string; versus: string; days: number; op: Op; value: number };

export interface TestRule {
  claim: Claim;
  when: Condition[];
  then: Outcome;
}

/** Short description of the language, shared with the tool definition. */
export const RULE_LANGUAGE = `test_rule = {"claim": "more_often_than_usual" | "most_of_the_time", "when": [0 to 3 conditions, all must hold on day t], "then": outcome}.
Percent values; op is one of ">", ">=", "<", "<="; days 1 to 30 unless noted; day t is a UTC daily candle.
Conditions:
- {"kind":"return","asset":"BTC","days":1,"op":"<=","value":-3}: close(t) vs close(t-days), in %
- {"kind":"range","asset":"BTC","op":">=","value":6}: (high-low)/open of day t, in %
- {"kind":"streak","asset":"BTC","direction":"down","days":3}: the last N daily returns all down (or up), N 2 to 10
- {"kind":"weekday","days":["mon","fri"]}: weekday of day t (sun..sat)
- {"kind":"volume_ratio","asset":"BTC","op":">=","value":2}: volume of day t / average of the 20 previous days
- {"kind":"event","types":["fomc","cpi","jobs"],"offset":1}: day t+offset is an event day (fomc = Fed rate decision,
  cpi = US inflation, jobs = US employment report; offset -3 to 3). With offset 1 and a 1-day outcome, the outcome
  measures the event day's own move. One event type alone gives few cases over two years: combine types.
Outcomes (from close of day t to close of day t+days):
- {"kind":"forward_return","asset":"BTC","days":1,"op":">","value":0}
- {"kind":"abs_forward_return","asset":"ETH","days":1,"op":">=","value":3}: size of the move, either direction
- {"kind":"relative_forward_return","asset":"ETH","versus":"BTC","days":7,"op":">","value":0}: ETH return minus BTC return
"more_often_than_usual" compares the outcome's frequency after the conditions with its frequency on all days; "most_of_the_time" checks that it happens in more than half of the cases.`;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(obj: Record<string, unknown>, keys: string[], where: string): void {
  for (const k of Object.keys(obj)) if (!keys.includes(k)) throw new Error(`${where}: unknown key "${k}"`);
  for (const k of keys) if (!(k in obj)) throw new Error(`${where}: missing key "${k}"`);
}

function intIn(v: unknown, min: number, max: number, where: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new Error(`${where} must be an integer from ${min} to ${max}`);
  return v;
}

function num(v: unknown, where: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > 1000) throw new Error(`${where} must be a number (percent)`);
  return v;
}

function op(v: unknown, where: string): Op {
  if (!OPS.includes(v as Op)) throw new Error(`${where} must be one of ${OPS.join(" ")}`);
  return v as Op;
}

/**
 * Validate a raw rule against the followed assets. Throws an Error whose
 * message says what is wrong, so the model can correct it.
 */
export function parseTestRule(raw: unknown, assets: string[]): TestRule {
  if (!isObject(raw)) throw new Error("test_rule must be an object");
  onlyKeys(raw, ["claim", "when", "then"], "test_rule");
  if (!CLAIMS.includes(raw.claim as Claim)) throw new Error(`test_rule.claim must be ${CLAIMS.join(" or ")}`);
  const asset = (v: unknown, where: string) => {
    if (typeof v !== "string" || !assets.includes(v)) throw new Error(`${where} must be one of ${assets.join(", ")}`);
    return v;
  };
  if (!Array.isArray(raw.when) || raw.when.length > 3) throw new Error("test_rule.when must be an array of 0 to 3 conditions");
  const when = raw.when.map((c, i): Condition => {
    const w = `test_rule.when[${i}]`;
    if (!isObject(c)) throw new Error(`${w} must be an object`);
    switch (c.kind) {
      case "return":
        onlyKeys(c, ["kind", "asset", "days", "op", "value"], w);
        return { kind: "return", asset: asset(c.asset, `${w}.asset`), days: intIn(c.days, 1, 30, `${w}.days`), op: op(c.op, `${w}.op`), value: num(c.value, `${w}.value`) };
      case "range":
        onlyKeys(c, ["kind", "asset", "op", "value"], w);
        return { kind: "range", asset: asset(c.asset, `${w}.asset`), op: op(c.op, `${w}.op`), value: num(c.value, `${w}.value`) };
      case "streak":
        onlyKeys(c, ["kind", "asset", "direction", "days"], w);
        if (c.direction !== "up" && c.direction !== "down") throw new Error(`${w}.direction must be "up" or "down"`);
        return { kind: "streak", asset: asset(c.asset, `${w}.asset`), direction: c.direction, days: intIn(c.days, 2, 10, `${w}.days`) };
      case "weekday": {
        onlyKeys(c, ["kind", "days"], w);
        if (!Array.isArray(c.days) || c.days.length === 0 || c.days.some((d) => !WEEKDAYS.includes(d as any))) {
          throw new Error(`${w}.days must list weekdays among ${WEEKDAYS.join(", ")}`);
        }
        return { kind: "weekday", days: [...new Set(c.days)] as (typeof WEEKDAYS)[number][] };
      }
      case "volume_ratio":
        onlyKeys(c, ["kind", "asset", "op", "value"], w);
        return { kind: "volume_ratio", asset: asset(c.asset, `${w}.asset`), op: op(c.op, `${w}.op`), value: num(c.value, `${w}.value`) };
      case "event": {
        onlyKeys(c, ["kind", "types", "offset"], w);
        if (!Array.isArray(c.types) || c.types.length === 0 || c.types.some((t) => !EVENT_TYPES.includes(t as EventType))) {
          throw new Error(`${w}.types must list event types among ${EVENT_TYPES.join(", ")}`);
        }
        return { kind: "event", types: [...new Set(c.types)] as EventType[], offset: intIn(c.offset, -3, 3, `${w}.offset`) };
      }
      default:
        throw new Error(`${w}.kind must be return, range, streak, weekday, volume_ratio or event`);
    }
  });
  const t = raw.then;
  const w = "test_rule.then";
  if (!isObject(t)) throw new Error(`${w} must be an object`);
  let then: Outcome;
  switch (t.kind) {
    case "forward_return":
    case "abs_forward_return":
      onlyKeys(t, ["kind", "asset", "days", "op", "value"], w);
      then = { kind: t.kind, asset: asset(t.asset, `${w}.asset`), days: intIn(t.days, 1, 30, `${w}.days`), op: op(t.op, `${w}.op`), value: num(t.value, `${w}.value`) };
      break;
    case "relative_forward_return": {
      onlyKeys(t, ["kind", "asset", "versus", "days", "op", "value"], w);
      const a = asset(t.asset, `${w}.asset`);
      const v = asset(t.versus, `${w}.versus`);
      if (a === v) throw new Error(`${w}.versus must differ from asset`);
      then = { kind: "relative_forward_return", asset: a, versus: v, days: intIn(t.days, 1, 30, `${w}.days`), op: op(t.op, `${w}.op`), value: num(t.value, `${w}.value`) };
      break;
    }
    default:
      throw new Error(`${w}.kind must be forward_return, abs_forward_return or relative_forward_return`);
  }
  return { claim: raw.claim as Claim, when, then };
}

function compare(a: number, o: Op, b: number): boolean {
  return o === ">" ? a > b : o === ">=" ? a >= b : o === "<" ? a < b : a <= b;
}

/** Daily series of several assets aligned on the calendar days they all share. */
interface Series {
  days: string[];
  byAsset: Record<string, Candle[]>;
}

function align(candles: Record<string, Candle[]>, assets: string[]): Series {
  const maps = assets.map((a) => new Map((candles[a] ?? []).map((c) => [c.day, c])));
  const days = [...(maps[0]?.keys() ?? [])].filter((d) => maps.every((m) => m.has(d))).sort();
  const byAsset: Record<string, Candle[]> = {};
  assets.forEach((a, i) => { byAsset[a] = days.map((d) => maps[i].get(d)!); });
  return { days, byAsset };
}

const pct = (from: number, to: number) => ((to - from) / from) * 100;

/** Event days by type (from the stored calendar). */
export type EventCalendar = Partial<Record<EventType, Set<string>>>;

function shiftDay(day: string, offset: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
}

/** Value of a condition on day index t, or null when history is too short. */
function conditionHolds(c: Condition, s: Series, t: number, events: EventCalendar): boolean | null {
  switch (c.kind) {
    case "return": {
      const x = s.byAsset[c.asset];
      if (t - c.days < 0) return null;
      return compare(pct(x[t - c.days].close, x[t].close), c.op, c.value);
    }
    case "range": {
      const d = s.byAsset[c.asset][t];
      return compare(((d.high - d.low) / d.open) * 100, c.op, c.value);
    }
    case "streak": {
      const x = s.byAsset[c.asset];
      if (t - c.days < 0) return null;
      for (let k = t - c.days + 1; k <= t; k++) {
        const up = x[k].close > x[k - 1].close;
        const down = x[k].close < x[k - 1].close;
        if (c.direction === "up" ? !up : !down) return false;
      }
      return true;
    }
    case "weekday":
      return c.days.includes(WEEKDAYS[new Date(`${s.days[t]}T00:00:00Z`).getUTCDay()]);
    case "volume_ratio": {
      const x = s.byAsset[c.asset];
      if (t < 20) return null;
      let sum = 0;
      for (let k = t - 20; k < t; k++) sum += x[k].volume;
      const avg = sum / 20;
      if (avg <= 0) return null;
      return compare(x[t].volume / avg, c.op, c.value);
    }
    case "event": {
      const day = shiftDay(s.days[t], c.offset);
      return c.types.some((type) => events[type]?.has(day) ?? false);
    }
  }
}

/** Value of the outcome from day t, or null when the future is not in the data yet. */
function outcomeHolds(o: Outcome, s: Series, t: number): boolean | null {
  if (t + o.days >= s.days.length) return null;
  const ret = (asset: string) => pct(s.byAsset[asset][t].close, s.byAsset[asset][t + o.days].close);
  switch (o.kind) {
    case "forward_return":
      return compare(ret(o.asset), o.op, o.value);
    case "abs_forward_return":
      return compare(Math.abs(ret(o.asset)), o.op, o.value);
    case "relative_forward_return":
      return compare(ret(o.asset) - ret(o.versus), o.op, o.value);
  }
}

export type HistoricalVerdict = "supported" | "refuted" | "inconclusive" | "insufficient";

export interface RuleStats {
  dataFrom: string | null;
  dataTo: string | null;
  cases: number;
  hits: number;
  rate: number | null;
  baseCases: number | null;
  baseRate: number | null;
  z: number | null;
  verdict: HistoricalVerdict;
}

/** Fewer cases than this cannot support or refute anything. */
export const MIN_CASES = 30;
/** One-sided z threshold (about 1 % chance of passing by luck). */
export const SUPPORT_Z = 2.33;

export function rulesAssets(rule: TestRule): string[] {
  const set = new Set<string>();
  for (const c of rule.when) if ("asset" in c) set.add(c.asset);
  set.add(rule.then.asset);
  if (rule.then.kind === "relative_forward_return") set.add(rule.then.versus);
  return [...set];
}

/**
 * Evaluate a rule on daily candles. The outcome's frequency after the
 * conditions is compared with its frequency on every day (or with 50 %),
 * using a one-sided z score on the proportion.
 */
export function evaluateRule(rule: TestRule, candles: Record<string, Candle[]>, events: EventCalendar = {}): RuleStats {
  const s = align(candles, rulesAssets(rule));
  let cases = 0, hits = 0, baseCases = 0, baseHits = 0;
  for (let t = 1; t < s.days.length; t++) {
    const outcome = outcomeHolds(rule.then, s, t);
    if (outcome === null) continue;
    baseCases++;
    if (outcome) baseHits++;
    let all = true;
    for (const c of rule.when) {
      const holds = conditionHolds(c, s, t, events);
      if (holds !== true) { all = false; break; }
    }
    if (!all) continue;
    cases++;
    if (outcome) hits++;
  }
  const dataFrom = s.days[0] ?? null;
  const dataTo = s.days.at(-1) ?? null;
  const rate = cases > 0 ? hits / cases : null;
  const p0 = rule.claim === "most_of_the_time" ? 0.5 : baseCases > 0 ? baseHits / baseCases : null;
  let z: number | null = null;
  if (rate !== null && p0 !== null && p0 > 0 && p0 < 1) z = (rate - p0) / Math.sqrt((p0 * (1 - p0)) / cases);
  let verdict: HistoricalVerdict;
  if (cases < MIN_CASES || p0 === null) verdict = "insufficient";
  else if (z === null) verdict = rate! > p0 ? "supported" : "refuted";
  else if (z >= SUPPORT_Z) verdict = "supported";
  else if (z <= 0) verdict = "refuted";
  else verdict = "inconclusive";
  return {
    dataFrom, dataTo, cases, hits, rate,
    baseCases: rule.claim === "most_of_the_time" ? null : baseCases,
    baseRate: p0, z, verdict,
  };
}
