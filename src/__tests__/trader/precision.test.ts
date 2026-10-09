/**
 * Step 0.3 (2026-10-09): the paper broker keeps price precision at every scale and never writes a zero price,
 * an invalid quantity, NaN or Infinity. Before it, fill prices and average costs were rounded to the cent:
 * below 1 EUR fills drifted from the market, averaged positions stopped adding up, and below 0.005 EUR a fill
 * stored a price of 0 and an infinite quantity, after which the broker failed on every tick.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { createDatabase } from "../../state/database.js";
import { ensureMoneyLabSchema, getKV } from "../../money-lab/journal.js";
import { applyMoneyLabProfile } from "../../money-lab/profile.js";
import type { AutomatonConfig, AutomatonDatabase } from "../../types.js";
import { applyTraderProfile, DEFAULT_PORTFOLIO, parseTraderConfig, type TraderConfig } from "../../trader/config.js";
import { ensureTraderSchema } from "../../trader/schema.js";
import { isoSeconds } from "../../trader/prices.js";
import {
  availableQuantity, brokerTick, getOrder, getPosition, listTrades, performance, placeOrder, rejectionNoteFr, restoreStopLevel, roundPrice, snapshots, updatePosition, valuation,
} from "../../trader/portfolio.js";
import { describeWatch, evaluateTriggers } from "../../trader/curiosity.js";
import { consistencySubject, factValueFr } from "../../trader/brainchecks.js";
import { decisionsDue, decisionsPackLines, recordDecision } from "../../trader/decisions.js";
import { fmtEur, fmtPrice, plainPrice, priceEn, qtyText } from "../../trader/format.js";
import { listIncidents } from "../../trader/incidents.js";
import { formatPortfolioFr, formatSonniStatus } from "../../trader/status.js";
import { buildSonniEveningSummary } from "../../trader/report.js";
import { buildMemoryPack } from "../../trader/pack.js";
import { buildSonniPromptBlock } from "../../trader/prompt.js";
import { formatSelfReport, formatSelfReportFr, selfReport } from "../../trader/soul.js";
import { summarize } from "../../trader/summaries.js";
import { fetchKrakenDaily } from "../../trader/candles.js";
import { evaluateRule } from "../../trader/rules.js";
import { createTestConfig } from "../mocks.js";

const ROOT = path.join(__dirname, "..", "..", "..");
const EXAMPLE = JSON.parse(fs.readFileSync(path.join(ROOT, "sonni", "automaton.sonni.example.json"), "utf-8"));
/** BTC, ETH and USDC as the owner follows them, plus low-priced pairs like the ones Kraken lists (PUMP, PEPE). */
EXAMPLE.trader.assets = [
  ["BTC", "XBTEUR"], ["ETH", "ETHEUR"], ["USDC", "USDCEUR"], ["SPY", "SPYXEUR"], ["ADA", "ADAEUR"], ["MID", "MIDEUR"],
  ["PUMP", "PUMPEUR"], ["PEPE", "PEPEEUR"], ["TINY", "TINYEUR"],
].map(([symbol, krakenPair]) => ({ symbol, krakenPair }));
const TRADER: TraderConfig = parseTraderConfig(EXAMPLE.trader)!;
const T0 = new Date("2026-10-07T08:00:00Z");
const hours = (n: number) => new Date(T0.getTime() + n * 3_600_000);
const THESIS = "Test de précision : petite position pour vérifier le courtier virtuel à cette échelle de prix.";
const round2 = (v: number) => Math.round(v * 100) / 100;
const round8 = (v: number) => Math.round(v * 1e8) / 1e8;
/** Any non-finite figure an owner or the model could read. */
const BROKEN = /∞|NaN|Infinity|e[+-]\d/;

let tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
function openDb(file = path.join(tmp("sonni-precision-"), "state.db")): AutomatonDatabase {
  const db = createDatabase(file);
  ensureMoneyLabSchema(db.raw);
  ensureTraderSchema(db.raw);
  return db;
}
beforeEach(() => { tmpDirs = []; });
afterEach(() => { for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true }); });

function storePrice(db: AutomatonDatabase, asset: string, at: Date, price: number) {
  db.raw.prepare("INSERT INTO trader_prices (asset, ts, price, source) VALUES (?, ?, ?, 'test')").run(asset, isoSeconds(at), price);
}

/** Places an order at hour `at` (price `price`), then fills it at the next stored price `fillAt` (default the same). */
function trade(db: AutomatonDatabase, at: number, asset: string, price: number, order: Record<string, unknown>, fillAt = price) {
  storePrice(db, asset, hours(at), price);
  const placed = placeOrder(db.raw, TRADER, { asset, thesis: THESIS, ...order } as any, hours(at));
  expect(placed.ok, JSON.stringify(placed)).toBe(true);
  storePrice(db, asset, hours(at + 0.1), fillAt);
  return brokerTick(db.raw, TRADER, hours(at + 0.1));
}
const buy = (amountEur: number, price: number) => ({ side: "buy", amountEur, invalidation: price * 0.7 });
const sellAll = { side: "sell", quantity: "all" };

/** A funded portfolio (1,000 EUR at the first tick). */
function funded(): AutomatonDatabase {
  const db = openDb();
  storePrice(db, "BTC", T0, 60_000);
  brokerTick(db.raw, TRADER, T0);
  return db;
}

/** A 100 EUR market buy at P, then a sale of everything at P (5 bps slippage, taker 0.8 %). */
function roundTrip(asset: string, P: number, exit = P) {
  const db = funded();
  const b = trade(db, 1, asset, P, buy(100, P));
  const bought = b.fills[0].order;
  const open = valuation(db.raw);
  const s = trade(db, 2, asset, exit, sellAll);
  return { db, bought, open, sold: s.fills[0].order, trade: s.fills[0].trade!, after: valuation(db.raw) };
}

/** Every numeric column of the broker's tables is finite (NaN cannot be stored: it becomes NULL). */
function expectAllFinite(db: AutomatonDatabase) {
  const checks: [string, string[]][] = [
    ["trader_orders", ["amount_eur", "quantity", "limit_price", "fill_price", "fill_quantity", "fill_eur", "fee_eur", "slippage_eur"]],
    ["trader_ledger", ["quantity", "price", "amount_eur", "fee_eur"]],
    ["trader_positions", ["quantity", "avg_cost", "invalidation"]],
    ["trader_trades", ["quantity", "entry_price", "exit_price", "fees_eur", "pnl_eur", "pnl_pct"]],
    ["trader_portfolio_days", ["cash_eur", "positions_eur", "equity_eur", "contributed_eur"]],
    ["trader_decisions", ["price", "position_eur", "equity_eur"]],
  ];
  for (const [table, cols] of checks) {
    for (const row of db.raw.prepare(`SELECT ${cols.join(", ")} FROM ${table}`).all() as Record<string, number | null>[]) {
      for (const c of cols) if (row[c] !== null) expect(Number.isFinite(row[c]), `${table}.${c} = ${row[c]}`).toBe(true);
    }
  }
  for (const row of db.raw.prepare("SELECT fill_price, fill_quantity FROM trader_orders WHERE status = 'filled'").all() as { fill_price: number; fill_quantity: number }[]) {
    expect(row.fill_price).toBeGreaterThan(0);
    expect(row.fill_quantity).toBeGreaterThan(0);
  }
}

