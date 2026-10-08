/**
 * Step 2 of the 2026-10-08 plan: the owner's core assets (gold, the dollar, tokenized US stocks besides
 * BTC and ETH), USD prices converted to EUR, satellites Sonni rotates under code's rules, the owner's
 * veto, and the weekly screen. Fake Kraken only: no network, no inference.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createDatabase } from "../../state/database.js";
import { ensureMoneyLabSchema, setKV } from "../../money-lab/journal.js";
import type { AutomatonDatabase } from "../../types.js";
import { parseTraderConfig, type TraderConfig } from "../../trader/config.js";
import { ensureTraderSchema } from "../../trader/schema.js";
import { collectPrices, latestPrice } from "../../trader/prices.js";
import { collectCandles, loadDaily } from "../../trader/candles.js";
import { isTokenizedPair, latestFx, pairQuery, quoteOf } from "../../trader/markets.js";
import { activeAssets, followAsset, MAX_SATELLITES, ownerVeto, unfollowAsset } from "../../trader/universe.js";
import { formatScreenFr, latestScreen, runScreen, screenDue, screenPackLines } from "../../trader/screen.js";
import { buildMemoryPack } from "../../trader/pack.js";
import { runSonniCommand } from "../../trader/cli.js";

const EXAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "..", "sonni", "automaton.sonni.example.json"), "utf-8"));
const TRADER: TraderConfig = parseTraderConfig(EXAMPLE.trader)!;
const T0 = new Date("2026-10-08T08:00:00Z");
const days = (n: number) => new Date(T0.getTime() + n * 86_400_000);
const REASON = "un moteur différent de ceux que je suis déjà";

let tmpDirs: string[] = [];
function openDb(): AutomatonDatabase {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sonni-universe-"));
  tmpDirs.push(dir);
  const db = createDatabase(path.join(dir, "state.db"));
  ensureMoneyLabSchema(db.raw);
  ensureTraderSchema(db.raw);
  return db;
}
beforeEach(() => { tmpDirs = []; });
afterEach(() => { for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true }); });

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

/** Daily candles: a deterministic walk per pair; `weekendsFlat` gives volume 0 on Saturdays and Sundays. */
function ohlcRows(seed: number, n = 200, start = 100, weekendsFlat = false): unknown[][] {
  const rows: unknown[][] = [];
  let close = start;
  const t0 = Math.floor(T0.getTime() / 86_400_000) * 86_400 - (n + 1) * 86_400;
  for (let i = 0; i < n; i++) {
    const t = t0 + i * 86_400;
    const weekend = [0, 6].includes(new Date(t * 1000).getUTCDay());
    const r = Math.sin(i * seed) * 0.02;
    if (!(weekendsFlat && weekend)) close = close * (1 + r);
    rows.push([t, String(close), String(close), String(close), String(close), "0", weekendsFlat && weekend ? "0" : "100", 1]);
  }
  rows.push([t0 + n * 86_400, "1", "1", "1", "1", "0", "1", 1]);
  return rows;
}

