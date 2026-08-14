const { createClient } = require("redis");

// TMDB enrichment (searchMedia in tmdb.js) already has an in-memory Map, but
// that's wiped on every server restart -- which happens on every deploy,
// and periodically for the HA add-on regardless -- forcing a full re-fetch
// of the whole library's TMDB data (two requests per title as of the
// runtime/tagline/director/certification/trailer enrichment: a search
// request plus a details request) right after every restart. This persists
// the same lookups through Redis so a restart doesn't throw that away.
//
// Unlike the ffprobe cache (mediaProbeCache.js), TMDB's own data for a
// title can legitimately change over time (rating updates as more people
// vote, a trailer gets added later, certification gets filled in) so
// entries expire rather than being kept forever.
const CACHE_PREFIX = "movieserver:v1:tmdb";
const TTL_SECONDS = 7 * 24 * 60 * 60;
// A "no match" result is far more likely to go stale than a real one - the
// scraper regularly picks up very recently announced/upcoming titles before
// TMDB has an entry for them yet. Caching that miss for the same 7 days as
// a real match meant a title could sit posterless for up to a week after
// TMDB actually added it. Retried much sooner instead, while still not
// hammering TMDB every 4-hour listing refresh for genuinely unmatchable junk.
const NO_MATCH_TTL_SECONDS = 6 * 60 * 60;

let client = null;

async function initTmdbCache(redisUrl) {
  if (!redisUrl) return false;
  client = createClient({ url: redisUrl });
  client.on("error", (err) => console.warn("[tmdb-cache]", err.message));
  await client.connect();
  return true;
}

function isReady() {
  return Boolean(client?.isReady);
}

function keyFor(cacheKey) {
  return `${CACHE_PREFIX}:${cacheKey}`;
}

async function getCachedTmdb(cacheKey) {
  if (!isReady()) return undefined;
  try {
    const raw = await client.get(keyFor(cacheKey));
    // Distinguish "not cached" (undefined) from "cached as no match"
    // (null, a real, meaningful answer worth remembering) — searchMedia
    // itself already caches null matches in-memory for this same reason.
    return raw === null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

async function setCachedTmdb(cacheKey, meta) {
  if (!isReady()) return;
  try {
    const ttl = meta === null ? NO_MATCH_TTL_SECONDS : TTL_SECONDS;
    await client.set(keyFor(cacheKey), JSON.stringify(meta), { EX: ttl });
  } catch {
    // Best-effort — a failed cache write shouldn't affect the response
    // that already has the freshly-fetched result.
  }
}

module.exports = { initTmdbCache, isReady, getCachedTmdb, setCachedTmdb };