/** What the broker computed before step 0.3 for a 100 EUR round trip (cent-rounded fill prices and average cost). */
function oldRoundTrip(P: number, exit: number) {
  const fill = round2(P * 1.0005);
  const q = round8(99.2 / fill);
  const avg = round2(99.2 / q);
  const sale = round2(exit * 0.9995);
  const proceeds = round2(q * sale);
  const fee = round2(proceeds * 0.008);
  return { slippage: round2(q * (fill - P)), proceeds, fee, result: round2(round2(proceeds - fee - q * avg) - 0.8), cash: round2(900 + proceeds - fee) };
}

describe("Unit prices keep 12 significant digits; amounts stay in cents, quantities in 1e-8", () => {
  it("roundPrice drops float noise and keeps tiny prices", () => {
    expect(roundPrice(60_100 * 1.0005)).toBe(60_130.05); // the raw double is 60130.049999999996
    expect(roundPrice(0.86 * 1.0005)).toBe(0.86043); // 0.8604299999999999
    expect(roundPrice(1939.0300000000002)).toBe(1939.03);
    expect(roundPrice(3.483741e-6)).toBe(3.483741e-6);
    expect(roundPrice(0.004885 * 1.0005)).toBe(0.0048874425);
    expect(Number.isNaN(roundPrice(NaN))).toBe(true); // the guard catches what rounding cannot
    expect(roundPrice(Infinity)).toBe(Infinity);
  });

  it.each([
    ["BTC", 73_784.1], ["BTC", 95_123.45], ["ETH", 2_218.97], ["ETH", 2_300], ["USDC", 0.8936], ["USDC", 0.86], ["USDC", 0.855], ["USDC", 0.8645],
    ["ADA", 0.2], ["ADA", 0.212295], ["MID", 0.0123], ["MID", 0.006], ["PUMP", 0.004885], ["PUMP", 0.004], ["TINY", 0.00001], ["PEPE", 0.000003482],
  ])("a 100 EUR round trip at %s %s costs the same 1.69 EUR as at any other price", (asset, P) => {
    const { db, bought, open, sold, trade: t, after } = roundTrip(asset as string, P as number);
    const p = P as number;
    expect(Math.abs(bought.fillPrice! / (p * 1.0005) - 1)).toBeLessThanOrEqual(1e-11);
    expect(bought.fillQuantity).toBe(round8(99.2 / bought.fillPrice!));
    expect(bought).toMatchObject({ feeEur: 0.8, slippageEur: 0.05 });
    expect(open.positions[0].pnlEur).toBe(-0.85); // purchase fee and slippage, right after the buy
    expect(Math.abs(sold.fillPrice! / (p * 0.9995) - 1)).toBeLessThanOrEqual(1e-11);
    expect(sold).toMatchObject({ fillEur: 99.1, feeEur: 0.79, slippageEur: 0.05 });
    expect(t.pnlEur).toBe(-1.69);
    expect(after.cashEur).toBe(998.31);
    expect(getPosition(db.raw, asset as string)).toBeUndefined();
    expectAllFinite(db);
    db.close();
  });

  it("the measured cases: USDC at Kraken's 0.8936, PUMP at 0.004885, PEPE at 0.000003482", () => {
    const usdc = roundTrip("USDC", 0.8936);
    expect(usdc.bought).toMatchObject({ fillPrice: 0.8940468, fillQuantity: 110.95616024 }); // before: 0.89 and 111.46067416
    usdc.db.close();
    const pump = roundTrip("PUMP", 0.004885);
    expect(pump.bought).toMatchObject({ fillPrice: 0.0048874425, fillQuantity: 20296.91397904 }); // before: 0 and Infinity
    expect(pump.sold.fillPrice).toBe(0.0048825575);
    pump.db.close();
    const pepe = roundTrip("PEPE", 0.000003482);
    expect(pepe.bought).toMatchObject({ fillPrice: 0.000003483741, fillQuantity: 28475136.35485532 });
    pepe.db.close();
  });

  it("BTC, ETH and tokenized stocks stay within 1 cent of the old cent-rounding broker (the new figure is the exact one)", () => {
    // A fixed pseudo-random walk (no Math.random: the test must give the same prices every run).
    let seed = 20261009;
    const next = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
    // Measured on 20,000 round trips each: BTC 0.1 %, ETH 1.1 %, PAXG 1.1 %, stocks at 120-700 EUR 10 % differ, always by
    // exactly 1 cent of sale proceeds: the old proceeds used a fill price rounded to the cent.
    const ranges: [string, number, number, number][] = [["BTC", 50_000, 100_000, 0.01], ["ETH", 1_500, 4_000, 0.01], ["SPY", 120, 200, 0.01]];
    for (const [asset, lo, hi, tolerance] of ranges) {
      for (let i = 0; i < 12; i++) {
        const P = round2(lo + (hi - lo) * next());
        const exit = round2(P * (0.95 + 0.1 * next()));
        const old = oldRoundTrip(P, exit);
        const { db, bought, sold, trade: t, after } = roundTrip(asset, P, exit);
        const gaps = [bought.slippageEur! - old.slippage, sold.fillEur! - old.proceeds, sold.feeEur! - old.fee, t.pnlEur - old.result, after.cashEur - old.cash];
        for (const g of gaps) expect(Math.abs(g), `${asset} ${P} -> ${exit}`).toBeLessThanOrEqual(tolerance + 1e-9);
        db.close();
      }
    }
  });

  it("limit orders fill at their limit exactly, with the maker fee and no slippage", () => {
    for (const [asset, P, limit] of [["BTC", 60_000, 59_000.37], ["USDC", 0.8936, 0.8935], ["ADA", 0.21, 0.2049], ["PUMP", 0.0041, 0.004], ["TINY", 0.000011, 0.00001]] as const) {
      const db = funded();
      const r = trade(db, 1, asset, P, { side: "buy", kind: "limit", limitPrice: limit, amountEur: 50, invalidation: limit * 0.7, horizonHours: 24 }, limit);
      expect(r.fills[0].order).toMatchObject({ fillPrice: limit, feeEur: 0.2, slippageEur: 0 });
      expect(r.fills[0].order.fillQuantity).toBe(round8(49.8 / limit));
      expectAllFinite(db);
      db.close();
    }
  });

  it("fees and settings are unchanged", () => {
    expect(DEFAULT_PORTFOLIO).toMatchObject({ takerFeePct: 0.8, makerFeePct: 0.4, slippageBps: 5, minOrderEur: 10, maxPositionPct: 30 });
    expect(TRADER.portfolio).toEqual(DEFAULT_PORTFOLIO);
  });
});

