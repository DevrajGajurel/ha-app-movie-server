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

function keyFor(pageUrl) {
  return `${CACHE_PREFIX}${pageUrl}`;
}

async function getCachedDirectOptions(pageUrl) {
  if (!client?.isReady) return null;
  try {
    const raw = await client.get(keyFor(pageUrl));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function setCachedDirectOptions(pageUrl, result) {
  if (!client?.isReady) return;
  try {
    await client.set(keyFor(pageUrl), JSON.stringify(result), { EX: CACHE_TTL_SEC });
  } catch (err) {
    console.warn("[downloads-cache] write failed:", err.message);
  }
}

// Cache-then-in-flight-then-live: repeat requests for the same URL (a
// background prefetch racing a real click, or the user reopening the same
// quality's direct list) share one resolution instead of each paying the
// Cloudflare cost separately.
async function resolveDirectOptionsCached(pageUrl, resolveLive) {
  const cached = await getCachedDirectOptions(pageUrl);
  if (cached) return { ...cached, cached: true };

  if (inflight.has(pageUrl)) {
    const result = await inflight.get(pageUrl);
    return { ...result, cached: false };
  }

  const pending = resolveLive()
    .then((result) => setCachedDirectOptions(pageUrl, result).then(() => result))
    .finally(() => {
      inflight.delete(pageUrl);
    });

  inflight.set(pageUrl, pending);
  const result = await pending;
  return { ...result, cached: false };
}

// Fire-and-forget: warms the cache for a batch of inner URLs (the quality
// page's own "direct" hrefs) without blocking whatever caller discovered
// them. Skips anything already cached or already resolving so this can be
// called every time the quality list loads without piling up duplicate
// browser/cf-clearance sessions for the same URL.
function prefetchDirectOptionsInBackground(pageUrls, resolveLive) {
  for (const pageUrl of pageUrls) {
    if (!pageUrl || inflight.has(pageUrl)) continue;
    getCachedDirectOptions(pageUrl).then((cached) => {
      if (cached || inflight.has(pageUrl)) return;
      console.log(`[downloads-cache] background prefetch: ${pageUrl}`);
      resolveDirectOptionsCached(pageUrl, () => resolveLive(pageUrl)).catch((err) => {
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
