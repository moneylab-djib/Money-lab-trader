/**
 * Sonni asset universe (docs/MEMORY.md section 3.2 `universe`, step 3)
 *
 * The owner's config lists the starting assets; Sonni may follow more
 * Kraken EUR pairs and stop following some, each change with a reason in
 * an append-only log (decision 0003: it chooses its assets, and its
 * choices can be reviewed). A pair is accepted only if Kraken's public
 * AssetPairs list has it quoted in EUR, so a typo cannot create an asset
 * without prices. The followed set is the config plus the log, replayed
 * in order; everything that reads cfg.assets at runtime goes through
 * activeConfig().
 */

import type Database from "better-sqlite3";
import { ulid } from "ulid";
import { getKV, setKV } from "../money-lab/journal.js";
import { containsInjectionPatterns } from "../soul/validator.js";
import { PAIR, SYMBOL, type TraderAsset, type TraderConfig } from "./config.js";
import type { SoulResult } from "./soul.js";

type DB = Database.Database;
type FetchFn = typeof fetch;

export const KRAKEN_ASSET_PAIRS_URL = "https://api.kraken.com/0/public/AssetPairs";
export const MAX_FOLLOWED_ASSETS = 30;
const PAIRS_CACHE_HOURS = 24;
const KV_PAIRS = "sonni.kraken_eur_pairs";
const REASON_MAX = 300;
const FETCH_TIMEOUT_MS = 20_000;

export interface UniverseEntry {
  id: string;
  asset: string;
  krakenPair: string;
  action: "follow" | "unfollow";
  reason: string;
  recordedAt: string;
}

function rowToEntry(row: any): UniverseEntry {
  return { id: row.id, asset: row.asset, krakenPair: row.kraken_pair, action: row.action, reason: row.reason, recordedAt: row.recorded_at };
}

export function universeLog(db: DB, limit = 50): UniverseEntry[] {
  return (db.prepare("SELECT * FROM trader_universe ORDER BY recorded_at DESC, id DESC LIMIT ?").all(limit) as any[]).map(rowToEntry);
}

/** Config assets, then the log replayed in order; a config asset can be unfollowed too (at least one stays). */
export function activeAssets(db: DB, cfg: TraderConfig): TraderAsset[] {
  const assets = new Map<string, TraderAsset>(cfg.assets.map((a) => [a.symbol, a]));
  const rows = db.prepare("SELECT * FROM trader_universe ORDER BY recorded_at ASC, id ASC").all() as any[];
  for (const row of rows.map(rowToEntry)) {
    if (row.action === "follow") assets.set(row.asset, { symbol: row.asset, krakenPair: row.krakenPair });
    else assets.delete(row.asset);
  }
  return assets.size > 0 ? [...assets.values()] : [...cfg.assets];
}

/** The configuration with the followed assets of the moment. */
export function activeConfig(db: DB, cfg: TraderConfig): TraderConfig {
  return { ...cfg, assets: activeAssets(db, cfg) };
}

export interface KrakenEurPair {
  /** Kraken "altname", e.g. XBTEUR. */
  altname: string;
  /** Base asset as shown in wsname, e.g. XBT. */
  base: string;
}

/** Kraken's EUR spot pairs, cached in the database for a day. */
export async function krakenEurPairs(db: DB, fetchFn: FetchFn = fetch, now: Date = new Date()): Promise<KrakenEurPair[]> {
  const cached = getKV(db, KV_PAIRS);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as { at: string; pairs: KrakenEurPair[] };
      if (now.getTime() - Date.parse(parsed.at) < PAIRS_CACHE_HOURS * 3_600_000 && Array.isArray(parsed.pairs)) return parsed.pairs;
    } catch {
      // stale or malformed cache: refetch
    }
  }
  const resp = await fetchFn(KRAKEN_ASSET_PAIRS_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`Kraken AssetPairs: HTTP ${resp.status}`);
  const data = (await resp.json()) as { error?: string[]; result?: Record<string, any> };
  if (data.error && data.error.length > 0) throw new Error(`Kraken AssetPairs: ${data.error.join(", ")}`);
  const pairs: KrakenEurPair[] = [];
  for (const p of Object.values(data.result ?? {})) {
    const altname = String(p?.altname ?? "");
    const quote = String(p?.quote ?? "");
    const status = p?.status === undefined ? "online" : String(p.status);
    if ((quote === "ZEUR" || quote === "EUR") && status === "online" && PAIR.test(altname)) {
      const ws = String(p?.wsname ?? "");
      pairs.push({ altname, base: ws.includes("/") ? ws.split("/")[0] : altname.replace(/EUR$/, "") });
    }
  }
  if (pairs.length === 0) throw new Error("Kraken AssetPairs: no EUR pair in the answer");
  setKV(db, KV_PAIRS, JSON.stringify({ at: now.toISOString(), pairs }));
  return pairs;
}

