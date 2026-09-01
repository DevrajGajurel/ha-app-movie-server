const crypto = require("crypto");
const { createClient } = require("redis");

const CACHE_PREFIX = "movieserver:v2:listing";
const DEFAULT_REFRESH_MS = 4 * 60 * 60 * 1000;

let client = null;
let refreshTimer = null;
let refreshInProgress = false;
let refreshStartedAt = null;
let scrapeFn = null;
let getListingConfig = null;
// Set at the top of every setInterval tick, unconditionally - the one
// direct way to answer "is the scheduler actually firing on schedule at
// all", as opposed to inferring it indirectly from cacheUpdatedAt (which a
// manual ?refresh=true also updates, via a completely separate code path -
// see getMovies below - so it can look like refreshing "works" even while
// the scheduled timer itself is doing nothing).
let schedulerLastTickAt = null;
let schedulerTickCount = 0;

// A full refresh (every scraped page, every movie's download link resolved,
// TMDB enrichment) normally finishes in well under a minute - this is
// deliberately many times that, not a tight budget, so it only ever kicks
// in when something is genuinely stuck, not just slow.
const STALE_REFRESH_MS = 15 * 60 * 1000;

// Deliberately independent of mainUrl and maxPages: the scraped source is a
// piracy-mirror site that rotates domains constantly, but the underlying
// catalog it serves is the same. Keying the cache by mainUrl orphaned the
// entire cache on every domain rotation (and maxPages tweak), forcing a
// full re-scrape for no real reason. tmdbEnabled is kept because it's the
// one thing that actually changes the shape of cached movie objects
// (enriched with TMDB data or not). mainUrl/maxPages are still recorded in
// the meta blob below for visibility, just not used as the cache key.
function listingId(config) {
  return crypto
    .createHash("sha256")
    .update(config.tmdbEnabled ? "tmdb" : "notmdb")
    .digest("hex")
    .slice(0, 16);
}

function pageKey(id, page) {
  return `${CACHE_PREFIX}:${id}:page:${page}`;
}

function metaKey(id) {
  return `${CACHE_PREFIX}:${id}:meta`;
}

function isReady() {
  return Boolean(client?.isReady);
}

async function getMeta(id) {
  const raw = await client.get(metaKey(id));
  return raw ? JSON.parse(raw) : null;
}

async function setPageCache(id, page, movies) {
  await client.set(pageKey(id, page), JSON.stringify(movies));
}

async function getPageCache(id, page) {
  const raw = await client.get(pageKey(id, page));
  return raw ? JSON.parse(raw) : null;
}

async function getPageCaches(id, from, to) {
  if (from > to) return [];

  const keys = [];
  for (let page = from; page <= to; page += 1) {
    keys.push(pageKey(id, page));
  }

  const raw = await client.mGet(keys);
  return raw.map((value) => (value ? JSON.parse(value) : null));
}

async function upsertMeta(id, partial) {
  const existing = (await getMeta(id)) || {};
  const meta = {
    ...existing,
    ...partial,
    updatedAt: new Date().toISOString(),
  };
  await client.set(metaKey(id), JSON.stringify(meta));
  return meta;
}

async function refreshPageRange(from, to, reason) {
  const config = getListingConfig();
  const id = listingId(config);
  console.log(`[cache] refreshing pages ${from}-${to} (${reason})`);

  for (let page = from; page <= to; page++) {
    const movies = await scrapeFn(page, page);
    await setPageCache(id, page, movies);
  }

  return upsertMeta(id, {
    source: config.mainUrl,
    maxPages: config.maxPages,
    tmdbEnabled: config.tmdbEnabled,
    reason,
  });
}

async function refreshAllPages(reason) {
  if (!isReady()) return null;

  // Confirmed real risk: nothing in the scrape chain this calls into (page
  // fetches, per-movie download-link resolution, TMDB enrichment) has a
  // timeout, so a single hung request anywhere in it means this promise
  // never settles - refreshInProgress would stay true forever, and every
  // scheduled refresh after that (every refreshMs, indefinitely) would
  // silently no-op with no error at all. That's a much worse failure mode
  // than occasionally starting two refreshes at once, so a stuck flag gets
  // overridden here rather than blocking refreshes for good.
  if (refreshInProgress) {
    const stuckMs = refreshStartedAt ? Date.now() - refreshStartedAt : 0;
    if (stuckMs < STALE_REFRESH_MS) return null;
    console.warn(
      `[cache] previous refresh has been "in progress" for ${Math.round(stuckMs / 60000)}min - treating it as stuck and proceeding anyway (${reason})`
    );
  }

  refreshInProgress = true;
  refreshStartedAt = Date.now();
  try {
    const config = getListingConfig();
    const meta = await refreshPageRange(1, config.maxPages, reason);
    console.log(`[cache] refresh complete (${reason})`);
    return meta;
  } finally {
    refreshInProgress = false;
    refreshStartedAt = null;
  }
}