describe("Averaged buys, partial and full sales conserve units and euros", () => {
  const scenarios: [string, number, number, number, number][] = [
    ["BTC", 60_000, 61_000, 63_000, 62_000], ["ETH", 2_000, 2_100, 2_150, 1_950],
    ["USDC", 0.86, 0.869, 0.87, 0.865], ["ADA", 0.2, 0.2149, 0.2149, 0.21], ["PUMP", 0.004, 0.0045, 0.0046, 0.0044],
  ];
  it.each(scenarios)("%s: buy 100, add 50, sell half, sell the rest", (asset, p1, p2, p3, p4) => {
    const db = funded();
    const ledgerUnits = () => (db.raw.prepare("SELECT COALESCE(SUM(CASE kind WHEN 'buy' THEN quantity ELSE -quantity END), 0) AS q FROM trader_ledger WHERE asset = ?").get(asset) as { q: number }).q;
    trade(db, 1, asset, p1, buy(100, p1));
    trade(db, 2, asset, p2, buy(50, p2));
    const pos = getPosition(db.raw, asset)!;
    // The stored average cost is what the units cost after fees: 148.8 EUR over the units bought.
    expect(Math.abs((pos.quantity * pos.avgCost) / 148.8 - 1)).toBeLessThanOrEqual(1e-11);
    expect(Math.abs(ledgerUnits() - pos.quantity)).toBeLessThanOrEqual(1e-8);
    const half = round8(pos.quantity / 2);
    const first = trade(db, 3, asset, p3, { side: "sell", quantity: half }).fills[0];
    expect(getPosition(db.raw, asset)!.quantity).toBe(round8(pos.quantity - half));
    expect(Math.abs(ledgerUnits() - getPosition(db.raw, asset)!.quantity)).toBeLessThanOrEqual(1e-8);
    const second = trade(db, 4, asset, p4, sellAll).fills[0];
    expect(getPosition(db.raw, asset)).toBeUndefined();
    expect(Math.abs(ledgerUnits())).toBeLessThanOrEqual(1e-8);
    expect(first.order.fillQuantity! + second.order.fillQuantity!).toBeCloseTo(pos.quantity, 8);
    // Euros: the trades' results are the portfolio's result, and every fee paid is in a trade.
    const v = valuation(db.raw);
    expect(Math.abs(first.trade!.pnlEur + second.trade!.pnlEur - v.pnlEur)).toBeLessThanOrEqual(0.02);
    const ledgerFees = (db.raw.prepare("SELECT SUM(fee_eur) AS f FROM trader_ledger WHERE asset = ?").get(asset) as { f: number }).f;
    expect(round2(first.trade!.feesEur + second.trade!.feesEur)).toBe(round2(ledgerFees));
    expectAllFinite(db);
    db.close();
  });

  it("before step 0.3 the USDC and ADA averages drifted (0.58 and 2.70 EUR); now the gap is at most a rounding cent", () => {
    for (const [asset, p1, p2, p3, p4] of scenarios.slice(2, 4)) {
      const db = funded();
      trade(db, 1, asset, p1, buy(100, p1));
      trade(db, 2, asset, p2, buy(50, p2));
      trade(db, 3, asset, p3, { side: "sell", quantity: round8(getPosition(db.raw, asset)!.quantity / 2) });
      trade(db, 4, asset, p4, sellAll);
      const sum = listTrades(db.raw).reduce((s, t) => s + t.pnlEur, 0);
      expect(Math.abs(sum - valuation(db.raw).pnlEur)).toBeLessThanOrEqual(0.02);
      db.close();
    }
  });

  it("a sale of everything leaves exactly zero, even past 2^25 units where round8 is not idempotent", () => {
    // 100 EUR at 2.61147e-6 EUR is 37,967,284.62804712 units: re-rounded, the old sale exceeded the position.
    const held = funded();
    trade(held, 1, "PEPE", 2.61147e-6, buy(100, 2.61147e-6));
    expect(getPosition(held.raw, "PEPE")!.quantity).toBe(37967284.62804712);
    expect(37967284.62804712 * 1e8 % 1).not.toBe(0); // the double is off the 1e-8 grid: round8 moves it up a step
    expect(availableQuantity(held.raw, "PEPE")).toBe(37967284.62804712); // never more than held
    held.close();
    const odd = roundTrip("PEPE", 2.61147e-6);
    expect(odd.bought.fillQuantity).toBe(37967284.62804712);
    expect(odd.sold.fillQuantity).toBe(odd.bought.fillQuantity);
    expect(getPosition(odd.db.raw, "PEPE")).toBeUndefined();
    odd.db.close();
    for (let i = 0; i < 25; i++) {
      const P = 1.5e-6 + i * 5.7e-8; // 34 M to 66 M units
      const db = funded();
      trade(db, 1, "PEPE", P, buy(100, P));
      expect(availableQuantity(db.raw, "PEPE")).toBe(getPosition(db.raw, "PEPE")!.quantity);
      const sold = trade(db, 2, "PEPE", P, sellAll);
      expect(sold.rejected, `price ${P}`).toEqual([]);
      expect(getPosition(db.raw, "PEPE"), `price ${P}`).toBeUndefined();
      db.close();
    }
  });
});

