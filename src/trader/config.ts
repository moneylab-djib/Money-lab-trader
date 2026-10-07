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

/** Self-wake limits (src/trader/curiosity.ts). */
export interface CuriosityConfig {
  /** A move of this size (in %) within an hour wakes Sonni. */
  moveAlertPct: number;
  /** Self-wakes delivered per UTC day; 0 disables them (triggers are still logged). */
  maxSelfWakesPerDay: number;
  minMinutesBetweenWakes: number;
}

/**
 * A free "reader" model behind an OpenAI-compatible chat-completions API
 * (src/trader/readers.ts). Its key is an environment variable sealed at
 * startup; a reader whose key is absent is skipped.
 */
export interface ReaderConfig {
  id: string;
  /** Base URL up to the API version, e.g. https://api.groq.com/openai/v1 */
  baseUrl: string;
  model: string;
  keyEnv: string;
  /** Hard cap of requests per UTC day, below the provider's free limit. */
  dailyRequests: number;
  /** Send response_format json_object (most providers); false for those that reject it. */
  jsonMode: boolean;
}

export interface TraderConfig {
  enabled: true;
  quoteCurrency: "EUR";
  assets: TraderAsset[];
  /** Minutes between two price collections. */
  collectMinutes: number;
  /** A price older than this is stale: no prediction may rely on it. */
  staleMinutes: number;
  curiosity: CuriosityConfig;
  readers: ReaderConfig[];
  /** Pages the model may read per UTC day with read_page. */
  readPagesPerDay: number;
  /** IANA time zone of the owner, for everything they read (default Europe/Paris). */
  timeZone: string;
}

export const DEFAULT_TIME_ZONE = "Europe/Paris";

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("fr-FR", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const DEFAULT_CURIOSITY: CuriosityConfig = { moveAlertPct: 3, maxSelfWakesPerDay: 6, minMinutesBetweenWakes: 30 };
export const DEFAULT_READ_PAGES_PER_DAY = 20;
export const MAX_READERS = 6;
/** Hosts a reader key may be sent to (free OpenAI-compatible providers, research of 2026-10-07). */
export const READER_HOSTS: ReadonlySet<string> = new Set([
  "generativelanguage.googleapis.com",
  "api.groq.com",
  "api.mistral.ai",
  "openrouter.ai",
  "api.cloudflare.com",
  "integrate.api.nvidia.com",
  "api.sambanova.ai",
  "api.cohere.ai",
  "ai-gateway.vercel.sh",
  "router.huggingface.co",
  "api.together.xyz",
  "api.z.ai",
  "ollama.com",
]);

/**
 * Tools denied while the trader block is active (decision 0002): Money
 * Lab's web-business tools (Sonni does not build sites, run ads or
 * publish), Automaton's own soul and memory stores (Sonni's identity,
 * journal and lessons live in its memory tables, docs/MEMORY.md, so a
 * second set of stores would split what it knows), and relay or registry
 * tools that do nothing on its VPS but cost a tool call.
 */
export const SONNI_DENIED_TOOLS: ReadonlySet<string> = new Set([
  // Money Lab web business
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
  // Automaton soul and generic memory (replaced by Sonni's stores)
  "update_soul",
  "reflect_on_soul",
  "view_soul",
  "view_soul_history",
  "update_genesis_prompt",
  "remember_fact",
  "recall_facts",
  "set_goal",
  "complete_goal",
  "save_procedure",
  "recall_procedure",
  "note_about_agent",
  "review_memory",
  "forget",
  // Conway relay and registry: no effect on a self-hosted VPS
  "heartbeat_ping",
  "distress_signal",
  "modify_heartbeat",
  "enter_low_compute",
  "register_erc8004",
  "update_agent_card",
  "discover_agents",
  "give_feedback",
  "check_reputation",
  "send_message",
  "check_usdc_balance",
]);

export class TraderConfigError extends Error {
  constructor(message: string) {
    super(`Configuration trader invalide : ${message}`);
    this.name = "TraderConfigError";
  }
}

const KEYS = ["enabled", "quoteCurrency", "assets", "collectMinutes", "staleMinutes"];
/** Keys added by later slices: absent means the default, so older configs keep working. */
const OPTIONAL_KEYS = ["curiosity", "readers", "readPagesPerDay", "timeZone"];
const CURIOSITY_KEYS = ["moveAlertPct", "maxSelfWakesPerDay", "minMinutesBetweenWakes"];
const READER_KEYS = ["id", "baseUrl", "model", "keyEnv", "dailyRequests"];
const READER_OPTIONAL_KEYS = ["jsonMode"];
const ASSET_KEYS = ["symbol", "krakenPair"];
export const SYMBOL = /^[A-Z0-9]{2,10}$/;
export const PAIR = /^[A-Z0-9]{4,16}$/;
const READER_ID = /^[a-z0-9][a-z0-9-]{1,19}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{2,40}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkKeys(obj: Record<string, unknown>, required: string[], where: string, optional: string[] = []): void {
  for (const key of Object.keys(obj)) {
    if (!required.includes(key) && !optional.includes(key)) throw new TraderConfigError(`clé inconnue ${where}.${key}`);
  }
  for (const key of required) {
    if (!(key in obj)) throw new TraderConfigError(`clé manquante ${where}.${key}`);
  }
}

function intInRange(value: unknown, min: number, max: number, where: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new TraderConfigError(`${where} doit être un entier entre ${min} et ${max}`);
  }
  return value;
}

