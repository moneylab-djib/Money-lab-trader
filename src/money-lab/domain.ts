/**
 * Money Lab domain availability (RDAP, then DNS)
 *
 * Asks the registry's public RDAP service whether a domain name is
 * registered: a 404 from the registry means nobody holds the name, a 200
 * means it is taken (with its expiry date). Some registries (.de, .io, .eu,
 * .es, .ch...) have no RDAP service; rdap.org then answers 404 itself, which
 * says nothing about the name, so the answer falls back to DNS: a name with
 * name servers is taken, one without is only probably free. No account, no
 * cost. The agent then asks the owner to buy the chosen name.
 */

import { promises as dns } from "dns";

type FetchFn = typeof fetch;
type NsLookup = (domain: string) => Promise<string[]>;

const NAME = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
const RDAP_BOOTSTRAP = "https://rdap.org/domain/";
export const MAX_DOMAINS = 20;

export interface DomainStatus {
  domain: string;
  status: "available" | "probably_available" | "taken" | "unknown" | "invalid";
  detail: string;
}

/** Name servers of a domain; [] when the name does not exist in DNS. */
async function lookupNs(domain: string): Promise<string[]> {
  try {
    return await dns.resolveNs(domain);
  } catch (err: any) {
    if (err?.code === "ENOTFOUND" || err?.code === "ENODATA") return [];
    throw err;
  }
}

async function dnsFallback(name: string, nsLookup: NsLookup, why: string): Promise<DomainStatus> {
  try {
    const ns = await nsLookup(name);
    return ns.length > 0
      ? { domain: name, status: "taken", detail: `${why}; registered (it has name servers: ${ns.slice(0, 2).join(", ")})` }
      : { domain: name, status: "probably_available", detail: `${why}; no DNS records, so probably free (confirm at the registrar before asking)` };
  } catch (err: any) {
    return { domain: name, status: "unknown", detail: `${why}; DNS check failed (${err?.code ?? err?.message ?? err})` };
  }
}

export async function checkDomain(domain: string, fetchFn: FetchFn = fetch, nsLookup: NsLookup = lookupNs): Promise<DomainStatus> {
  const name = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!NAME.test(name)) return { domain: name, status: "invalid", detail: "not a valid domain name" };
  let resp: Response;
  try {
    resp = await fetchFn(`${RDAP_BOOTSTRAP}${name}`, {
      // rdap.org sits behind Cloudflare, which answers 403 to requests without a user agent.
      headers: { accept: "application/rdap+json", "user-agent": "MoneyLabBot/1.0 (domain availability check)" },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err: any) {
    return dnsFallback(name, nsLookup, `registry unreachable (${String(err?.message ?? err).slice(0, 60)})`);
  }
  if (resp.ok) {
    const data = await resp.json().catch(() => ({})) as { events?: Array<{ eventAction?: string; eventDate?: string }> };
    const expiry = data.events?.find((e) => e.eventAction === "expiration")?.eventDate;
    return { domain: name, status: "taken", detail: `registered${expiry ? `, expires ${expiry.slice(0, 10)}` : ""}` };
  }
  if (resp.status === 404) {
    const body = await resp.text().catch(() => "");
    // A 404 from rdap.org itself (no redirect) means the extension has no RDAP service.
    const answeredByBootstrap = !resp.url || resp.url.startsWith(RDAP_BOOTSTRAP) || /No RDAP service/i.test(body);
    if (answeredByBootstrap) return dnsFallback(name, nsLookup, "this extension's registry has no RDAP service");
    return { domain: name, status: "available", detail: "the registry has no record of it: free (confirm the price at the registrar)" };
  }
  return dnsFallback(name, nsLookup, `registry answered HTTP ${resp.status}`);
}

export async function checkDomains(
  domains: string[],
  fetchFn: FetchFn = fetch,
  nsLookup: NsLookup = lookupNs,
): Promise<string> {
  const unique = [...new Set(domains.map((d) => d.trim().toLowerCase()).filter(Boolean))].slice(0, MAX_DOMAINS);
  if (unique.length === 0) return "Give at least one domain name, e.g. devis-artisan.fr.";
  const results = await Promise.all(unique.map((d) => checkDomain(d, fetchFn, nsLookup)));
  const label = { available: "FREE", probably_available: "PROBABLY FREE", taken: "TAKEN", unknown: "?", invalid: "INVALID" };
  return results.map((r) => `${label[r.status]} ${r.domain}: ${r.detail}`).join("\n") +
    "\nPrices vary by extension (.fr and .com are about 8-15 EUR/year at OVH): check them with web_search before asking the owner.";
}