describe("Nothing invalid is written: a bad fill is rejected and the rest goes on (G17)", () => {
  it("a price that rounds the quantity to Infinity rejects the order, writes nothing and tells the owner", () => {
    const db = funded();
    storePrice(db, "TINY", hours(1), 1e-320); // accepted by CHECK price > 0, absurd for any fill
    expect(placeOrder(db.raw, TRADER, { asset: "TINY", side: "buy", amountEur: 100, invalidation: 7e-321, thesis: THESIS }, hours(1)).ok).toBe(true);
    storePrice(db, "BTC", hours(1), 60_000);
    expect(placeOrder(db.raw, TRADER, { asset: "BTC", side: "buy", amountEur: 100, invalidation: 50_000, thesis: THESIS }, hours(1)).ok).toBe(true);
    storePrice(db, "TINY", hours(1.1), 1e-320);
    storePrice(db, "BTC", hours(1.1), 60_000);
    const out = brokerTick(db.raw, TRADER, hours(1.1));
    expect(out.rejected).toHaveLength(1);
    expect(out.rejected[0]).toMatchObject({ asset: "TINY", status: "rejected" });
    expect(out.rejected[0].note).toMatch(/^rejected by code \(quantity\): the quantity is not a positive finite number \[quantity=Infinity\]$/);
    expect(rejectionNoteFr(out.rejected[0].note)).toBe("refusé par le code : quantité nulle, négative ou non finie (quantité = infini)");
    expect(out.fills.map((f) => f.order.asset)).toEqual(["BTC"]); // the next order still fills in the same tick
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM trader_ledger WHERE asset = 'TINY'").get()).toEqual({ n: 0 });
    expect(getPosition(db.raw, "TINY")).toBeUndefined();
    const incidents = listIncidents(db.raw).filter((i) => i.kind === "broker");
    expect(incidents).toHaveLength(1);
    expect(incidents[0].message).toContain("refusé par le courtier virtuel : quantité nulle, négative ou non finie");
    expect(formatPortfolioFr(db.raw, TRADER, hours(1.2))).toContain("achat de 100,00 € de TINY : refusé (refusé par le code : quantité nulle");
    expectAllFinite(db);
    db.close();
  });

  it("an unexpected failure on one order leaves it pending, once reported a day, and the other orders, stops and snapshot run", () => {
    const db = funded();
    trade(db, 1, "ETH", 2_000, { side: "buy", amountEur: 100, invalidation: 1_900 });
    // A database failure on ADA's ledger row only (a temporary trigger of this connection).
    db.raw.exec("CREATE TEMP TRIGGER fail_ada BEFORE INSERT ON main.trader_ledger WHEN NEW.asset = 'ADA' BEGIN SELECT RAISE(ABORT, 'disk full (test)'); END;");
    storePrice(db, "ADA", hours(2), 0.2);
    expect(placeOrder(db.raw, TRADER, { asset: "ADA", side: "buy", amountEur: 50, invalidation: 0.15, thesis: THESIS }, hours(2)).ok).toBe(true);
    storePrice(db, "BTC", hours(2), 60_000);
    expect(placeOrder(db.raw, TRADER, { asset: "BTC", side: "buy", amountEur: 50, invalidation: 50_000, thesis: THESIS }, hours(2)).ok).toBe(true);
    storePrice(db, "ADA", hours(25), 0.2);
    storePrice(db, "BTC", hours(25), 60_000);
    storePrice(db, "ETH", hours(25), 1_850); // below its stop
    const out = brokerTick(db.raw, TRADER, hours(25));
    expect(out.failed).toHaveLength(1);
    expect(out.fills.map((f) => f.order.asset)).toEqual(["BTC"]);
    expect(out.stops.map((o) => o.asset)).toEqual(["ETH"]);
    expect(out.snapshot).toBe(true);
    expect(db.raw.prepare("SELECT status FROM trader_orders WHERE asset = 'ADA'").get()).toEqual({ status: "pending" });
    expect(brokerTick(db.raw, TRADER, hours(25.2)).failed).toHaveLength(1); // still failing: retried, not reported again today
    expect(listIncidents(db.raw).filter((i) => i.message.includes("échec technique"))).toHaveLength(1);
    db.raw.exec("DROP TRIGGER fail_ada");
    storePrice(db, "ADA", hours(25.3), 0.2);
    expect(brokerTick(db.raw, TRADER, hours(25.3)).fills.map((f) => f.order.asset)).toContain("ADA"); // the order was not lost
    expectAllFinite(db);
    db.close();
  });

  it("one stop that cannot be placed does not keep the others from being placed", () => {
    const db = funded();
    // Stops run in asset order (ADA, BTC, ETH): the failing one sits in the middle, so neither the stops
    // before it nor the ones after it may be lost.
    trade(db, 1, "ADA", 0.2, buy(100, 0.2));
    trade(db, 2, "BTC", 60_000, buy(100, 60_000));
    trade(db, 3, "ETH", 2_000, { side: "buy", amountEur: 100, invalidation: 1_900 });
    db.raw.exec("CREATE TEMP TRIGGER fail_btc_stop BEFORE INSERT ON main.trader_position_updates WHEN NEW.asset = 'BTC' BEGIN SELECT RAISE(ABORT, 'disk full (test)'); END;");
    storePrice(db, "ADA", hours(4), 0.13);
    storePrice(db, "BTC", hours(4), 41_000);
    storePrice(db, "ETH", hours(4), 1_890);
    const out = brokerTick(db.raw, TRADER, hours(4));
    expect(out.stops.map((o) => o.asset)).toEqual(["ADA", "ETH"]);
    expect(out.snapshot).toBe(false); // already taken today; the tick went on to it without throwing
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM trader_orders WHERE asset = 'BTC' AND origin = 'stop'").get()).toEqual({ n: 0 }); // nothing half written
    expect(getPosition(db.raw, "BTC")!.invalidation).toBe(42_000); // kept: retried at the next tick
    expect(listIncidents(db.raw).some((i) => i.message.startsWith("stop de BTC : échec technique au placement"))).toBe(true);
    db.raw.exec("DROP TRIGGER fail_btc_stop");
    storePrice(db, "BTC", hours(4.1), 41_000);
    expect(brokerTick(db.raw, TRADER, hours(4.1)).stops.map((o) => o.asset)).toEqual(["BTC"]);
    db.close();
  });

  it("a rejected stop puts its level back once a day, and says so when it cannot (a last resort)", () => {
    const db = funded();
    trade(db, 1, "ETH", 2_000, { side: "buy", amountEur: 100, invalidation: 1_900 });
    storePrice(db, "ETH", hours(2), 1_890);
    const [stop] = brokerTick(db.raw, TRADER, hours(2)).stops;
    expect(getPosition(db.raw, "ETH")!.invalidation).toBeNull();
    // With a positive price and a valid position a stop's fill cannot be rejected: the rejection is simulated.
    db.raw.prepare("UPDATE trader_orders SET status = 'rejected', settled_at = ?, note = 'rejected by code (amount): test' WHERE id = ?").run(isoSeconds(hours(2.1)), stop.id);
    restoreStopLevel(db.raw, getOrder(db.raw, stop.id)!, hours(2.1));
    expect(getPosition(db.raw, "ETH")!.invalidation).toBe(1_900);
    const update = db.raw.prepare("SELECT new_value, reason, by FROM trader_position_updates WHERE asset = 'ETH' ORDER BY at DESC, id DESC LIMIT 1").get() as any;
    expect(update).toMatchObject({ new_value: "1900", by: "code", reason: expect.stringContaining("level restored") });
    expect(listIncidents(db.raw).some((i) => i.message.includes("stop de ETH refusé") && i.message.includes("rétabli"))).toBe(true);
    storePrice(db, "ETH", hours(2.2), 1_880);
    const [again] = brokerTick(db.raw, TRADER, hours(2.2)).stops; // the next tick places the stop again
    expect(again.asset).toBe("ETH");
    db.raw.prepare("UPDATE trader_orders SET status = 'rejected', settled_at = ?, note = 'rejected by code (amount): test' WHERE id = ?").run(isoSeconds(hours(2.3)), again.id);
    restoreStopLevel(db.raw, getOrder(db.raw, again.id)!, hours(2.3));
    expect(getPosition(db.raw, "ETH")!.invalidation).toBeNull(); // the second time that day: no loop
    expect(listIncidents(db.raw).some((i) => i.message.includes("une deuxième fois aujourd'hui : la position reste sans stop tant qu'aucun niveau n'est remis"))).toBe(true);
    db.close();
  });

  it("a sale of dust whose proceeds round to 0.00 EUR is a valid fill, not a rejection", () => {
    const db = funded();
    trade(db, 1, "BTC", 60_000, buy(100, 60_000));
    trade(db, 2, "BTC", 60_000, { side: "sell", quantity: round8(getPosition(db.raw, "BTC")!.quantity - 1e-8) });
    expect(getPosition(db.raw, "BTC")!.quantity).toBe(1e-8); // dust left: worth 0.0006 EUR
    const out = trade(db, 3, "BTC", 60_000, sellAll);
    expect(out.rejected).toEqual([]);
    expect(out.fills[0].order).toMatchObject({ status: "filled", fillQuantity: 1e-8, feeEur: 0 });
    expect(db.raw.prepare("SELECT amount_eur, fee_eur FROM trader_ledger WHERE order_id = ?").get(out.fills[0].order.id)).toEqual({ amount_eur: 0, fee_eur: 0 });
    expect(getPosition(db.raw, "BTC")).toBeUndefined(); // closed, exactly 0 left
    db.close();
  });

  it("a stop rejected at fill whose level cannot be put back writes nothing half and tells the owner", () => {
    const db = funded();
    trade(db, 1, "ETH", 2_000, { side: "buy", amountEur: 100, invalidation: 1_900 });
    storePrice(db, "ETH", hours(2), 1_890);
    const [stop] = brokerTick(db.raw, TRADER, hours(2)).stops;
    // A legacy-style infinite price (the CHECK lets 9e999 through) makes the stop's fill invalid: rejected, not filled.
    db.raw.prepare("INSERT INTO trader_prices (asset, ts, price, source) VALUES ('ETH', ?, 9e999, 'test')").run(isoSeconds(hours(2.5)));
    db.raw.exec("CREATE TEMP TRIGGER fail_restore BEFORE INSERT ON main.trader_position_updates WHEN NEW.new_value IS NOT NULL BEGIN SELECT RAISE(ABORT, 'disk full (test)'); END;");
    const out = brokerTick(db.raw, TRADER, hours(2.6));
    expect(out.rejected.map((o) => o.id)).toEqual([stop.id]);
    expect(getOrder(db.raw, stop.id)!.note).toMatch(/^rejected by code \(price\):/);
    expect(getPosition(db.raw, "ETH")!.invalidation).toBeNull(); // the level, its row and the daily mark: all or nothing
    expect(getKV(db.raw, "sonni.stop_restored.ETH")).toBeUndefined();
    expect(listIncidents(db.raw).some((i) => i.message.startsWith("stop de ETH refusé et niveau non rétabli (échec technique : disk full (test))"))).toBe(true);
    db.close();
  });

  it("an order book quote with a zero, negative or non-finite side falls back to the configured slippage", () => {
    for (const [bid, ask] of [[0, 60_010], [-60_010, 60_010], [60_010, 59_990]] as const) {
      const db = funded();
      for (const [metric, value] of [["bid", bid], ["ask", ask]] as const) {
        db.raw.prepare("INSERT INTO trader_metrics (source_id, metric, ts, value) VALUES ('kraken_spread_btc', ?, ?, ?)").run(metric, isoSeconds(hours(1)), value);
      }
      const r = trade(db, 1, "BTC", 60_000, buy(100, 60_000));
      expect(r.fills[0].order.fillPrice).toBe(60_030); // 5 bps
      db.close();
    }
    // A sound quote is used as it is (capping wide quotes is a separate step, owner's decision of 2026-10-09).
    const db = funded();
    for (const [metric, value] of [["bid", 59_990], ["ask", 60_010]] as const) {
      db.raw.prepare("INSERT INTO trader_metrics (source_id, metric, ts, value) VALUES ('kraken_spread_btc', ?, ?, ?)").run(metric, isoSeconds(hours(1)), value);
    }
    expect(trade(db, 1, "BTC", 60_000, buy(100, 60_000)).fills[0].order.fillPrice).toBe(roundPrice(60_000 * (1 + 20 / 60_000 / 2)));
    db.close();
  });

  it("candles with a price of 0 are skipped, and a rule never divides by a zero open", async () => {
    const day = (i: number) => 1_760_000_000 + i * 86_400;
    const fake = async () => new Response(JSON.stringify({ error: [], result: { XBTEUR: [
      [day(0), "60000", "61000", "59000", "60500", "0", "10", 1], [day(1), "0", "61000", "59000", "60500", "0", "10", 1], [day(2), "60500", "61500", "60000", "61000", "0", "10", 1],
    ], last: day(2) } }));
    const candles = await fetchKrakenDaily("XBTEUR", fake as any);
    expect(candles.map((c) => c.open)).toEqual([60_000, 60_500]);
    const series = (zeroOpen: boolean) => Array.from({ length: 40 }, (_, i) => ({
      day: new Date(Date.UTC(2026, 7, 1 + i)).toISOString().slice(0, 10), open: zeroOpen && i === 5 ? 0 : 100, high: 103, low: 98, close: 100 + (i % 3), volume: 10,
    }));
    const rule = { claim: "most_of_the_time" as const, when: [{ kind: "range" as const, asset: "BTC", op: ">" as const, value: 1 }], then: { kind: "forward_return" as const, asset: "BTC", days: 1, op: ">" as const, value: 0 } };
    const whole = evaluateRule(rule, { BTC: series(false) as any });
    const withZero = evaluateRule(rule, { BTC: series(true) as any });
    expect(withZero.cases).toBe(whole.cases - 1); // the day with a zero open is no case (it divided by 0 before)
    expect(Number.isFinite(withZero.rate!)).toBe(true);
  });
});

