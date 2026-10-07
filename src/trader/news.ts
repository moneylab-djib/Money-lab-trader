/**
 * Sonni headlines (docs/MEMORY.md section 3.1, step 2)
 *
 * Every hour, code fetches recent English headlines about crypto and the
 * Federal Reserve from the GDELT DOC 2.0 API (free, no key, at most one
 * request every 5 seconds) and from a few keyless RSS feeds, and stores
 * them, deduplicated by URL, with their publication time. GDELT answers
 * HTTP 429 to many hosting providers' addresses (the owner's VPS and the
 * development sandbox, 2026-10-07): the feeds keep the readers fed.
 * Headlines are untrusted data: the memory pack shows them as such, and
 * they never become rules by themselves. No inference here; Sonni reads
 * them in its memory pack and may hand a full article to delegate when it
 * needs more.
 */

import type Database from "better-sqlite3";

type DB = Database.Database;
type FetchFn = typeof fetch;

export const GDELT_DOC_URL = "https://api.gdeltproject.org/api/v2/doc/doc";
export const NEWS_QUERY = '(bitcoin OR ethereum OR crypto OR "federal reserve") sourcelang:english';
const FETCH_TIMEOUT_MS = 25_000;
const MAX_TITLE = 200;
/** Headlines older than this are deleted: the memory keeps observations, not a news archive. */
const KEEP_DAYS = 30;

export interface Headline {
  url: string;
  title: string;
  domain: string;
  publishedAt: string;
}

/** GDELT dates look like 20261006T123000Z. */
function gdeltDate(s: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : null;
}

/** Plain text only: no control characters, bounded length. */
export function cleanTitle(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
}

// ─── RSS feeds ──────────────────────────────────────────────────

/** Response bytes kept at most (a feed weighs a few hundred kB). */
const FEED_MAX_BYTES = 1_000_000;
/** Items older than this are ignored: the readers digest news, not archives. */
const FEED_MAX_AGE_HOURS = 48;
const FEED_MAX_ITEMS = 40;
const FEED_USER_AGENT = "Mozilla/5.0 (compatible; Sonni/0.1; +https://github.com/moneylab-djib/Money-lab-trader)";

export interface NewsFeed {
  id: string;
  url: string;
  /** Keep only titles matching NEWS_KEYWORDS (feeds that also cover other topics). */
  filter: boolean;
}

/** Fixed, keyless RSS feeds read beside GDELT; no model or page can add one. */
export const NEWS_FEEDS: NewsFeed[] = [
  { id: "cointelegraph", url: "https://cointelegraph.com/rss", filter: false },
  { id: "theblock", url: "https://www.theblock.co/rss.xml", filter: false },
  { id: "decrypt", url: "https://decrypt.co/feed", filter: true },
  { id: "fed", url: "https://www.federalreserve.gov/feeds/press_all.xml", filter: false },
  { id: "googlenews", url: "https://news.google.com/rss/search?q=bitcoin+OR+ethereum+OR+crypto+OR+%22federal+reserve%22&hl=en-US&gl=US&ceid=US:en", filter: false },
];

export const NEWS_KEYWORDS = /\b(bitcoin|btc|ethereum|ether|eth|crypto\w*|stablecoins?|blockchain|defi|tokens?|altcoins?|solana|xrp|binance|coinbase|kraken|tether|usdc|usdt|etfs?|mining|halving|federal reserve|fomc|powell|inflation|cpi|treasur\w*|sec)\b/i;

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": " " };

/** CDATA unwrapped, tags removed, the common entities decoded. */
function decodeXml(s: string): string {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(s);
  const raw = cdata ? cdata[1] : s;
  return raw.replace(/<[^>]+>/g, "").replace(/&(#x([0-9a-f]{1,6})|#(\d{1,7})|amp|lt|gt|quot|apos|nbsp);/gi, (m, _g, hex, dec) => {
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    if (dec) return String.fromCodePoint(Number(dec));
    return ENTITIES[m.toLowerCase()] ?? m;
  });
}

function tagText(item: string, name: string): string | null {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(item);
  return m ? decodeXml(m[1]).trim() : null;
}

/** Items of an RSS 2.0 document (title, link, pubDate); anything malformed, old or off-topic is skipped. */
export function parseRssItems(xml: string, feed: NewsFeed, now: Date = new Date()): Headline[] {
  const out: Headline[] = [];
  const oldest = now.getTime() - FEED_MAX_AGE_HOURS * 3_600_000;
  for (const m of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)) {
    if (out.length >= FEED_MAX_ITEMS) break;
    const item = m[1];
    let title = cleanTitle(tagText(item, "title") ?? "");
    const link = tagText(item, "link") ?? "";
    const date = Date.parse(tagText(item, "pubDate") ?? tagText(item, "dc:date") ?? "");
    if (!title || !/^https?:\/\/[^\s<>"']+$/.test(link) || !Number.isFinite(date)) continue;
    if (date < oldest || date > now.getTime() + 3_600_000) continue;
    let domain: string;
    try {
      domain = new URL(link).hostname.replace(/^www\./, "");
    } catch {
      continue;
    }
    // Google News titles end with " - Source": the source is the better attribution.
    const src = feed.id === "googlenews" ? /^(.*\S)\s+-\s+([^-]{2,60})$/.exec(title) : null;
    if (src) {
      title = src[1];
      domain = cleanTitle(src[2]);
    }
    if (feed.filter && !NEWS_KEYWORDS.test(title)) continue;
    out.push({ url: link, title, domain: domain.slice(0, 80), publishedAt: new Date(date).toISOString().slice(0, 19) + "Z" });
  }
  return out;
}

async function readText(resp: Response, limit: number): Promise<string> {
  if (!resp.body) return (await resp.text()).slice(0, limit);
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel().catch(() => undefined);
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, limit));
}