function numberInRange(value: unknown, min: number, max: number, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new TraderConfigError(`${where} doit être un nombre entre ${min} et ${max}`);
  }
  return value;
}

function parseCuriosity(raw: unknown): CuriosityConfig {
  if (raw === undefined) return { ...DEFAULT_CURIOSITY };
  if (!isObject(raw)) throw new TraderConfigError("curiosity doit être un objet");
  checkKeys(raw, CURIOSITY_KEYS, "trader.curiosity");
  return {
    moveAlertPct: numberInRange(raw.moveAlertPct, 0.5, 50, "curiosity.moveAlertPct"),
    maxSelfWakesPerDay: intInRange(raw.maxSelfWakesPerDay, 0, 24, "curiosity.maxSelfWakesPerDay"),
    minMinutesBetweenWakes: intInRange(raw.minMinutesBetweenWakes, 5, 1440, "curiosity.minMinutesBetweenWakes"),
  };
}

function parseReaders(raw: unknown): ReaderConfig[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_READERS) throw new TraderConfigError(`readers doit être un tableau de 0 à ${MAX_READERS} lecteurs`);
  const ids = new Set<string>();
  return raw.map((entry, i): ReaderConfig => {
    const where = `trader.readers[${i}]`;
    if (!isObject(entry)) throw new TraderConfigError(`${where} doit être un objet`);
    checkKeys(entry, READER_KEYS, where, READER_OPTIONAL_KEYS);
    const id = entry.id;
    if (typeof id !== "string" || !READER_ID.test(id)) throw new TraderConfigError(`${where}.id doit être un identifiant en minuscules (ex : gemini)`);
    if (ids.has(id)) throw new TraderConfigError(`lecteur en double : ${id}`);
    ids.add(id);
    const baseUrl = entry.baseUrl;
    let url: URL;
    try {
      url = new URL(String(baseUrl));
    } catch {
      throw new TraderConfigError(`${where}.baseUrl doit être une URL https`);
    }
    if (typeof baseUrl !== "string" || url.protocol !== "https:" || url.search || url.hash || baseUrl.endsWith("/")) {
      throw new TraderConfigError(`${where}.baseUrl doit être une URL https sans paramètres ni barre oblique finale`);
    }
    // A sealed key is only ever sent to a known provider: an edited config cannot redirect it.
    if (!READER_HOSTS.has(url.hostname.toLowerCase())) {
      throw new TraderConfigError(`${where}.baseUrl : hôte ${url.hostname} inconnu ; lecteurs acceptés : ${[...READER_HOSTS].join(", ")}`);
    }
    const model = entry.model;
    if (typeof model !== "string" || model.length < 1 || model.length > 80) throw new TraderConfigError(`${where}.model doit être un nom de modèle`);
    const keyEnv = entry.keyEnv;
    if (typeof keyEnv !== "string" || !ENV_NAME.test(keyEnv)) throw new TraderConfigError(`${where}.keyEnv doit être un nom de variable (ex : GEMINI_API_KEY)`);
    const jsonMode = entry.jsonMode === undefined ? true : entry.jsonMode;
    if (typeof jsonMode !== "boolean") throw new TraderConfigError(`${where}.jsonMode doit être true ou false`);
    return { id, baseUrl, model, keyEnv, dailyRequests: intInRange(entry.dailyRequests, 1, 5000, `${where}.dailyRequests`), jsonMode };
  });
}

/** Validate a raw trader block. Returns null when the block is absent. */
export function parseTraderConfig(raw: unknown): TraderConfig | null {
  if (raw === undefined || raw === null) return null;
  if (!isObject(raw)) throw new TraderConfigError("trader doit être un objet");
  checkKeys(raw, KEYS, "trader", OPTIONAL_KEYS);
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
  const readPagesPerDay = raw.readPagesPerDay === undefined ? DEFAULT_READ_PAGES_PER_DAY : intInRange(raw.readPagesPerDay, 0, 200, "readPagesPerDay");
  const timeZone = raw.timeZone === undefined ? DEFAULT_TIME_ZONE : raw.timeZone;
  if (typeof timeZone !== "string" || !validTimeZone(timeZone)) {
    throw new TraderConfigError("timeZone doit être un fuseau IANA valide (ex : Europe/Paris)");
  }
  return {
    enabled: true,
    quoteCurrency: "EUR",
    assets,
    collectMinutes,
    staleMinutes,
    curiosity: parseCuriosity(raw.curiosity),
    readers: parseReaders(raw.readers),
    readPagesPerDay,
    timeZone,
  };
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