describe("A corrupt position stored before step 0.3 is reported, never valued, and suspends what depends on the total", () => {
  /** A portfolio as the old broker left it after a buy at 0.004 EUR: price 0, quantity Infinity, average cost 0, an Infinity snapshot. */
  function legacy(): AutomatonDatabase {
    const db = funded();
    trade(db, 1, "BTC", 60_000, buy(100, 60_000));
    const at = isoSeconds(hours(2));
    db.raw.prepare(`INSERT INTO trader_orders (id, placed_at, asset, side, kind, amount_eur, quantity, limit_price, thesis, probability, invalidation, horizon_until, hypothesis_ids, origin, status, settled_at, fill_price, fill_quantity, fill_eur, fee_eur, slippage_eur)
      VALUES ('o_legacy', ?, 'PUMP', 'buy', 'market', 100, NULL, NULL, ?, NULL, 0.0028, ?, '[]', 'model', 'filled', ?, 0, 9e999, 100, 0.8, -9e999)`).run(at, THESIS, isoSeconds(hours(200)), at);
    db.raw.prepare("INSERT INTO trader_ledger (id, at, kind, asset, quantity, price, amount_eur, fee_eur, order_id, note) VALUES ('l_legacy', ?, 'buy', 'PUMP', 9e999, 0, -100, 0.8, 'o_legacy', NULL)").run(at);
    db.raw.prepare("INSERT INTO trader_positions (asset, quantity, avg_cost, opened_at, open_order_id, invalidation, horizon_until, thesis, updated_at) VALUES ('PUMP', 9e999, 0, ?, 'o_legacy', 0.0028, ?, ?, ?)").run(at, isoSeconds(hours(3)), THESIS, at);
    db.raw.prepare("INSERT INTO trader_portfolio_days (day, at, cash_eur, positions_eur, equity_eur, contributed_eur) VALUES ('2026-10-08', ?, 800, 9e999, 9e999, 1000)").run(isoSeconds(hours(16)));
    storePrice(db, "PUMP", hours(2), 0.004);
    return db;
  }

  it("the total is unknown, the position is named, and no partial figure is shown as the value", () => {
    const db = legacy();
    const v = valuation(db.raw);
    expect(v).toMatchObject({ complete: false, invalid: [{ asset: "PUMP", problem: "quantity" }] });
    expect(Number.isNaN(v.equityEur) && Number.isNaN(v.positionsEur) && Number.isNaN(v.pnlEur)).toBe(true);
    expect(v.positions.map((p) => p.asset)).toEqual(["BTC"]);
    const views = [
      formatPortfolioFr(db.raw, TRADER, hours(2.5)),
      formatSonniStatus(db.raw, TRADER, hours(2.5)),
      buildSonniEveningSummary(db.raw, TRADER, null, hours(2.5)),
      buildMemoryPack(db.raw, TRADER, hours(2.5)),
      formatSelfReport(selfReport(db.raw, TRADER, 193, hours(2.5))),
      formatSelfReportFr(selfReport(db.raw, TRADER, 193, hours(2.5))),
    ];
    for (const text of views) expect(text).not.toMatch(BROKEN);
    expect(views[0]).toContain("⚠️ Valeur non fiable, total inconnu : impossible d'évaluer la position PUMP (quantité non finie ou invalide) : la valeur totale et le plafond par position sont inconnus.");
    expect(views[0]).toContain("PUMP : chiffres invalides (quantité non finie ou invalide), non évaluée ; ni vendue ni stoppée par le code");
    expect(views[0]).not.toMatch(/^Valeur \d/m);
    expect(views[2]).toContain("valeur non fiable, total inconnu");
    expect(views[3]).toContain("PORTFOLIO VALUE UNKNOWN: the stored PUMP position (its quantity is not a finite positive number) cannot be valued");
    expect(views[4]).toContain("Portfolio: value UNKNOWN");
    expect(views[5]).toContain("Rendement après frais : inconnu");
    const lab = applyMoneyLabProfile(createTestConfig({ moneyLab: { ...EXAMPLE.moneyLab, runtime: "conway", telegram: null }, trader: EXAMPLE.trader, logLevel: "error" } as any) as AutomatonConfig).moneyLab!;
    expect(buildSonniPromptBlock(db.raw, lab, TRADER, {})).toContain("total value UNKNOWN (PUMP cannot be valued: buys and decisions are suspended");
    db.close();
  });

  it("buys and decisions are suspended; the valid position can still be sold and stopped; no snapshot is stored", () => {
    const db = legacy();
    storePrice(db, "BTC", hours(3), 60_000);
    storePrice(db, "ETH", hours(3), 2_000);
    storePrice(db, "PUMP", hours(3), 0.004);
    const refused = placeOrder(db.raw, TRADER, { asset: "ETH", side: "buy", amountEur: 50, invalidation: 1_000, thesis: THESIS }, hours(3));
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining("Buying is suspended: the stored PUMP position") });
    expect(placeOrder(db.raw, TRADER, { asset: "PUMP", side: "sell", quantity: "all", thesis: THESIS }, hours(3)))
      .toMatchObject({ ok: false, error: expect.stringContaining("No sale: the stored PUMP position cannot be used") });
    expect(recordDecision(db.raw, TRADER, { asset: "BTC", action: "hold", reason: "Je garde ma position BTC : rien de neuf depuis ce matin." }, hours(3)))
      .toMatchObject({ ok: false, error: expect.stringContaining("Decisions are suspended") });
    expect(decisionsDue(db.raw, TRADER, hours(3))).toEqual([]); // no paid turn asked for a decision it cannot record
    expect(decisionsPackLines(db.raw, TRADER, hours(3)).join("\n")).toContain("Decisions are suspended");
    // A sell order left pending on PUMP by the old code is rejected, not filled from Infinity.
    db.raw.prepare(`INSERT INTO trader_orders (id, placed_at, asset, side, kind, amount_eur, quantity, limit_price, thesis, probability, invalidation, horizon_until, hypothesis_ids, origin, status)
      VALUES ('o_pending', ?, 'PUMP', 'sell', 'market', NULL, 1000, NULL, ?, NULL, NULL, ?, '[]', 'model', 'pending')`).run(isoSeconds(hours(3)), THESIS, isoSeconds(hours(100)));
    // The BTC stop still works: price below its 42,000 invalidation, a day with no snapshot yet (2026-10-09).
    storePrice(db, "BTC", hours(50), 41_000);
    storePrice(db, "PUMP", hours(50), 0.002); // below PUMP's stored level: no stop on a position code cannot value
    const tick = brokerTick(db.raw, TRADER, hours(50));
    expect(tick.rejected.map((o) => o.note)).toEqual([expect.stringMatching(/^rejected by code \(position\)/)]);
    expect(tick.stops.map((o) => o.asset)).toEqual(["BTC"]);
    expect(tick.snapshot).toBe(false);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM trader_portfolio_days WHERE day = '2026-10-09'").get()).toEqual({ n: 0 });
    storePrice(db, "BTC", hours(50.1), 41_000);
    expect(brokerTick(db.raw, TRADER, hours(50.1)).fills[0].trade!.asset).toBe("BTC");
    const incidents = listIncidents(db.raw).filter((i) => i.message.startsWith("position PUMP invalide"));
    expect(incidents).toHaveLength(1); // once a day, not at every tick
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM trader_orders WHERE asset = 'PUMP' AND status = 'pending'").get()).toEqual({ n: 0 }); // no code stop on it
    db.close();
  });

  it("an old stop and an old buy left pending are rejected without touching the stored position; no paid wake, no management", () => {
    const db = legacy();
    // What the old code left when PUMP's stop triggered: the level cleared by code and a sale of Infinity units pending.
    db.raw.prepare("UPDATE trader_positions SET invalidation = NULL WHERE asset = 'PUMP'").run();
    db.raw.prepare("INSERT INTO trader_position_updates (id, asset, at, field, old_value, new_value, reason, by) VALUES ('u_old', 'PUMP', ?, 'invalidation', '0.0028', NULL, 'stop triggered', 'code')").run(isoSeconds(hours(2.5)));
    const pending = (id: string, side: string, extra: string) => db.raw.prepare(`INSERT INTO trader_orders (id, placed_at, asset, side, kind, amount_eur, quantity, limit_price, thesis, probability, invalidation, horizon_until, hypothesis_ids, origin, status)
      VALUES (?, ?, ?, ?, ?, ${extra}, ?, NULL, NULL, ?, '[]', ?, 'pending')`).run(id, isoSeconds(hours(2.5)), side === "sell" ? "PUMP" : "ETH", side, side === "sell" ? "market" : "limit", THESIS, isoSeconds(hours(200)), side === "sell" ? "stop" : "model");
    pending("o_oldstop", "sell", "NULL, 9e999, NULL");
    pending("o_oldbuy", "buy", "290, NULL, 1900"); // the old cap was computed against an infinite total
    const dump = () => JSON.stringify([db.raw.prepare("SELECT * FROM trader_positions WHERE asset = 'PUMP'").all(), db.raw.prepare("SELECT * FROM trader_position_updates").all()]);
    const before = dump();
    storePrice(db, "PUMP", hours(3), 0.0025);
    storePrice(db, "ETH", hours(3), 1_850);
    const out = brokerTick(db.raw, TRADER, hours(3));
    expect(out.rejected.map((o) => [o.id, o.note!.split(":")[0]]).sort()).toEqual([["o_oldbuy", "rejected by code (suspended)"], ["o_oldstop", "rejected by code (position)"]]);
    expect(out.fills).toEqual([]);
    expect(getPosition(db.raw, "ETH")).toBeUndefined();
    expect(dump()).toBe(before); // no level "restored" on a position code cannot value
    const messages = listIncidents(db.raw).map((i) => i.message);
    expect(messages.some((m) => m.includes("stop de PUMP refusé : la position enregistrée a des chiffres invalides, aucun stop possible"))).toBe(true);
    expect(messages.some((m) => m.includes("rétabli"))).toBe(false);
    expect(messages.some((m) => m.includes("achats suspendus tant qu'une position enregistrée ne peut pas être évaluée"))).toBe(true);
    // No paid wake for the horizon of a position that can be neither sold nor managed.
    expect(evaluateTriggers(db.raw, TRADER, hours(4)).map((t) => t.key).filter((k) => k.startsWith("horizon:PUMP"))).toEqual([]);
    expect(updatePosition(db.raw, TRADER, { asset: "PUMP", field: "invalidation", value: 0.002, reason: "Je protège la position avec un stop plus bas." }, hours(4)))
      .toMatchObject({ ok: false, error: expect.stringContaining("The stored PUMP position cannot be used") });
    db.close();
  });

  it("an old decision stored with an infinite portfolio value gives the second brain no share figure", () => {
    const db = legacy();
    db.raw.prepare("INSERT INTO trader_decisions (id, made_at, asset, action, reason, price, position_eur, equity_eur, order_id) VALUES ('d_old', ?, 'BTC', 'hold', 'Je garde le BTC : la position fait 10 % du portefeuille.', 60000, 100, 9e999, NULL)").run(isoSeconds(hours(2.5)));
    const subject = consistencySubject(db.raw, TRADER, "decision", "d_old")!;
    expect(subject.facts.map((f) => f.role)).not.toContain("share");
    db.close();
  });

  it("the legacy rows stay as stored; readers skip what they cannot use", () => {
    const db = legacy();
    const dump = () => JSON.stringify(["trader_ledger", "trader_orders", "trader_positions", "trader_portfolio_days"].map((t) =>
      db.raw.prepare(`SELECT * FROM ${t} WHERE ${t === "trader_portfolio_days" ? "day = '2026-10-08'" : "asset = 'PUMP'"}`).all()));
    const before = dump();
    storePrice(db, "BTC", hours(30), 60_000);
    brokerTick(db.raw, TRADER, hours(30));
    expect(dump()).toBe(before);
    expect(snapshots(db.raw).map((s) => s.day)).not.toContain("2026-10-08");
    const perf = performance(db.raw, TRADER, 0, hours(30));
    expect(perf).toMatchObject({ complete: false, change7dPct: null, selfFundingRatio: null });
    const day = summarize(db.raw, TRADER, "day", "2026-10-09", "2026-10-10");
    if (day) expect(day.content).not.toMatch(BROKEN);
    db.raw.prepare("INSERT INTO trader_portfolio_days (day, at, cash_eur, positions_eur, equity_eur, contributed_eur) VALUES ('2026-10-06', ?, 1000, 0, 1000, 1000)").run(isoSeconds(hours(-30)));
    const week = summarize(db.raw, TRADER, "day", "2026-10-08", "2026-10-09");
    expect(week?.content ?? "").not.toMatch(BROKEN);
    db.close();
  });
});