/** A fake Kraken that refuses tokenized pairs without their asset class, like the real one. */
function fakeKraken(opts: { volumes?: Record<string, number>; seeds?: Record<string, number> } = {}) {
  const calls: URL[] = [];
  const fn = vi.fn(async (input: any) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.host !== "api.kraken.com") throw new Error(`unexpected host ${url.host}`);
    const pairParam = url.searchParams.get("pair") ?? "";
    const tokenizedClass = url.searchParams.get("asset_class") === "tokenized_asset";
    if (url.pathname === "/0/public/AssetPairs") {
      if (url.searchParams.get("aclass_base") === "tokenized_asset") {
        return json({ error: [], result: {
          NVDAxUSD: { altname: "NVDAxUSD", wsname: "NVDAx/USD", quote: "USD", status: "online" },
          SPYxUSD: { altname: "SPYxUSD", wsname: "SPYx/USD", quote: "USD", status: "online" },
          AAPLxUSD: { altname: "AAPLxUSD", wsname: "AAPLx/USD", quote: "USD", status: "online" },
        } });
      }
      return json({ error: [], result: {
        XXBTZEUR: { altname: "XBTEUR", wsname: "XBT/EUR", quote: "ZEUR", status: "online" },
        XETHZEUR: { altname: "ETHEUR", wsname: "ETH/EUR", quote: "ZEUR", status: "online" },
        PAXGEUR: { altname: "PAXGEUR", wsname: "PAXG/EUR", quote: "ZEUR", status: "online" },
        USDCEUR: { altname: "USDCEUR", wsname: "USDC/EUR", quote: "ZEUR", status: "online" },
        SOLEUR: { altname: "SOLEUR", wsname: "SOL/EUR", quote: "ZEUR", status: "online" },
        HYPEEUR: { altname: "HYPEEUR", wsname: "HYPE/EUR", quote: "ZEUR", status: "online" },
        DUSTEUR: { altname: "DUSTEUR", wsname: "DUST/EUR", quote: "ZEUR", status: "online" },
        EURCEUR: { altname: "EURCEUR", wsname: "EURC/EUR", quote: "ZEUR", status: "online" },
      } });
    }
    const pairs = pairParam.split(",");
    if (pairs.some((p) => isTokenizedPair(p)) && !tokenizedClass) return json({ error: ["EQuery:Unknown asset pair"] });
    if (url.pathname === "/0/public/Ticker") {
      const result: Record<string, unknown> = {};
      for (const p of pairs) {
        if (p === "EURUSD") { result.ZEURZUSD = { c: ["1.25", "1"], v: ["0", "1"], p: ["0", "1.25"] }; continue; }
        const last = p.endsWith("USD") ? 250 : 100;
        result[p] = { c: [String(last), "1"], v: ["0", "1"], p: ["0", String(opts.volumes?.[p] ?? 5_000_000)] };
      }
      return json({ error: [], result });
    }
    if (url.pathname === "/0/public/OHLC") {
      const p = pairs[0];
      if (p === "EURUSD") return json({ error: [], result: { ZEURZUSD: ohlcRows(0, 200, 1.25).map((r, i) => i < 200 ? [r[0], "1.25", "1.25", "1.25", "1.25", "0", "1", 1] : r), last: ohlcRows(0)[199][0] } });
      const rows = ohlcRows(opts.seeds?.[p] ?? 1, 200, p.endsWith("USD") ? 250 : 100, isTokenizedPair(p));
      return json({ error: [], result: { [p]: rows, last: rows[199][0] } });
    }
    throw new Error(`unexpected path ${url.pathname}`);
  }) as unknown as typeof fetch;
  return Object.assign(fn, { calls });
}

describe("The owner's core and USD-quoted tokenized stocks", () => {
  it("lists six core assets with different drivers in the example config", () => {
    expect(TRADER.assets.map((a) => `${a.symbol}:${a.krakenPair}`)).toEqual(["BTC:XBTEUR", "ETH:ETHEUR", "PAXG:PAXGEUR", "USDC:USDCEUR", "SPY:SPYxUSD", "NVDA:NVDAxUSD"]);
    expect(isTokenizedPair("SPYxUSD")).toBe(true);
    expect(isTokenizedPair("SPYXUSD")).toBe(false);
    expect(isTokenizedPair("XBTEUR")).toBe(false);
    expect(quoteOf("NVDAxUSD")).toBe("USD");
    expect(pairQuery("NVDAxUSD")).toBe("pair=NVDAxUSD&asset_class=tokenized_asset");
    expect(pairQuery("PAXGEUR")).toBe("pair=PAXGEUR");
  });

  it("converts tokenized stock prices and daily history from USD to EUR with Kraken's EUR/USD rate", async () => {
    const db = openDb();
    const fetchFn = fakeKraken();
    const r = await collectPrices(db.raw, TRADER, fetchFn, T0);
    expect(r.errors).toEqual([]);
    expect(latestFx(db.raw)?.eurUsd).toBe(1.25);
    expect(latestPrice(db.raw, "SPY")?.price).toBeCloseTo(200, 6); // 250 USD at 1.25 dollars per euro
    expect(latestPrice(db.raw, "NVDA")?.price).toBeCloseTo(200, 6);
    expect(latestPrice(db.raw, "PAXG")?.price).toBe(100);
    expect(fetchFn.calls.filter((u) => u.searchParams.get("pair") === "SPYxUSD")[0].searchParams.get("asset_class")).toBe("tokenized_asset");
    const c = await collectCandles(db.raw, TRADER, fetchFn);
    expect(c.errors).toEqual([]);
    const spy = loadDaily(db.raw, "SPY");
    expect(spy).toHaveLength(200);
    expect(spy[0].close).toBeCloseTo((250 * (1 + Math.sin(0) * 0.02)) / 1.25, 6);
    // Without a rate, a USD asset is skipped with an error, never stored in dollars.
    const db2 = openDb();
    const noFx = vi.fn(async (input: any) => {
      const url = new URL(String(input));
      if (url.searchParams.get("pair") === "EURUSD") return new Response("down", { status: 503 });
      return fakeKraken()(input);
    }) as unknown as typeof fetch;
    const r2 = await collectPrices(db2.raw, TRADER, noFx, T0);
    expect(r2.errors.join(" ")).toContain("EUR/USD");
    expect(latestPrice(db2.raw, "SPY")).toBeUndefined();
    expect(latestPrice(db2.raw, "BTC")?.price).toBe(100);
    db.close();
    db2.close();
  });
});

