/**
 * Money Lab Google Search Console access (read-only)
 *
 * The owner adds a Google service account as a user of the Search Console
 * property and puts its JSON key in ~/.automaton/gsc-key.json (a protected
 * runtime entry). The runtime signs a JWT with that key, exchanges it for an
 * access token limited to webmasters.readonly, and queries search analytics:
 * the agent sees which queries and pages bring impressions and clicks.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";

const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
type FetchFn = typeof fetch;

export function gscKeyFile(home = process.env.HOME || "/root"): string {
  return path.join(home, ".automaton", "gsc-key.json");
}

/** Search Console is usable when the key file exists and a default property is set. */
export function searchConsoleSite(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.GSC_SITE && fs.existsSync(gscKeyFile(env.HOME)) ? env.GSC_SITE : null;
}

const base64url = (input: Buffer | string) =>
  Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

let cached: { token: string; expires: number } | null = null;

async function accessToken(keyFile: string, fetchFn: FetchFn, now = Date.now()): Promise<string> {
  if (cached && cached.expires > now + 60_000) return cached.token;
  const key = JSON.parse(fs.readFileSync(keyFile, "utf-8")) as { client_email: string; private_key: string; token_uri?: string };
  const iat = Math.floor(now / 1000);
  const aud = key.token_uri || DEFAULT_TOKEN_URI;
  const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify({
    iss: key.client_email, scope: SCOPE, aud, iat, exp: iat + 3600,
  }))}`;
  const signature = base64url(crypto.createSign("RSA-SHA256").update(unsigned).sign(key.private_key));
  const resp = await fetchFn(aud, {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }).toString(),
  });
  const data = await resp.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!resp.ok || !data.access_token) {
    throw new Error(`Google token error ${resp.status}: ${data.error_description || data.error || "unknown"}`);
  }
  cached = { token: data.access_token, expires: now + (data.expires_in ?? 3600) * 1000 };
  return cached.token;
}

export function resetSearchConsoleToken(): void {
  cached = null;
}

export interface SearchConsoleQuery {
  site: string;
  dimension: "query" | "page" | "date" | "country" | "device";
  days: number;
}

/** Top rows of search analytics for the last `days` days (Search Console data lags ~2 days). */
export async function searchAnalytics(
  q: SearchConsoleQuery,
  options: { keyFile?: string; fetchFn?: FetchFn; now?: Date } = {},
): Promise<string> {
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? new Date();
  const token = await accessToken(options.keyFile ?? gscKeyFile(), fetchFn, now.getTime());
  const end = new Date(now.getTime() - 2 * 86_400_000);
  const start = new Date(end.getTime() - (q.days - 1) * 86_400_000);
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const resp = await fetchFn(
    `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(q.site)}/searchAnalytics/query`,
    {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ startDate: day(start), endDate: day(end), dimensions: [q.dimension], rowLimit: 25 }),
    },
  );
  const data = await resp.json().catch(() => ({})) as {
    rows?: Array<{ keys: string[]; clicks: number; impressions: number; ctr: number; position: number }>;
    error?: { message?: string };
  };
  if (!resp.ok) throw new Error(`Search Console error ${resp.status}: ${data.error?.message ?? "unknown"}`);
  const rows = data.rows ?? [];
  const header = `Search Console ${q.site}, ${day(start)} to ${day(end)}, by ${q.dimension}:`;
  if (rows.length === 0) return `${header}\nNo data yet (new sites take days to weeks to appear).`;
  const total = rows.reduce((t, r) => ({ c: t.c + r.clicks, i: t.i + r.impressions }), { c: 0, i: 0 });
  return [
    header,
    `Top rows: ${total.c} clicks, ${total.i} impressions.`,
    ...rows.map((r) => `- ${r.keys[0]}: ${r.clicks} clicks, ${r.impressions} impr., CTR ${(r.ctr * 100).toFixed(1)}%, pos ${r.position.toFixed(1)}`),
  ].join("\n");
}
