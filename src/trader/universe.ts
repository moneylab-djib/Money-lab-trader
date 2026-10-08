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
import { fetchKrakenLast, FX_PAIR, isTokenizedPair, latestFx, pairQuery, quoteOf, usdToEur } from "./markets.js";
import type { SoulResult } from "./soul.js";

type DB = Database.Database;
type FetchFn = typeof fetch;

export const KRAKEN_ASSET_PAIRS_URL = "https://api.kraken.com/0/public/AssetPairs";
export const MAX_FOLLOWED_ASSETS = 30;
/**
 * Step 2 of the 2026-10-08 plan: the owner's config assets are the core, which only the owner removes;
 * Sonni rotates up to MAX_SATELLITES more, each kept at least SATELLITE_MIN_DAYS, not taken back within
 * REFOLLOW_COOLDOWN_DAYS of dropping it (OWNER_VETO_DAYS after the owner's veto), and only when Kraken's
 * 24 h volume reaches MIN_VOLUME_EUR.
 */
export const MAX_SATELLITES = 3;
export const SATELLITE_MIN_DAYS = 3;
export const REFOLLOW_COOLDOWN_DAYS = 7;
export const OWNER_VETO_DAYS = 30;
export const MIN_VOLUME_EUR = 250_000;
export const OWNER_VETO_REASON = "veto du propriétaire";
const PAIRS_CACHE_HOURS = 24;
const KV_PAIRS = "sonni.kraken_pairs";
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

export interface KrakenPair {
  /** Kraken "altname", e.g. XBTEUR or SPYxUSD. */
  altname: string;
  /** Kraken's own key for the pair in answers, e.g. XXBTZEUR. */
  key: string;
  /** Base asset as shown in wsname, e.g. XBT or SPYx. */
  base: string;
  quote: "EUR" | "USD";
  tokenized: boolean;
}

function parsePairs(result: Record<string, any>, tokenized: boolean): KrakenPair[] {
  const pairs: KrakenPair[] = [];
  for (const [key, p] of Object.entries(result)) {
    const altname = String(p?.altname ?? "");
    const quote = String(p?.quote ?? "");
    const status = p?.status === undefined ? "online" : String(p.status);
    if (status !== "online" || !PAIR.test(altname) || isTokenizedPair(altname) !== tokenized) continue;
    const ws = String(p?.wsname ?? "");
    if (!tokenized && (quote === "ZEUR" || quote === "EUR")) {
      pairs.push({ altname, key, base: ws.includes("/") ? ws.split("/")[0] : altname.replace(/EUR$/, ""), quote: "EUR", tokenized: false });
    } else if (tokenized) {
      pairs.push({ altname, key, base: ws.includes("/") ? ws.split("/")[0] : altname.replace(/(USD|EUR)$/, ""), quote: quoteOf(altname), tokenized: true });
    }
  }
  return pairs;
}

async function fetchAssetPairs(url: string, fetchFn: FetchFn): Promise<Record<string, any>> {
  const resp = await fetchFn(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`Kraken AssetPairs: HTTP ${resp.status}`);
  const data = (await resp.json()) as { error?: string[]; result?: Record<string, any> };
  if (data.error && data.error.length > 0) throw new Error(`Kraken AssetPairs: ${data.error.join(", ")}`);
  return data.result ?? {};
}

/**
 * Kraken's EUR spot pairs and its tokenized stocks (USD-quoted, asset class tokenized_asset), cached in
 * the database for a day. When the tokenized list cannot be read, the spot list is returned uncached.
 */
