const { createClient } = require("redis");

// Both hops of download-link resolution ("quality" - the source's own
// listing page, and "direct" - the file-host page each quality option leads
// to) now go through FlareSolverr unconditionally (v1.7.29), so a single
// live resolution costs anywhere from a few seconds to FLARESOLVERR's full
// challenge-solve timeout - tens of seconds - regardless of which hop it is.
// Caching both the same way (same shape, same TTL, same in-flight dedup)
// means re-opening the same title's download popup, or a background
// prefetch racing a real click, only pays that cost once. Same shape as
// streamResolve.js's resolveInflight/Redis pair: an in-memory Map de-dupes
// concurrent callers, and Redis persists the result past a restart.
const CACHE_PREFIX = "movieserver:v1:downloads:";
const CACHE_TTL_SEC = Math.max(
  300,
  Math.round((Number.parseFloat(process.env.DOWNLOAD_OPTIONS_CACHE_HOURS) || 6) * 3600)
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

// Keyed on (kind, source, pageUrl) rather than pageUrl alone: kind keeps the
// "quality" and "direct" hops from colliding on a URL that happens to
// appear in both (unlikely but free to rule out), and source keeps the
// primary/secondary sites from serving one another's cached result for what
// looks like the same intermediate hop.
function keyFor(kind, pageUrl, source) {
  return `${CACHE_PREFIX}${kind}:${source || "primary"}:${pageUrl}`;
}

// A result with zero options is never trustworthy to reuse - it's
// indistinguishable from a transient failure (a moved page, a challenge
// that didn't clear, a selector miss) rather than the page genuinely having
// nothing, and caching it for the full multi-hour TTL meant one bad
// resolution stuck around blocking every real attempt after it (confirmed:
// exactly this happened on a real page - "0 matches" served back repeatedly
// instead of ever retrying live).
function hasUsableOptions(result) {
  return Boolean(result?.options?.length);
}

async function getCachedOptions(kind, pageUrl, source) {
  if (!client?.isReady) return null;
  try {
    const raw = await client.get(keyFor(kind, pageUrl, source));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return hasUsableOptions(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function setCachedOptions(kind, pageUrl, source, result) {
  if (!client?.isReady || !hasUsableOptions(result)) return;
  try {
    await client.set(keyFor(kind, pageUrl, source), JSON.stringify(result), { EX: CACHE_TTL_SEC });
  } catch (err) {
    console.warn("[downloads-cache] write failed:", err.message);
  }
}

// Cache-then-in-flight-then-live: repeat requests for the same (kind,
// source, URL) tuple (a background prefetch racing a real click, or the
// user reopening the same title/quality) share one resolution instead of
// each paying the FlareSolverr cost separately.
async function resolveOptionsCached(kind, pageUrl, source, resolveLive) {
  const inflightKey = keyFor(kind, pageUrl, source);
  const cached = await getCachedOptions(kind, pageUrl, source);
  if (cached) return { ...cached, cached: true };

  if (inflight.has(inflightKey)) {
    const result = await inflight.get(inflightKey);
    return { ...result, cached: false };
  }

  const pending = resolveLive()
    .then((result) => setCachedOptions(kind, pageUrl, source, result).then(() => result))
    .finally(() => {
      inflight.delete(inflightKey);
    });

  inflight.set(inflightKey, pending);
  const result = await pending;
  return { ...result, cached: false };
}

// Fire-and-forget: warms the cache for a batch of URLs of the given kind
// without blocking whatever caller discovered them. Skips anything already
// cached or already resolving so this can be called every time a listing
// loads without piling up duplicate FlareSolverr sessions for the same
// (kind, source, URL) tuple.
function prefetchOptionsInBackground(kind, pageUrls, source, resolveLive) {
  for (const pageUrl of pageUrls) {
    if (!pageUrl) continue;
    const inflightKey = keyFor(kind, pageUrl, source);
    if (inflight.has(inflightKey)) continue;
    getCachedOptions(kind, pageUrl, source).then((cached) => {
      if (cached || inflight.has(inflightKey)) return;
      console.log(`[downloads-cache] background prefetch ${kind} (${source || "primary"}): ${pageUrl}`);
      resolveOptionsCached(kind, pageUrl, source, () => resolveLive(pageUrl)).catch((err) => {
        console.warn(`[downloads-cache] background prefetch failed for ${pageUrl}:`, err.message);
      });
    });
  }
}

module.exports = {
  initDownloadOptionsCache,
  resolveOptionsCached,
  prefetchOptionsInBackground,
};
