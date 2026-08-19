const { createClient } = require("redis");

// The "direct" hop (fetchDirectDownloadOptions in main.js) resolves a
// quality page (e.g. linkmake.in) into the actual file-host buttons - and
// that inner page is exactly the one that sits behind a Cloudflare
// Turnstile challenge (new1.filesdl.in -> new6.filesdl.top), so resolving
// it costs anywhere from a few seconds to the full cf-clearance/browser
// fallback timeout (tens of seconds). Same shape as streamResolve.js's
// resolveInflight/Redis pair: an in-memory Map de-dupes concurrent callers
// (the background prefetch and a real click landing on the same URL should
// share one resolution, not spawn two browser sessions), and Redis persists
// the result past a restart.
const CACHE_PREFIX = "movieserver:v1:downloads:direct:";
const CACHE_TTL_SEC = Math.max(
  300,
  Math.round((Number.parseFloat(process.env.DOWNLOAD_DIRECT_CACHE_HOURS) || 6) * 3600)
);

let client = null;
const inflight = new Map();

async function initDownloadOptionsCache(redisUrl) {
  if (!redisUrl || client) return Boolean(client?.isReady);
  try {
    client = createClient({ url: redisUrl });
    client.on("error", (err) => console.warn("[downloads-cache]", err.message));
    await client.connect();
    return true;
  } catch (err) {
    console.warn("[downloads-cache] Redis unavailable:", err.message);
    client = null;
    return false;
  }
}

// Keyed on (source, pageUrl) rather than pageUrl alone: the same page URL
// can resolve differently depending on which site's flow led there (the
// primary/secondary source sites don't necessarily serve identical content
// for what looks like the same intermediate hop) - caching by URL only
// risked serving one source's resolved links back for the other's request.
function keyFor(pageUrl, source) {
  return `${CACHE_PREFIX}${source || "primary"}:${pageUrl}`;
}

// A result with zero options is never trustworthy to reuse - it's
// indistinguishable from a transient failure (a moved page, a Cloudflare
// challenge that didn't clear, a selector miss) rather than the page
// genuinely having nothing, and caching it for the full multi-hour TTL
// meant one bad resolution stuck around blocking every real attempt after
// it (confirmed: exactly this happened on a real page - "0 matches"
// served back repeatedly instead of ever retrying live).
function hasUsableOptions(result) {
  return Boolean(result?.options?.length);
}

async function getCachedDirectOptions(pageUrl, source) {
  if (!client?.isReady) return null;
  try {
    const raw = await client.get(keyFor(pageUrl, source));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return hasUsableOptions(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function setCachedDirectOptions(pageUrl, source, result) {
  if (!client?.isReady || !hasUsableOptions(result)) return;
  try {
    await client.set(keyFor(pageUrl, source), JSON.stringify(result), { EX: CACHE_TTL_SEC });
  } catch (err) {
    console.warn("[downloads-cache] write failed:", err.message);
  }
}

// Cache-then-in-flight-then-live: repeat requests for the same (source,
// URL) pair (a background prefetch racing a real click, or the user
// reopening the same quality's direct list) share one resolution instead
// of each paying the Cloudflare cost separately.
async function resolveDirectOptionsCached(pageUrl, source, resolveLive) {
  const inflightKey = keyFor(pageUrl, source);
  const cached = await getCachedDirectOptions(pageUrl, source);
  if (cached) return { ...cached, cached: true };

  if (inflight.has(inflightKey)) {
    const result = await inflight.get(inflightKey);
    return { ...result, cached: false };
  }

  const pending = resolveLive()
    .then((result) => setCachedDirectOptions(pageUrl, source, result).then(() => result))
    .finally(() => {
      inflight.delete(inflightKey);
    });

  inflight.set(inflightKey, pending);
  const result = await pending;
  return { ...result, cached: false };
}

// Fire-and-forget: warms the cache for a batch of inner URLs (the quality
// page's own "direct" hrefs, inheriting that page's own source) without
// blocking whatever caller discovered them. Skips anything already cached
// or already resolving so this can be called every time the quality list
// loads without piling up duplicate browser/cf-clearance sessions for the
// same (source, URL) pair.
function prefetchDirectOptionsInBackground(pageUrls, source, resolveLive) {
  for (const pageUrl of pageUrls) {
    if (!pageUrl) continue;
    const inflightKey = keyFor(pageUrl, source);
    if (inflight.has(inflightKey)) continue;
    getCachedDirectOptions(pageUrl, source).then((cached) => {
      if (cached || inflight.has(inflightKey)) return;
      console.log(`[downloads-cache] background prefetch (${source || "primary"}): ${pageUrl}`);
      resolveDirectOptionsCached(pageUrl, source, () => resolveLive(pageUrl)).catch((err) => {
        console.warn(`[downloads-cache] background prefetch failed for ${pageUrl}:`, err.message);
      });
    });
  }
}

module.exports = {
  initDownloadOptionsCache,
  resolveDirectOptionsCached,
  prefetchDirectOptionsInBackground,
};