export async function fetchFeed(feed: NewsFeed, fetchFn: FetchFn = fetch, now: Date = new Date()): Promise<Headline[]> {
  const resp = await fetchFn(feed.url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { "user-agent": FEED_USER_AGENT, accept: "application/rss+xml, application/xml, text/xml" },
  });
  if (!resp.ok) throw new Error(`${feed.id}: HTTP ${resp.status}`);
  return parseRssItems(await readText(resp, FEED_MAX_BYTES), feed, now);
}

// ─── GDELT ──────────────────────────────────────────────────────

export async function fetchHeadlines(fetchFn: FetchFn = fetch, timespan = "2h", max = 75): Promise<Headline[]> {
  const url = `${GDELT_DOC_URL}?query=${encodeURIComponent(NEWS_QUERY)}&mode=artlist&format=json` +
    `&maxrecords=${max}&timespan=${timespan}&sort=datedesc`;
  const resp = await fetchFn(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`GDELT: HTTP ${resp.status}`);
  const text = await resp.text();
  let data: { articles?: { url?: string; title?: string; domain?: string; seendate?: string }[] };
  try {
    data = text.trim() === "" ? {} : JSON.parse(text);
  } catch {
    // GDELT answers rate limits and errors in plain text.
    throw new Error(`GDELT: ${text.slice(0, 120).replace(/\s+/g, " ")}`);
  }
  const out: Headline[] = [];
  for (const a of data.articles ?? []) {
    const publishedAt = gdeltDate(String(a.seendate ?? ""));
    const title = cleanTitle(String(a.title ?? ""));
    const link = String(a.url ?? "");
    if (!publishedAt || !title || !/^https?:\/\//.test(link)) continue;
    out.push({ url: link, title, domain: cleanTitle(String(a.domain ?? "")).slice(0, 80), publishedAt });
  }
  return out;
}

export interface CollectOutcome {
  /** New headlines stored. */
  added: number;
  /** Sources that answered: gdelt and the feed ids. */
  ok: string[];
  /** One line per source that failed, for the log. */
  errors: string[];
}

/**
 * Fetch GDELT and the feeds together and store the new headlines; a source
 * failing does not stop the others.
 */
export async function collectHeadlines(db: DB, fetchFn: FetchFn = fetch, now: Date = new Date(), feeds: NewsFeed[] = NEWS_FEEDS): Promise<CollectOutcome> {
  const sources: { id: string; run: () => Promise<Headline[]> }[] = [
    { id: "gdelt", run: () => fetchHeadlines(fetchFn) },
    ...feeds.map((f) => ({ id: f.id, run: () => fetchFeed(f, fetchFn, now) })),
  ];
  const results = await Promise.allSettled(sources.map((s) => s.run()));
  const outcome: CollectOutcome = { added: 0, ok: [], errors: [] };
  const insert = db.prepare(
    "INSERT OR IGNORE INTO trader_headlines (url, title, domain, published_at, fetched_at) VALUES (?, ?, ?, ?, ?)",
  );
  db.transaction(() => {
    results.forEach((r, i) => {
      if (r.status === "rejected") {
        const message = String(r.reason?.message ?? r.reason);
        outcome.errors.push(message.startsWith(`${sources[i].id}:`) || message.startsWith("GDELT") ? message : `${sources[i].id}: ${message}`);
        return;
      }
      outcome.ok.push(sources[i].id);
      for (const h of r.value) outcome.added += insert.run(h.url, h.title, h.domain, h.publishedAt, now.toISOString()).changes;
    });
    db.prepare("DELETE FROM trader_headlines WHERE published_at < ?")
      .run(new Date(now.getTime() - KEEP_DAYS * 86_400_000).toISOString().slice(0, 19) + "Z");
  })();
  return outcome;
}

/** Recent headlines, newest first, one per title. */
export function recentHeadlines(db: DB, since: Date, limit: number): Headline[] {
  const rows = db.prepare(
    `SELECT url, title, domain, published_at AS publishedAt FROM trader_headlines
     WHERE published_at >= ? ORDER BY published_at DESC LIMIT ?`,
  ).all(since.toISOString().slice(0, 19) + "Z", limit * 3) as Headline[];
  const seen = new Set<string>();
  return rows.filter((h) => {
    const key = h.title.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, limit);
}