function scheduleBackgroundRefresh(refreshMs) {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    // Recorded unconditionally, before refreshAllPages even runs - this is
    // proof the timer itself fired, independent of whether the refresh it
    // triggers actually completes, gets skipped (still in progress), or
    // fails outright.
    schedulerLastTickAt = Date.now();
    schedulerTickCount += 1;
    refreshAllPages("scheduled").catch((err) => {
      console.warn("[cache] scheduled refresh failed:", err.message);
    });
  }, refreshMs);
}

async function initMovieCache({ redisUrl, scrapeMoviesRange, getConfig, refreshMs = DEFAULT_REFRESH_MS }) {
  // getMovies()/getCacheStatus() below need scrapeFn/getListingConfig even
  // when Redis is disabled (they still serve live, uncached scrapes) — this
  // must run before the early return, or every listing request throws.
  scrapeFn = scrapeMoviesRange;
  getListingConfig = getConfig;

  if (!redisUrl) {
    console.log("Redis:      disabled (set REDIS_URL to enable listing cache)");
    return false;
  }

  client = createClient({ url: redisUrl });
  client.on("error", (err) => console.warn("[redis]", err.message));
  await client.connect();
  console.log(`Redis:      connected (refresh every ${Math.round(refreshMs / 3600000)}h)`);

  scheduleBackgroundRefresh(refreshMs);
  refreshAllPages("startup").catch((err) => {
    console.warn("[cache] startup warm failed:", err.message);
  });

  return true;
}

async function getCacheStatus() {
  if (!isReady()) {
    return { cacheEnabled: false, cacheUpdatedAt: null };
  }

  const config = getListingConfig();
  const meta = await getMeta(listingId(config));
  return {
    cacheEnabled: true,
    cacheUpdatedAt: meta?.updatedAt || null,
    // Which of startup/scheduled/manual last actually completed - without
    // this, a manual ?refresh=true updating cacheUpdatedAt looks identical
    // to a real scheduled run, which is exactly the ambiguity that made a
    // dead scheduler hard to tell apart from a working one.
    lastRefreshReason: meta?.reason || null,
    // Whether a refresh is running right now, and (if so) whether it's
    // past the point this module would consider it stale/stuck - see
    // refreshAllPages's STALE_REFRESH_MS.
    refreshInProgress,
    refreshStartedAt: refreshStartedAt ? new Date(refreshStartedAt).toISOString() : null,
    // Proof the scheduled timer itself is firing, independent of whether
    // each tick's refresh actually completes.
    schedulerLastTickAt: schedulerLastTickAt ? new Date(schedulerLastTickAt).toISOString() : null,
    schedulerTickCount,
  };
}

async function getMovies(from, to, { refresh = false } = {}) {
  const config = getListingConfig();

  if (!isReady()) {
    const movies = [];
    for (let page = from; page <= to; page += 1) {
      movies.push(...(await scrapeFn(page, page)));
    }
    return {
      movies,
      cached: false,
      cacheUpdatedAt: null,
      refreshed: refresh,
      source: config.mainUrl,
      maxPages: config.maxPages,
      initialPages: config.initialPages,
      from,
      to,
      tmdbEnabled: config.tmdbEnabled,
    };
  }

  const id = listingId(config);

  if (refresh) {
    await refreshPageRange(from, to, "manual");
  }

  const movies = [];
  let cacheHit = !refresh;
  const cachedPages = refresh ? [] : await getPageCaches(id, from, to);

  for (let page = from; page <= to; page += 1) {
    let pageMovies = refresh ? null : cachedPages[page - from];
    if (!pageMovies) {
      cacheHit = false;
      pageMovies = await scrapeFn(page, page);
      await setPageCache(id, page, pageMovies);
    }
    movies.push(...pageMovies);
  }

  const meta = await getMeta(id);

  return {
    movies,
    cached: cacheHit,
    cacheUpdatedAt: meta?.updatedAt || null,
    refreshed: refresh,
    source: config.mainUrl,
    maxPages: config.maxPages,
    initialPages: config.initialPages,
    from,
    to,
    tmdbEnabled: config.tmdbEnabled,
  };
}

async function closeMovieCache() {
  if (refreshTimer) clearInterval(refreshTimer);
  if (client?.isOpen) await client.quit();
}

module.exports = {
  initMovieCache,
  getMovies,
  getCacheStatus,
  refreshAllPages,
  closeMovieCache,
  isCacheEnabled: isReady,
};