/** Plain text the owner reads in /actifs: no prompt-boundary tricks. */
function cleanReason(raw: unknown): string | null {
  const text = String(raw ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (text.length < 10 || text.length > REASON_MAX || containsInjectionPatterns(text)) return null;
  return text;
}

export async function followAsset(
  db: DB,
  cfg: TraderConfig,
  input: { symbol: unknown; krakenPair: unknown; reason: unknown },
  fetchFn: FetchFn = fetch,
  now: Date = new Date(),
): Promise<SoulResult<UniverseEntry>> {
  const symbol = String(input.symbol ?? "").trim().toUpperCase();
  const pair = String(input.krakenPair ?? "").trim().toUpperCase();
  const reason = cleanReason(input.reason);
  if (!SYMBOL.test(symbol)) return { ok: false, error: "symbol must be 2 to 10 capital letters or digits, e.g. SOL." };
  if (!PAIR.test(pair)) return { ok: false, error: "kraken_pair must be a Kraken pair name, e.g. SOLEUR." };
  if (!reason) return { ok: false, error: `reason must be 10 to ${REASON_MAX} characters: why this asset is worth following.` };
  const current = activeAssets(db, cfg);
  if (current.some((a) => a.symbol === symbol)) return { ok: false, error: `${symbol} is already followed.` };
  if (current.length >= MAX_FOLLOWED_ASSETS) return { ok: false, error: `${MAX_FOLLOWED_ASSETS} assets are followed; unfollow one first.` };
  if (current.some((a) => a.krakenPair === pair)) return { ok: false, error: `Pair ${pair} is already followed under another symbol.` };
  let pairs: KrakenEurPair[];
  try {
    pairs = await krakenEurPairs(db, fetchFn, now);
  } catch (err: any) {
    return { ok: false, error: `Could not check the pair with Kraken: ${String(err?.message ?? err).slice(0, 120)}. Try again later.` };
  }
  const found = pairs.find((p) => p.altname === pair);
  if (!found) {
    const hint = pairs.filter((p) => p.base.startsWith(symbol.slice(0, 3))).slice(0, 5).map((p) => p.altname);
    return { ok: false, error: `Kraken has no EUR pair named ${pair}.${hint.length ? ` Close names: ${hint.join(", ")}.` : ""}` };
  }
  const id = `u_${ulid()}`;
  db.prepare(
    "INSERT INTO trader_universe (id, asset, kraken_pair, action, reason, recorded_at) VALUES (?, ?, ?, 'follow', ?, ?)",
  ).run(id, symbol, pair, reason, now.toISOString());
  return { ok: true, value: rowToEntry(db.prepare("SELECT * FROM trader_universe WHERE id = ?").get(id)) };
}

export function unfollowAsset(
  db: DB,
  cfg: TraderConfig,
  input: { symbol: unknown; reason: unknown },
  now: Date = new Date(),
): SoulResult<UniverseEntry> {
  const symbol = String(input.symbol ?? "").trim().toUpperCase();
  const reason = cleanReason(input.reason);
  if (!reason) return { ok: false, error: `reason must be 10 to ${REASON_MAX} characters.` };
  const current = activeAssets(db, cfg);
  const asset = current.find((a) => a.symbol === symbol);
  if (!asset) return { ok: false, error: `${symbol || "(none)"} is not followed.` };
  if (current.length <= 1) return { ok: false, error: "At least one asset must stay followed." };
  const open = (db.prepare("SELECT COUNT(*) AS n FROM trader_predictions WHERE asset = ? AND resolved_at IS NULL").get(symbol) as { n: number }).n;
  if (open > 0) return { ok: false, error: `${symbol} has ${open} open prediction(s); wait for them to resolve.` };
  const id = `u_${ulid()}`;
  db.prepare(
    "INSERT INTO trader_universe (id, asset, kraken_pair, action, reason, recorded_at) VALUES (?, ?, ?, 'unfollow', ?, ?)",
  ).run(id, symbol, asset.krakenPair, reason, now.toISOString());
  return { ok: true, value: rowToEntry(db.prepare("SELECT * FROM trader_universe WHERE id = ?").get(id)) };
}

const KV_CONFIG_ASSETS = "sonni.config_assets";

/**
 * The owner's config stays authoritative: at startup, an asset the owner
 * added to the config since the last start is followed, and one the owner
 * removed is unfollowed, each as a new log entry (the newest event wins in
 * the replay). The first start only records the config. An asset removed
 * while it has open predictions keeps being followed (a log entry says
 * why) until they resolve, so they are not voided for lack of prices; the
 * removal is retried at each start. Returns French lines for the log.
 */
export function syncConfigAssets(db: DB, cfg: TraderConfig, now: Date = new Date()): string[] {
  const raw = getKV(db, KV_CONFIG_ASSETS);
  if (raw === undefined) {
    setKV(db, KV_CONFIG_ASSETS, JSON.stringify(cfg.assets));
    return [];
  }
  let previous: TraderAsset[] = [];
  try {
    const parsed = JSON.parse(raw);
    previous = Array.isArray(parsed) ? parsed.filter((a) => a && typeof a.symbol === "string" && typeof a.krakenPair === "string") : [];
  } catch {
    previous = [];
  }
  const notes: string[] = [];
  const recorded = new Map(previous.map((a) => [a.symbol, a]));
  const insert = db.prepare(
    "INSERT INTO trader_universe (id, asset, kraken_pair, action, reason, recorded_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const asset of cfg.assets) {
    if (recorded.has(asset.symbol)) continue;
    insert.run(`u_${ulid()}`, asset.symbol, asset.krakenPair, "follow", "ajouté par le propriétaire dans la configuration", now.toISOString());
    recorded.set(asset.symbol, asset);
    notes.push(`${asset.symbol} suivi (ajouté dans la configuration)`);
  }
  for (const prev of previous) {
    if (cfg.assets.some((a) => a.symbol === prev.symbol)) continue;
    const active = activeAssets(db, cfg);
    const isActive = active.some((a) => a.symbol === prev.symbol);
    const open = (db.prepare("SELECT COUNT(*) AS n FROM trader_predictions WHERE asset = ? AND resolved_at IS NULL").get(prev.symbol) as { n: number }).n;
    if (open > 0) {
      if (!isActive) {
        insert.run(`u_${ulid()}`, prev.symbol, prev.krakenPair, "follow", "retiré de la configuration ; suivi jusqu'à la résolution de ses prédictions ouvertes", now.toISOString());
      }
      notes.push(`${prev.symbol} retiré de la configuration mais encore suivi (${open} prédiction(s) ouverte(s)) ; nouvel essai au prochain démarrage`);
      continue;
    }
    if (isActive) {
      if (active.length <= 1) {
        notes.push(`${prev.symbol} retiré de la configuration mais encore suivi (dernier actif) ; nouvel essai au prochain démarrage`);
        continue;
      }
      insert.run(`u_${ulid()}`, prev.symbol, prev.krakenPair, "unfollow", "retiré par le propriétaire de la configuration", now.toISOString());
    }
    recorded.delete(prev.symbol);
    notes.push(`${prev.symbol} n'est plus suivi (retiré de la configuration)`);
  }
  setKV(db, KV_CONFIG_ASSETS, JSON.stringify([...recorded.values()]));
  return notes;
}

/** For the owner (/actifs), in French. */
export function formatUniverseFr(db: DB, cfg: TraderConfig): string {
  const assets = activeAssets(db, cfg);
  const lines = [`Actifs suivis (${assets.length}, au plus ${MAX_FOLLOWED_ASSETS}) : ${assets.map((a) => `${a.symbol} (${a.krakenPair})`).join(", ")}`];
  const log = universeLog(db, 10);
  if (log.length) {
    lines.push("Derniers changements décidés par Sonni :");
    for (const e of log) lines.push(`- ${e.recordedAt.slice(0, 10)} ${e.action === "follow" ? "ajout" : "retrait"} ${e.asset} : ${e.reason}`);
  } else {
    lines.push("Sonni n'a encore ajouté ni retiré aucun actif.");
  }
  return lines.join("\n");
}
