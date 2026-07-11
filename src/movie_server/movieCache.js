const crypto = require("crypto");
const { createClient } = require("redis");

const CACHE_PREFIX = "movieserver:v2:listing";
const DEFAULT_REFRESH_MS = 4 * 60 * 60 * 1000;

let client = null;
let refreshTimer = null;
let refreshInProgress = false;
let scrapeFn = null;
let getListingConfig = null;

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
  });
}

async function refreshAllPages(reason) {
  if (!isReady() || refreshInProgress) return null;

  refreshInProgress = true;
  try {
    const config = getListingConfig();
    const meta = await refreshPageRange(1, config.maxPages, reason);
    console.log(`[cache] refresh complete (${reason})`);
    return meta;
  } finally {
    refreshInProgress = false;
  }
}

function scheduleBackgroundRefresh(refreshMs) {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    refreshAllPages("scheduled").catch((err) => {
      console.warn("[cache] scheduled refresh failed:", err.message);
    });
  }, refreshMs);
}

async function initMovieCache({ redisUrl, scrapeMoviesRange, getConfig, refreshMs = DEFAULT_REFRESH_MS }) {
  if (!redisUrl) {
    console.log("Redis:      disabled (set REDIS_URL to enable listing cache)");
    return false;
  }

  scrapeFn = scrapeMoviesRange;
  getListingConfig = getConfig;

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

  for (let page = from; page <= to; page += 1) {
    let pageMovies = refresh ? null : await getPageCache(id, page);
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