describe("Small prices are readable for the owner and the model (prices from 1 EUR unchanged)", () => {
  it("formats below 1 EUR with at least 5 significant digits, never an exponent", () => {
    const cases: [number, string, string][] = [
      [95_171.011725, "95 171,01 €", "95171.01"], [60_130.05, "60 130,05 €", "60130.05"], [2_301.15, "2 301,15 €", "2301.15"], [12.3456, "12,35 €", "12.35"],
      [1, "1,00 €", "1.00"], [0.86043, "0,86043 €", "0.86043"], [0.2001, "0,2001 €", "0.2001"], [0.0123, "0,0123 €", "0.0123"],
      [0.0048874425, "0,0048874 €", "0.0048874"], [0.000010005, "0,000010005 €", "0.000010005"], [3.483741e-6, "0,0000034837 €", "0.0000034837"], [7.7e-8, "0,000000077 €", "0.000000077"],
    ];
    for (const [v, fr, en] of cases) {
      expect(fmtPrice(v).replace(/ /g, " ")).toBe(fr);
      expect(priceEn(v)).toBe(en);
      if (v >= 1) expect(fmtPrice(v)).toBe(fmtEur(v));
    }
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(fmtPrice(bad)).toBe("n.d.");
      expect(fmtEur(bad)).toBe("n.d.");
      expect(priceEn(bad)).toBe("n/a");
    }
    expect(plainPrice(7.7e-8)).toBe("0.000000077");
    expect(describeWatch({ id: "w_1", kind: "price", asset: "MOG", direction: "below", value: 9.5e-7, windowHours: null, dueAt: null, note: "test" } as any)).toBe("w_1 [price] MOG below 0.00000095 EUR — test");
    const fact = (value: number) => ({ key: "F1", role: "price", labelEn: "price", labelFr: "prix", value, unit: "eur", signed: false }) as any;
    expect(factValueFr(fact(0.0048874))).toBe("0,0048874 €");
    expect(factValueFr(fact(61_650.12))).toBe("61 650,12 €");
    expect(factValueFr(fact(0.8))).toBe("0,80 €");
    // Through code's fact sheet: a decision on PUMP keeps its price (4 decimals made it 0.0049, and 3.5e-6 became 0).
    const db = funded();
    storePrice(db, "PUMP", hours(1), 0.004885);
    const d = recordDecision(db.raw, TRADER, { asset: "PUMP", action: "stay_out", reason: "Je reste en dehors de PUMP : trop peu d'historique pour juger." }, hours(1));
    expect(d.ok).toBe(true);
    const facts = consistencySubject(db.raw, TRADER, "decision", (d as any).value.id)!.facts;
    expect(facts.find((f) => f.role === "price")!.value).toBe(0.004885);
    db.close();
    expect(plainPrice(0.0048874425)).toBe("0.0048874425");
    expect(plainPrice(55_000)).toBe("55000");
    expect(qtyText(1e-8)).toBe("0.00000001"); // dust left by a partial sale, never "1e-8"
    expect(qtyText(28475136.35485532)).toBe("28475136.35485532");
    expect(qtyText(9e999)).toBe("n.d.");
  });

  it("/portefeuille, /statut, the evening summary and the pack show PUMP's real price; BTC lines keep their text", () => {
    const db = funded();
    trade(db, 1, "BTC", 60_000, buy(100, 60_000));
    trade(db, 2, "PUMP", 0.004885, buy(100, 0.004885));
    const fr = formatPortfolioFr(db.raw, TRADER, hours(2.5));
    expect(fr).toMatch(/PUMP : 20296\.91397904 \(.*\) acheté 0,0048874 €, stop 0,0034195 €/);
    expect(fr).toMatch(/BTC : 0\.00165251 \(.*\) acheté 60\s029,89 €, stop 42\s000,00 €/); // as before step 0.3
    expect(formatSonniStatus(db.raw, TRADER, hours(2.5))).toContain("PUMP 0,004885 €");
    const pack = buildMemoryPack(db.raw, TRADER, hours(2.5));
    expect(pack).toContain("- PUMP: 0.004885 EUR at");
    expect(pack).toContain("at avg 0.0048874 EUR, now 0.004885 EUR");
    expect(pack).toContain("at avg 60029.89 EUR");
    for (const text of [fr, pack, buildSonniEveningSummary(db.raw, TRADER, null, hours(2.5))]) expect(text).not.toMatch(BROKEN);
    db.close();
  });
});