describe("Satellites Sonni rotates", () => {
  it("follows tokenized stocks by Kraken's spelling, refuses thin pairs, caps the slots, honours the owner's veto", async () => {
    const db = openDb();
    const fetchFn = fakeKraken({ volumes: { DUSTEUR: 1_000, SOLEUR: 8_300_000, AAPLxUSD: 2_500_000, HYPEEUR: 2_200_000 } });
    const appl = await followAsset(db.raw, TRADER, { symbol: "aapl", krakenPair: "AAPLXUSD", reason: REASON }, fetchFn, T0);
    expect(appl).toMatchObject({ ok: true, value: { asset: "AAPL", krakenPair: "AAPLxUSD" } });
    // 1,000 x 1 = 1,000 EUR a day: too thin.
    expect(await followAsset(db.raw, TRADER, { symbol: "DUST", krakenPair: "DUSTEUR", reason: REASON }, fetchFn, T0))
      .toMatchObject({ ok: false, error: expect.stringContaining("too thin") });
    expect((await followAsset(db.raw, TRADER, { symbol: "SOL", krakenPair: "SOLEUR", reason: REASON }, fetchFn, T0)).ok).toBe(true);
    expect((await followAsset(db.raw, TRADER, { symbol: "HYPE", krakenPair: "HYPEEUR", reason: REASON }, fetchFn, T0)).ok).toBe(true);
    expect(MAX_SATELLITES).toBe(3);
    expect(await followAsset(db.raw, TRADER, { symbol: "EURC", krakenPair: "EURCEUR", reason: REASON }, fetchFn, T0))
      .toMatchObject({ ok: false, error: expect.stringContaining("satellite slots are taken (AAPL, SOL, HYPE)") });
    expect(activeAssets(db.raw, TRADER).map((a) => a.symbol)).toEqual(["BTC", "ETH", "PAXG", "USDC", "SPY", "NVDA", "AAPL", "SOL", "HYPE"]);
    expect(unfollowAsset(db.raw, TRADER, { symbol: "PAXG", reason: "l'or ne bouge pas assez pour moi" }, days(5)))
      .toMatchObject({ ok: false, error: expect.stringContaining("in the owner's core") });
    // The owner's veto: at once, and Sonni cannot take it back for 30 days.
    expect(ownerVeto(db.raw, TRADER, "paxg", days(1))).toContain("fait partie du socle");
    expect(ownerVeto(db.raw, TRADER, "hype", days(1))).toContain("HYPE n'est plus suivi (ton veto)");
    expect(await followAsset(db.raw, TRADER, { symbol: "HYPE", krakenPair: "HYPEEUR", reason: REASON }, fetchFn, days(20)))
      .toMatchObject({ ok: false, error: expect.stringContaining("vetoed by the owner") });
    expect((await followAsset(db.raw, TRADER, { symbol: "HYPE", krakenPair: "HYPEEUR", reason: REASON }, fetchFn, days(32))).ok).toBe(true);
    const out: string[] = [];
    runSonniCommand(["actifs", "non", "SOL"], db.raw, TRADER, (t) => out.push(t));
    expect(out.join("\n")).toContain("SOL n'est plus suivi (ton veto)");
    out.length = 0;
    runSonniCommand(["actifs"], db.raw, TRADER, (t) => out.push(t));
    expect(out.join("\n")).toContain("Socle choisi par toi (6) : BTC (XBTEUR), ETH (ETHEUR), PAXG (PAXGEUR), USDC (USDCEUR), SPY (SPYxUSD, en dollars converti en euros), NVDA (NVDAxUSD, en dollars converti en euros)");
    expect(out.join("\n")).toContain("Places tournantes choisies par Sonni (2 sur 3) : AAPL (AAPLxUSD, en dollars converti en euros), HYPE (HYPEEUR)");
    db.close();
  });
});

