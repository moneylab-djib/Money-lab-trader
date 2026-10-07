// Route Sonni's external APIs to the local fake server; everything else fails.
const PORT = process.env.E2E_PORT;
const realFetch = globalThis.fetch;
const MAP = {
  "api.anthropic.com": "anthropic", "api.telegram.org": "telegram", "api.kraken.com": "kraken",
  "www.federalreserve.gov": "fed", "api.gdeltproject.org": "gdelt",
  // Step 3: a free reader model and the data sources enabled by default.
  "generativelanguage.googleapis.com": "gemini", "api.groq.com": "groq",
  "api.alternative.me": "fng", "api.coingecko.com": "coingecko", "mempool.space": "mempool",
  // Keyless RSS feeds read beside GDELT (the Fed's feed goes to the "fed" prefix above).
  "cointelegraph.com": "rss", "www.theblock.co": "rss", "decrypt.co": "rss", "news.google.com": "rss",
};
globalThis.fetch = async (input, init) => {
  const req = input instanceof Request ? input : null;
  const url = new URL(req ? req.url : String(input));
  const prefix = MAP[url.host];
  if (!prefix) throw new Error(`E2E: blocked network call to ${url.host}`);
  const target = `http://127.0.0.1:${PORT}/${prefix}${url.pathname}${url.search}`;
  if (req) {
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.text();
    return realFetch(target, { method: req.method, headers: req.headers, body, signal: init?.signal ?? req.signal });
  }
  return realFetch(target, init);
};