describe("Read-only price audit of a database copy (sonni/vps/audit-prix.mjs)", () => {
  const SCRIPT = path.join(ROOT, "sonni", "vps", "audit-prix.mjs");
  const run = (file: string) => spawnSync(process.execPath, [SCRIPT, file], { encoding: "utf-8", env: { ...process.env, HOME: tmp("sonni-audit-home-") } });
  const sha = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

  /** A closed copy holding what the old broker could leave: an Infinity position and a USDC average rounded to the cent. */
  function seededCopy(): string {
    const file = path.join(tmp("sonni-audit-"), "state.db.backup-2026-10-09");
    const db = openDb(file);
    storePrice(db, "BTC", T0, 60_000);
    brokerTick(db.raw, TRADER, T0);
    const at = isoSeconds(hours(2));
    db.raw.prepare("INSERT INTO trader_ledger (id, at, kind, asset, quantity, price, amount_eur, fee_eur, order_id, note) VALUES ('l_pump', ?, 'buy', 'PUMP', 9e999, 0, -100, 0.8, 'o_pump', NULL)").run(at);
    db.raw.prepare("INSERT INTO trader_positions (asset, quantity, avg_cost, opened_at, open_order_id, invalidation, horizon_until, thesis, updated_at) VALUES ('PUMP', 9e999, 0, ?, 'o_pump', NULL, NULL, ?, ?)").run(at, THESIS, at);
    // USDC: 100 EUR at 0.86 (115.34883721 units), then 50 EUR at 0.87 (57.01149425 units); the old average was rounded to 0.86.
    db.raw.prepare("INSERT INTO trader_ledger (id, at, kind, asset, quantity, price, amount_eur, fee_eur, order_id, note) VALUES ('l_u1', ?, 'buy', 'USDC', 115.34883721, 0.86, -100, 0.8, 'o_u1', NULL)").run(isoSeconds(hours(3)));
    db.raw.prepare("INSERT INTO trader_ledger (id, at, kind, asset, quantity, price, amount_eur, fee_eur, order_id, note) VALUES ('l_u2', ?, 'buy', 'USDC', 57.01149425, 0.87, -50, 0.4, 'o_u2', NULL)").run(isoSeconds(hours(4)));
    db.raw.prepare("INSERT INTO trader_positions (asset, quantity, avg_cost, opened_at, open_order_id, invalidation, horizon_until, thesis, updated_at) VALUES ('USDC', 172.36033146, 0.86, ?, 'o_u1', NULL, NULL, ?, ?)").run(isoSeconds(hours(3)), THESIS, isoSeconds(hours(4)));
    // SPY at 12.35 then 12.90 (an average above 10 EUR rounded to the cent drifts too): 8.03238866 + 7.68992248 units.
    db.raw.prepare("INSERT INTO trader_ledger (id, at, kind, asset, quantity, price, amount_eur, fee_eur, order_id, note) VALUES ('l_s1', ?, 'buy', 'SPY', 8.03238866, 12.35, -100, 0.8, 'o_s1', NULL)").run(isoSeconds(hours(5)));
    db.raw.prepare("INSERT INTO trader_ledger (id, at, kind, asset, quantity, price, amount_eur, fee_eur, order_id, note) VALUES ('l_s2', ?, 'buy', 'SPY', 7.68992248, 12.9, -100, 0.8, 'o_s2', NULL)").run(isoSeconds(hours(6)));
    db.raw.prepare("INSERT INTO trader_positions (asset, quantity, avg_cost, opened_at, open_order_id, invalidation, horizon_until, thesis, updated_at) VALUES ('SPY', 15.72231114, ?, ?, 'o_s1', NULL, NULL, ?, ?)").run(Math.round((198.4 / 15.72231114) * 100) / 100 + 0.01, isoSeconds(hours(5)), THESIS, isoSeconds(hours(6)));
    db.close();
    return file;
  }

  it("reports invalid rows and averaged drifts, and leaves the copy byte for byte unchanged", () => {
    const file = seededCopy();
    const before = sha(file);
    const r = run(file);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("Audit des prix — copie en lecture seule");
    expect(r.stdout).toMatch(/1 ligne du registre :\n  · l_pump buy PUMP .* quantité non finie, prix 0,00 €/);
    expect(r.stdout).toMatch(/1 position ouverte :\n  · PUMP : quantité non finie, coût moyen 0,00 €/);
    expect(r.stdout).toMatch(/USDC : 2 achats, coût moyen enregistré 0,86 € contre 0,8633\d* € d'après le registre, écart -0,57 € sur la position/);
    expect(r.stdout).toMatch(/SPY : 2 achats, coût moyen enregistré 12,63 € contre 12,62 € d'après le registre, écart 0,17 € sur la position/);
    expect(r.stdout).toContain("4 points à examiner. Rien n'a été modifié");
    expect(r.stdout).toContain("Fichier audité inchangé (SHA-256 identique avant et après).");
    expect(sha(file)).toBe(before);
  });

  it("finds nothing to repair in a copy written by the new broker", () => {
    const file = path.join(tmp("sonni-audit-"), "state.db.backup-2026-10-10");
    const db = openDb(file);
    storePrice(db, "BTC", T0, 60_000);
    brokerTick(db.raw, TRADER, T0);
    trade(db, 1, "USDC", 0.86, buy(100, 0.86));
    trade(db, 2, "USDC", 0.869, buy(50, 0.869));
    trade(db, 3, "PUMP", 0.004885, buy(100, 0.004885));
    db.close();
    const r = run(file);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("1. Chiffres invalides (prix nul, quantité nulle ou infinie, montant infini)\n- aucun");
    expect(r.stdout).toMatch(/USDC : 2 achats, .* écart 0,00 € sur la position/);
    expect(r.stdout).toContain("Conclusion : rien à réparer dans cette copie.");
  });

  it("replays an averaged position from its own opening order, not the previous position's sale in the same tick", () => {
    const file = path.join(tmp("sonni-audit-"), "state.db.backup-2026-10-11");
    const db = openDb(file);
    storePrice(db, "BTC", T0, 60_000);
    brokerTick(db.raw, TRADER, T0);
    trade(db, 1, "USDC", 0.86, buy(100, 0.86));
    // A sale of everything and a new buy filled at the same price point: the new position opens at the sale's time.
    storePrice(db, "USDC", hours(2), 0.87);
    expect(placeOrder(db.raw, TRADER, { asset: "USDC", side: "sell", quantity: "all", thesis: THESIS }, hours(2)).ok).toBe(true);
    expect(placeOrder(db.raw, TRADER, { asset: "USDC", thesis: THESIS, ...buy(50, 0.87) } as any, hours(2.01)).ok).toBe(true);
    storePrice(db, "USDC", hours(2.1), 0.87);
    brokerTick(db.raw, TRADER, hours(2.1));
    trade(db, 3, "USDC", 0.88, buy(30, 0.88));
    db.close();
    const r = run(file);
    expect(r.stdout).toMatch(/USDC : 2 achats, .* écart 0,00 € sur la position\n/);
    expect(r.stdout).toContain("Conclusion : rien à réparer dans cette copie.");
  });

  it("leaves no copy behind in the temporary folder", () => {
    const file = seededCopy();
    const tmpRoot = tmp("sonni-audit-tmp-");
    const r = spawnSync(process.execPath, [SCRIPT, file], { encoding: "utf-8", env: { ...process.env, HOME: tmp("sonni-audit-home-"), TMPDIR: tmpRoot } });
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readdirSync(tmpRoot)).toEqual([]);
  });

  it("refuses the active database: state.db, a file with -wal or -shm beside it, or ~/.automaton/state.db", () => {
    const dir = tmp("sonni-audit-live-");
    const live = path.join(dir, "state.db");
    openDb(live).close();
    const r1 = run(live);
    expect(r1.status).toBe(2);
    expect(r1.stderr).toContain("Refusé : c'est la base active de Sonni");
    const copy = path.join(dir, "copie.db");
    fs.copyFileSync(live, copy);
    fs.writeFileSync(`${copy}-wal`, "");
    const r2 = run(copy);
    expect(r2.status).toBe(2);
    expect(r2.stderr).toContain("un fichier -wal ou -shm est à côté");
    fs.rmSync(`${copy}-wal`);
    fs.writeFileSync(`${copy}-shm`, "");
    expect(run(copy).stderr).toContain("un fichier -wal ou -shm est à côté");
    const home = tmp("sonni-audit-home-");
    fs.mkdirSync(path.join(home, ".automaton"));
    fs.copyFileSync(live, path.join(home, ".automaton", "state.db"));
    const linked = path.join(dir, "lien.db");
    fs.linkSync(path.join(home, ".automaton", "state.db"), linked);
    const r3 = spawnSync(process.execPath, [SCRIPT, linked], { encoding: "utf-8", env: { ...process.env, HOME: home } });
    expect(r3.status).toBe(2);
    expect(r3.stderr).toContain("Refusé : c'est la base active de Sonni");
    const symlink = path.join(dir, "raccourci.db");
    fs.symlinkSync(path.join(home, ".automaton", "state.db"), symlink);
    const r4 = spawnSync(process.execPath, [SCRIPT, symlink], { encoding: "utf-8", env: { ...process.env, HOME: home } });
    expect(r4.status).toBe(2);
    expect(r4.stderr).toContain("Refusé : c'est la base active de Sonni");
    expect(run(path.join(dir, "absent.db")).status).toBe(2);
  });
});