export async function krakenPairs(db: DB, fetchFn: FetchFn = fetch, now: Date = new Date()): Promise<KrakenPair[]> {
  const cached = getKV(db, KV_PAIRS);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as { at: string; pairs: KrakenPair[] };
      if (now.getTime() - Date.parse(parsed.at) < PAIRS_CACHE_HOURS * 3_600_000 && Array.isArray(parsed.pairs)) return parsed.pairs;
    } catch {
      // stale or malformed cache: refetch
    }
  }
  const spot = parsePairs(await fetchAssetPairs(KRAKEN_ASSET_PAIRS_URL, fetchFn), false);
  if (spot.length === 0) throw new Error("Kraken AssetPairs: no EUR pair in the answer");
  let tokenized: KrakenPair[];
  try {
    tokenized = parsePairs(await fetchAssetPairs(`${KRAKEN_ASSET_PAIRS_URL}?aclass_base=tokenized_asset`, fetchFn), true);
  } catch {
    return spot;
  }
  const pairs = [...spot, ...tokenized];
  setKV(db, KV_PAIRS, JSON.stringify({ at: now.toISOString(), pairs }));
  return pairs;
}

/** The owner's core: the config's assets (only the owner removes them, from the config or with /actifs). */
export function coreSymbols(cfg: TraderConfig): Set<string> {
  return new Set(cfg.assets.map((a) => a.symbol));
}

/** The core as recorded at the last start (syncConfigAssets), for readers that only hold the live config. */
export function recordedCore(db: DB, fallback: TraderConfig): Set<string> {
  try {
    const parsed = JSON.parse(getKV(db, "sonni.config_assets") ?? "null");
    if (Array.isArray(parsed) && parsed.length) return new Set(parsed.map((a: any) => String(a?.symbol ?? "")).filter(Boolean));
  } catch {
    // fall back to the config at hand
  }
  return coreSymbols(fallback);
}

function lastEntry(db: DB, symbol: string, action: "follow" | "unfollow"): UniverseEntry | undefined {
  const row = db.prepare("SELECT * FROM trader_universe WHERE asset = ? AND action = ? ORDER BY recorded_at DESC, id DESC LIMIT 1").get(symbol, action);
  return row ? rowToEntry(row) : undefined;
}

