/**
 * Sonni headlines (docs/MEMORY.md section 3.1, step 2)
 *
 * Every hour, code fetches recent English headlines about crypto and the
 * Federal Reserve from the GDELT DOC 2.0 API (free, no key, at most one
 * request every 5 seconds) and stores them, deduplicated by URL, with
 * their publication time. Headlines are untrusted data: the memory pack
 * shows them as such, and they never become rules by themselves. No
 * inference here; Sonni reads them in its memory pack and may hand a full
 * article to delegate when it needs more.
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

/** Fetch and store new headlines; returns how many were new. */
export async function collectHeadlines(db: DB, fetchFn: FetchFn = fetch, now: Date = new Date()): Promise<number> {
  const headlines = await fetchHeadlines(fetchFn);
  const insert = db.prepare(
    "INSERT OR IGNORE INTO trader_headlines (url, title, domain, published_at, fetched_at) VALUES (?, ?, ?, ?, ?)",
  );
  let added = 0;
  db.transaction(() => {
    for (const h of headlines) added += insert.run(h.url, h.title, h.domain, h.publishedAt, now.toISOString()).changes;
    db.prepare("DELETE FROM trader_headlines WHERE published_at < ?")
      .run(new Date(now.getTime() - KEEP_DAYS * 86_400_000).toISOString().slice(0, 19) + "Z");
  })();
  return added;
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