describe("The weekly screen", () => {
  it("measures liquid pairs Sonni does not follow, ranks the most different first, skips stablecoins, stores append-only", async () => {
    const db = openDb();
    const fetchFn = fakeKraken({
      volumes: { DUSTEUR: 1_000, SOLEUR: 8_300_000, HYPEEUR: 2_200_000, AAPLxUSD: 2_500_000, EURCEUR: 50_000_000 },
      // SOL moves exactly like BTC (same seed); HYPE and AAPL follow their own paths.
      seeds: { XBTEUR: 1, ETHEUR: 2, SOLEUR: 1, HYPEEUR: 7, AAPLxUSD: 3, SPYxUSD: 5, NVDAxUSD: 11, PAXGEUR: 13 },
    });
    const twoAssets: TraderConfig = { ...TRADER, assets: TRADER.assets.slice(0, 2) };
    await collectCandles(db.raw, twoAssets, fetchFn);
    expect(screenDue(db.raw, T0, new Date(T0.getTime() + 30 * 60_000))).toBe(false); // first screen waits an hour
    expect(screenDue(db.raw, T0, new Date(T0.getTime() + 61 * 60_000))).toBe(true);
    const pauses: number[] = [];
    const { rows, errors } = await runScreen(db.raw, twoAssets, fetchFn, T0, async (ms) => { pauses.push(ms); });
    expect(errors).toEqual([]);
    // Followed pairs, stablecoins and thin pairs are out; PAXG, USDC, SPY, NVDA are not followed in this config.
    expect(rows.map((r) => r.pair).sort()).toEqual(["AAPLxUSD", "HYPEEUR", "NVDAxUSD", "PAXGEUR", "SOLEUR", "SPYxUSD"]);
    expect(pauses.length).toBe(rows.length);
    const sol = rows.find((r) => r.pair === "SOLEUR")!;
    expect(sol.maxCorr).toBeCloseTo(1, 6);
    expect(sol.maxCorrWith).toBe("BTC");
    expect(rows.at(-1)!.pair).toBe("SOLEUR"); // the same moves as BTC rank last
    expect(rows[0].score).toBeGreaterThan(sol.score);
    const aapl = rows.find((r) => r.pair === "AAPLxUSD")!;
    expect(aapl.volumeEur).toBeCloseTo(2_000_000, 0); // 2.5 M USD at 1.25
    expect(latestScreen(db.raw).map((r) => r.pair)).toEqual(rows.map((r) => r.pair));
    expect(() => db.raw.prepare("DELETE FROM trader_screen").run()).toThrow(/append-only/);
    expect(screenDue(db.raw, T0, days(6))).toBe(false);
    expect(screenDue(db.raw, T0, days(7))).toBe(true);
    expect(screenPackLines(db.raw, 2)[0]).toMatch(/^- \w+ \(\w+\): \d+\.\d M EUR\/day, 30 d [+-]\d+\.\d %, 90 d [+-]\d+\.\d %, (above|below) its 50-day average, volatility \d+ %\/yr, corr BTC -?\d\.\d\d, highest with yours -?\d\.\d\d \((BTC|ETH)\)$/);
    expect(formatScreenFr(db.raw)).toContain("Crible du 2026-10-08 (calculé par le code ; les plus différents de ce que Sonni suit déjà) :");
    setKV(db.raw, "sonni.config_assets", JSON.stringify(twoAssets.assets));
    const pack = buildMemoryPack(db.raw, twoAssets, T0);
    expect(pack).toContain("Your universe: core BTC, ETH (the owner's); satellites none (0 of 3, yours to rotate with follow_asset). Weekly screen by code");
    db.close();
  });
});