/** Kraken's 24 h volume of a pair in EUR (base volume times the 24 h average price, USD converted). */
export async function volume24hEur(db: DB, pair: string, fetchFn: FetchFn = fetch): Promise<number> {
  const resp = await fetchFn(`https://api.kraken.com/0/public/Ticker?${pairQuery(pair)}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`Kraken ${pair}: HTTP ${resp.status}`);
  const data = (await resp.json()) as { error?: string[]; result?: Record<string, { v?: unknown[]; p?: unknown[] }> };
  if (data.error && data.error.length > 0) throw new Error(`Kraken ${pair}: ${data.error.join(", ")}`);
  const t = Object.values(data.result ?? {})[0];
  const volume = Number(t?.v?.[1]) * Number(t?.p?.[1]);
  if (!Number.isFinite(volume)) throw new Error(`Kraken ${pair}: no volume`);
  if (quoteOf(pair) === "EUR") return volume;
  const fx = latestFx(db)?.eurUsd ?? (await fetchKrakenLast(FX_PAIR, fetchFn));
  return usdToEur(volume, fx);
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
  const asked = String(input.krakenPair ?? "").trim();
  const reason = cleanReason(input.reason);
  if (!SYMBOL.test(symbol)) return { ok: false, error: "symbol must be 2 to 10 capital letters or digits, e.g. SOL." };
  if (!/^[A-Za-z0-9]{4,20}$/.test(asked)) return { ok: false, error: "kraken_pair must be a Kraken pair name, e.g. SOLEUR or NVDAxUSD." };
  if (!reason) return { ok: false, error: `reason must be 10 to ${REASON_MAX} characters: why this asset is worth following.` };
  const current = activeAssets(db, cfg);
  const core = coreSymbols(cfg);
  if (current.some((a) => a.symbol === symbol)) return { ok: false, error: `${symbol} is already followed.` };
  if (current.length >= MAX_FOLLOWED_ASSETS) return { ok: false, error: `${MAX_FOLLOWED_ASSETS} assets are followed; unfollow one first.` };
  const satellites = current.filter((a) => !core.has(a.symbol));
  if (satellites.length >= MAX_SATELLITES) {
    return { ok: false, error: `Your ${MAX_SATELLITES} satellite slots are taken (${satellites.map((a) => a.symbol).join(", ")}); unfollow one first. The core (${[...core].join(", ")}) is the owner's.` };
  }
  const dropped = lastEntry(db, symbol, "unfollow");
  if (dropped) {
    const veto = dropped.reason.startsWith(OWNER_VETO_REASON);
    const days = veto ? OWNER_VETO_DAYS : REFOLLOW_COOLDOWN_DAYS;
    const until = new Date(Date.parse(dropped.recordedAt) + days * 86_400_000);
    if (until > now) {
      return { ok: false, error: `${symbol} was ${veto ? "vetoed by the owner" : "dropped"} on ${dropped.recordedAt.slice(0, 10)}; it can come back after ${until.toISOString().slice(0, 10)}.` };
    }
  }
  let pairs: KrakenPair[];
  try {
    pairs = await krakenPairs(db, fetchFn, now);
  } catch (err: any) {
    return { ok: false, error: `Could not check the pair with Kraken: ${String(err?.message ?? err).slice(0, 120)}. Try again later.` };
  }
  // Pair names are matched without case (SPYXUSD finds SPYxUSD); Kraken's own spelling is kept.
  const found = pairs.find((p) => p.altname.toUpperCase() === asked.toUpperCase());
  if (!found) {
    const hint = pairs.filter((p) => p.base.toUpperCase().startsWith(symbol.slice(0, 3))).slice(0, 5).map((p) => p.altname);
    return { ok: false, error: `Kraken has no EUR pair or tokenized stock named ${asked}.${hint.length ? ` Close names: ${hint.join(", ")}.` : ""}` };
  }
  const pair = found.altname;
  if (current.some((a) => a.krakenPair === pair)) return { ok: false, error: `Pair ${pair} is already followed under another symbol.` };
  let volume: number;
  try {
    volume = await volume24hEur(db, pair, fetchFn);
  } catch (err: any) {
    return { ok: false, error: `Could not read ${pair}'s volume from Kraken: ${String(err?.message ?? err).slice(0, 120)}. Try again later.` };
  }
  if (volume < MIN_VOLUME_EUR) {
    return { ok: false, error: `${pair} is too thin: ${Math.round(volume).toLocaleString("en-US")} EUR traded in 24 h on Kraken (minimum ${MIN_VOLUME_EUR.toLocaleString("en-US")}).` };
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
  if (coreSymbols(cfg).has(symbol)) return { ok: false, error: `${symbol} is in the owner's core; only the owner removes it.` };
  const followed = lastEntry(db, symbol, "follow");
  if (followed && now.getTime() - Date.parse(followed.recordedAt) < SATELLITE_MIN_DAYS * 86_400_000) {
    return { ok: false, error: `${symbol} was followed on ${followed.recordedAt.slice(0, 10)}: keep a satellite at least ${SATELLITE_MIN_DAYS} days before judging it.` };
  }
  const open = (db.prepare("SELECT COUNT(*) AS n FROM trader_predictions WHERE asset = ? AND resolved_at IS NULL").get(symbol) as { n: number }).n;
  if (open > 0) return { ok: false, error: `${symbol} has ${open} open prediction(s); wait for them to resolve.` };
  const id = `u_${ulid()}`;
  db.prepare(
    "INSERT INTO trader_universe (id, asset, kraken_pair, action, reason, recorded_at) VALUES (?, ?, ?, 'unfollow', ?, ?)",
  ).run(id, symbol, asset.krakenPair, reason, now.toISOString());
  return { ok: true, value: rowToEntry(db.prepare("SELECT * FROM trader_universe WHERE id = ?").get(id)) };
}

/**
 * The owner's veto (/actifs non <symbole>): a satellite stops being followed at once and Sonni cannot
 * take it back for OWNER_VETO_DAYS. A core asset is removed from the config instead; an asset with open
 * predictions waits for them (they would be voided for lack of prices). Returns a French answer.
 */
export function ownerVeto(db: DB, cfg: TraderConfig, symbolRaw: unknown, now: Date = new Date()): string {
  const symbol = String(symbolRaw ?? "").trim().toUpperCase();
  const asset = activeAssets(db, cfg).find((a) => a.symbol === symbol);
  if (!asset) return `${symbol || "(aucun)"} n'est pas suivi. Actifs suivis : ${activeAssets(db, cfg).map((a) => a.symbol).join(", ")}.`;
  if (coreSymbols(cfg).has(symbol)) return `${symbol} fait partie du socle que tu as choisi : retire-le de la configuration (trader.assets) puis relance la configuration.`;
  const open = (db.prepare("SELECT COUNT(*) AS n FROM trader_predictions WHERE asset = ? AND resolved_at IS NULL").get(symbol) as { n: number }).n;
  if (open > 0) return `${symbol} a ${open} prédiction(s) ouverte(s) : réessaie après leur résolution (sinon elles seraient annulées faute de prix).`;
  db.prepare(
    "INSERT INTO trader_universe (id, asset, kraken_pair, action, reason, recorded_at) VALUES (?, ?, ?, 'unfollow', ?, ?)",
  ).run(`u_${ulid()}`, symbol, asset.krakenPair, `${OWNER_VETO_REASON} (/actifs non)`, now.toISOString());
  return `${symbol} n'est plus suivi (ton veto) ; Sonni ne pourra pas le reprendre avant ${new Date(now.getTime() + OWNER_VETO_DAYS * 86_400_000).toISOString().slice(0, 10)}.`;
}

const KV_CONFIG_ASSETS = "sonni.config_assets";

/**
 * The owner's config stays authoritative: at startup, an asset the owner
 * added to the config since the last start is followed, and one the owner
 * removed is unfollowed, each as a new log entry (the newest event wins in
 * the replay). The first start only records the config. An asset removed
 * while it has open predictions keeps being followed (a log entry says
 * why) until they resolve, so they are not voided for lack of prices; the
 * removal is retried at each start. A pair the owner corrected in the
 * config replaces the one in an older follow entry. Returns French lines
 * for the log.
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
    const known = recorded.get(asset.symbol);
    if (known && known.krakenPair === asset.krakenPair) continue;
    if (known) {
      // The owner corrected the pair: a follow entry with the old pair would otherwise override it.
      const current = activeAssets(db, cfg).find((a) => a.symbol === asset.symbol);
      if (current && current.krakenPair !== asset.krakenPair) {
        insert.run(`u_${ulid()}`, asset.symbol, asset.krakenPair, "follow", "paire corrigée par le propriétaire dans la configuration", now.toISOString());
        notes.push(`${asset.symbol} : paire ${asset.krakenPair} (corrigée dans la configuration)`);
      }
      recorded.set(asset.symbol, asset);
      continue;
    }
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
  const core = coreSymbols(cfg);
  const label = (a: TraderAsset) => `${a.symbol} (${a.krakenPair}${quoteOf(a.krakenPair) === "USD" ? ", en dollars converti en euros" : ""})`;
  const satellites = assets.filter((a) => !core.has(a.symbol));
  const lines = [
    `Socle choisi par toi (${assets.filter((a) => core.has(a.symbol)).length}) : ${assets.filter((a) => core.has(a.symbol)).map(label).join(", ") || "aucun"}`,
    `Places tournantes choisies par Sonni (${satellites.length} sur ${MAX_SATELLITES}) : ${satellites.map(label).join(", ") || "aucune pour l'instant"}`,
    "Pour retirer une place tournante : /actifs non <symbole> (Sonni ne pourra pas la reprendre pendant 30 jours).",
  ];
  const log = universeLog(db, 10);
  if (log.length) {
    lines.push("Derniers changements décidés par Sonni :");
    for (const e of log) lines.push(`- ${e.recordedAt.slice(0, 10)} ${e.action === "follow" ? "ajout" : "retrait"} ${e.asset} : ${e.reason}`);
  } else {
    lines.push("Sonni n'a encore ajouté ni retiré aucun actif.");
  }
  return lines.join("\n");
}
