/**
 * Sonni configuration
 *
 * Validation of the optional `trader` block in automaton.json. Sonni runs
 * on top of the Money Lab self-hosted runtime (decision 0002): the block
 * is only accepted next to a valid `moneyLab` block. Like the Money Lab
 * profile, an invalid block stops startup instead of falling back to
 * defaults. Virtual phase only: no exchange key is ever configured here.
 */

export interface TraderAsset {
  /** Display symbol, e.g. "BTC". */
  symbol: string;
  /** Kraken public pair name, e.g. "XBTEUR". */
  krakenPair: string;
}

export interface TraderConfig {
  enabled: true;
  quoteCurrency: "EUR";
  assets: TraderAsset[];
  /** Minutes between two price collections. */
  collectMinutes: number;
  /** A price older than this is stale: no prediction may rely on it. */
  staleMinutes: number;
}

/**
 * Money Lab tools that belong to its web-business mission. Sonni does not
 * build sites, run ads or publish; these stay denied while the trader
 * block is active (decision 0002).
 */
export const SONNI_DENIED_TOOLS: ReadonlySet<string> = new Set([
  "record_experiment",
  "idea",
  "view_page",
  "browse",
  "audit_page",
  "ab_test",
  "check_domain",
  "render_image",
  "post_social",
  "search_console",
  "set_budget_focus",
  "money_lab_status",
]);

export class TraderConfigError extends Error {
  constructor(message: string) {
    super(`Configuration trader invalide : ${message}`);
    this.name = "TraderConfigError";
  }
}

const KEYS = ["enabled", "quoteCurrency", "assets", "collectMinutes", "staleMinutes"];
const ASSET_KEYS = ["symbol", "krakenPair"];
const SYMBOL = /^[A-Z0-9]{2,10}$/;
const PAIR = /^[A-Z0-9]{4,16}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkKeys(obj: Record<string, unknown>, allowed: string[], where: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw new TraderConfigError(`clé inconnue ${where}.${key}`);
  }
  for (const key of allowed) {
    if (!(key in obj)) throw new TraderConfigError(`clé manquante ${where}.${key}`);
  }
}

function intInRange(value: unknown, min: number, max: number, where: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new TraderConfigError(`${where} doit être un entier entre ${min} et ${max}`);
  }
  return value;
}

/** Validate a raw trader block. Returns null when the block is absent. */
export function parseTraderConfig(raw: unknown): TraderConfig | null {
  if (raw === undefined || raw === null) return null;
  if (!isObject(raw)) throw new TraderConfigError("trader doit être un objet");
  checkKeys(raw, KEYS, "trader");
  if (raw.enabled !== true) {
    throw new TraderConfigError("enabled doit valoir true ; retirer le bloc pour désactiver Sonni");
  }
  if (raw.quoteCurrency !== "EUR") throw new TraderConfigError('quoteCurrency doit valoir "EUR"');

  if (!Array.isArray(raw.assets) || raw.assets.length === 0 || raw.assets.length > 30) {
    throw new TraderConfigError("assets doit être un tableau de 1 à 30 actifs");
  }
  const seen = new Set<string>();
  const assets = raw.assets.map((entry, i): TraderAsset => {
    if (!isObject(entry)) throw new TraderConfigError(`assets[${i}] doit être un objet`);
    checkKeys(entry, ASSET_KEYS, `trader.assets[${i}]`);
    const symbol = entry.symbol;
    const pair = entry.krakenPair;
    if (typeof symbol !== "string" || !SYMBOL.test(symbol)) {
      throw new TraderConfigError(`assets[${i}].symbol doit être un symbole en majuscules (ex : BTC)`);
    }
    if (typeof pair !== "string" || !PAIR.test(pair)) {
      throw new TraderConfigError(`assets[${i}].krakenPair doit être une paire Kraken (ex : XBTEUR)`);
    }
    if (seen.has(symbol)) throw new TraderConfigError(`actif en double : ${symbol}`);
    seen.add(symbol);
    return { symbol, krakenPair: pair };
  });

  const collectMinutes = intInRange(raw.collectMinutes, 1, 60, "collectMinutes");
  const staleMinutes = intInRange(raw.staleMinutes, 2, 1440, "staleMinutes");
  if (staleMinutes <= collectMinutes) {
    throw new TraderConfigError("staleMinutes doit être plus grand que collectMinutes");
  }
  return { enabled: true, quoteCurrency: "EUR", assets, collectMinutes, staleMinutes };
}

/**
 * Validate the trader block of a loaded configuration. Sonni needs the
 * Money Lab runtime (budgets, Telegram, guards), so a trader block without
 * a moneyLab block is rejected.
 */
export function applyTraderProfile<C extends { moneyLab?: unknown; trader?: unknown }>(config: C): C {
  const trader = parseTraderConfig(config.trader);
  if (!trader) {
    const { trader: _drop, ...rest } = config as any;
    return rest as C;
  }
  if (!config.moneyLab) throw new TraderConfigError("le bloc trader exige un bloc moneyLab valide");
  return { ...config, trader };
}
