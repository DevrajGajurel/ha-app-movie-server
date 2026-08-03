const fs = require("fs");
const path = require("path");

const ENV_CANDIDATES = [
  path.join(__dirname, ".env"),
  path.join(__dirname, "..", "..", ".env"),
];
const ENV_PATH = ENV_CANDIDATES.find((candidate) => fs.existsSync(candidate)) || ENV_CANDIDATES[0];

require("dotenv").config({ path: ENV_PATH, override: true });

const http = require("http");
const { parseHTML } = require("linkedom");
const { enrichMovies } = require("./tmdb");
const { initTmdbCache } = require("./tmdbCache");
const { parseKeywordList, tagQuality } = require("./quality");
const { streamYoutubeTrailer } = require("./trailer");
const {
  startDownload,
  getJob,
  listJobs,
  initDownloadDir,
  getDownloadDir,
  scanLibrary,
  findMediaFile,
  findMediaFiles,
  deleteMedia,
  resolveMediaToken,
  probeMediaFile,
  streamFile,
  streamAudioTrackRemux,
  needsAudioTranscode,
  needsH264LevelFix,
  getSubtitleVtt,
  prefetchAllSubtitles,
  saveProgress,
  getProgress,
  listProgress,
  listM3u8Playlists,
  resolveM3u8Token,
  streamM3u8Playlist,
} = require("./fileDownloads");
const { isEmbyConfigured, refreshLibrary, refreshAfterDownload, notifyAfterDelete } = require("./emby");
const { resolveRedirectUrl } = require("./urlUtils");
const { initMovieCache, getMovies, getCacheStatus } = require("./movieCache");
const { initProbeCache } = require("./mediaProbeCache");
const { PROXY_PREFIX: CINEBY_PROXY_PREFIX, handleCinebyProxy } = require("./cinebyProxy");
const { PROXY_PREFIX: HLS_PROXY_PREFIX, handleHlsProxy, REFERER_DEFAULT } = require("./hlsProxy");
const {
  initStreamCatalog,
  getCatalog,
  refreshCatalog,
  getRefreshStatus,
} = require("./streamCatalog");
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const PORT = Number(process.env.PORT) || 3001;
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_PAGES_LIMIT = 100;
const DEFAULT_HD_KEYWORDS = "720p,1080p,HD,HDRip,WEB-DL,BluRay,Blu-Ray";
const DEFAULT_K4_KEYWORDS = "2160p,4k,4K,UHD";

function resolveKeywords(envValue, fallback) {
  const parsed = parseKeywordList(envValue);
  return parsed.length ? parsed : parseKeywordList(fallback);
}

const HD_KEYWORDS = resolveKeywords(process.env.HD_KEYWORDS, DEFAULT_HD_KEYWORDS);
const K4_KEYWORDS = resolveKeywords(process.env.K4_KEYWORDS, DEFAULT_K4_KEYWORDS);

let mainUrl = process.env.MAIN_URL;
let maxPages = parseMaxPages(process.env.MAX_PAGES);
let initialPages = parseInitialPages(process.env.INITIAL_PAGES);
let cinebyUrl = String(process.env.CINEBY_URL || "").trim();

function isHomeAssistantAddon() {
  return process.env.HOME_ASSISTANT_ADDON === "true";
}

function getConfigPayload(extra = {}) {
  return {
    mainUrl,
    maxPages,
    initialPages,
    cinebyUrl,
    embyConfigured: isEmbyConfigured(),
    configEditable: !isHomeAssistantAddon(),
    ...extra,
  };
}

async function getConfigPayloadAsync(extra = {}) {
  const cacheStatus = await getCacheStatus();
  return getConfigPayload({ ...cacheStatus, ...getScrapeHealthPayload(), ...extra });
}

// Tracks whether the source site is actually reachable, independent of the
// Redis cache: a warm cache can keep serving stale data (and every request
// looking "successful") for hours after the source domain has died, which
// is exactly when this needs to be visible. Recorded on every real fetch to
// mainUrl (see scrapePage below), from both the on-demand and
// background-refresh scrape paths, and surfaced via /api/config so the HA
// integration can expose it as a sensor.
const scrapeHealth = {
  lastSuccessAt: null,
  lastErrorAt: null,
  lastError: null,
};

function recordScrapeSuccess() {
  scrapeHealth.lastSuccessAt = new Date().toISOString();
}

function recordScrapeError(err) {
  // Node's fetch() wraps DNS/connection failures in a generic "fetch
  // failed" TypeError with the actual reason (e.g. ENOTFOUND for a dead
  // domain) nested in .cause — surface that instead of the useless outer
  // message, since it's exactly what tells you "go rotate the source URL".
  const detail = err.cause?.message || err.cause?.code;
  scrapeHealth.lastErrorAt = new Date().toISOString();
  scrapeHealth.lastError = detail ? `${err.message}: ${detail}` : err.message;
}

function getScrapeHealthPayload() {
  // ISO 8601 UTC timestamps compare correctly as plain strings.
  const ok = !scrapeHealth.lastErrorAt || (scrapeHealth.lastSuccessAt && scrapeHealth.lastSuccessAt > scrapeHealth.lastErrorAt);
  return {
    scrapeOk: Boolean(ok),
    scrapeLastSuccessAt: scrapeHealth.lastSuccessAt,
    scrapeLastErrorAt: scrapeHealth.lastErrorAt,
    scrapeLastError: ok ? null : scrapeHealth.lastError,
  };
}

function parseInitialPages(value) {
  const pages = Number.parseInt(value, 10);
  if (!Number.isFinite(pages) || pages < 1) return 2;
  return Math.min(pages, MAX_PAGES_LIMIT);
}

if (!mainUrl) {
  console.error("MAIN_URL is required. Set it in .env or your environment.");
  process.exit(1);
}

initDownloadDir();

function parseMaxPages(value) {
  const pages = Number.parseInt(value, 10);
  if (!Number.isFinite(pages) || pages < 1) return 1;
  return Math.min(pages, MAX_PAGES_LIMIT);
}

function readEnvFile() {
  return fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : "";
}

function setEnvVar(key, value) {
  let content = readEnvFile();
  const line = `${key}=${value}`;
  const regex = new RegExp(`^${key}=.*$`, "m");

  if (regex.test(content)) {
    content = content.replace(regex, line);
  } else {
    content = content.trimEnd() ? `${content.trimEnd()}\n${line}\n` : `${line}\n`;
  }

  fs.writeFileSync(ENV_PATH, content);
}

function persistConfig() {
  try {
    setEnvVar("MAIN_URL", mainUrl);
    setEnvVar("MAX_PAGES", String(maxPages));
    setEnvVar("INITIAL_PAGES", String(initialPages));
    setEnvVar("CINEBY_URL", cinebyUrl);
  } catch (err) {
    console.warn("Could not write .env:", err.message);
  }
}

function setMainUrl(newUrl) {
  mainUrl = newUrl;
  process.env.MAIN_URL = newUrl;
  persistConfig();
}

function setMaxPages(pages) {
  maxPages = parseMaxPages(pages);  
  process.env.MAX_PAGES = String(maxPages);
  persistConfig();
}

function setCinebyUrl(newUrl) {
  cinebyUrl = String(newUrl || "").trim();
  process.env.CINEBY_URL = cinebyUrl;
  persistConfig();
}

function buildPageUrl(baseUrl, page) {
  const url = new URL(baseUrl);
  if (page > 1) {
    url.searchParams.set("page", String(page));
  } else {
    url.searchParams.delete("page");
  }
  return url.href;
}

function buildSearchUrl(baseUrl, query) {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = new URL("search.html", base);
  url.searchParams.set("search", query);
  return url.href;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// The homepage/listing pages render a "Trending"/ad section before the
// actual "Latest Movies" grid, and both sections reuse the same anchor
// class, so filtering by class alone can't tell them apart — find the
// heading and only keep .row-thumb-link anchors that come after it.
//
// linkedom's Node.compareDocumentPosition is NOT a reliable document-order
// check: it's a heuristic based on ancestor depth / sibling index that only
// works when both nodes share a parent or are directly nested, and gives
// wrong answers for elements in different subtrees at different nesting
// depths (confirmed: it placed the Trending section's anchors "after" the
// Latest Movies heading, which they weren't). document.querySelectorAll("*")
// is spec-guaranteed to return elements in true document order, so build an
// index from that instead of trusting compareDocumentPosition.
function findLatestMoviesMarker(document) {
  return [...document.querySelectorAll("h1, h2, h3, h4")].find((el) =>
    /latest\s*movies/i.test(el.textContent || "")
  );
}

function documentOrderIndex(document) {
  const index = new Map();
  [...document.querySelectorAll("*")].forEach((el, i) => index.set(el, i));
  return index;
}

function scrapePage(pageUrl) {
  return fetch(pageUrl)
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`Failed to fetch ${pageUrl}: ${response.status}`);
      }

      const html = await response.text();
      const { document } = parseHTML(html);

      const marker = findLatestMoviesMarker(document);
      const order = marker ? documentOrderIndex(document) : null;
      const markerIndex = order?.get(marker);
      const anchors = [...document.querySelectorAll(".row-thumb-link")].filter(
        (a) => markerIndex === undefined || order.get(a) > markerIndex
      );

      const results = anchors.map((a) => ({
        title: a.querySelector("img")?.alt ?? "",
        link: new URL(a.getAttribute("href"), pageUrl).href,
      }));
      recordScrapeSuccess();
      return results;
    })
    .catch((err) => {
      recordScrapeError(err);
      throw err;
    });
}

function sortDownloadOptions(options) {
  return options.sort((a, b) => {
    const aHasGb = /gb/i.test(a.label);
    const bHasGb = /gb/i.test(b.label);
    if (aHasGb !== bHasGb) return aHasGb ? -1 : 1;
    return b.label.localeCompare(a.label);
  });
}

const DOWNLOAD_SELECTORS = {
  quality: [".dlink.dl a", ".dlbtn a", ".dlbtn a.bg2", "a.bg2"],
  direct: ['a[class*="button"]'],
  resolvedListing: [".dlbtn a"],
};

async function fetchPageHtml(pageUrl) {
  const response = await fetch(pageUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch download page: ${response.status}`);
  }
  return response.text();
}

// The source site periodically rotates domains (filmyfly.luxe -> .faith ->
// .fail, etc). When it does, requesting an old-domain page URL still gets a
// 200 back (fetch() follows the redirect automatically) but the redirect
// often lands on the new domain's bare homepage, not the equivalent page -
// so every selector below comes back with 0 matches even though nothing is
// actually broken. resolveRedirectUrl(mainUrl) is the same lookup the HA
// integration's sensor uses to detect a rotated domain, so on a selector
// miss we reuse it here: take whatever origin it resolves to and retry the
// exact same page path against that origin.
async function resolveRetryPageUrl(pageUrl) {
  const resolvedBase = await resolveRedirectUrl(mainUrl);
  const original = new URL(pageUrl);
  return new URL(`${original.pathname}${original.search}`, resolvedBase).href;
}

async function fetchDownloadPageDocument(pageUrl) {
  const html = await fetchPageHtml(pageUrl);
  return parseHTML(html).document;
}

function selectorDiagnostics(document, selectors) {
  return selectors.map((selector) => ({
    selector,
    matches: document.querySelectorAll(selector).length,
  }));
}

function collectAnchors(document, selectors) {
  const seen = new Set();
  const anchors = [];

  for (const selector of selectors) {
    for (const anchor of document.querySelectorAll(selector)) {
      const href = anchor.getAttribute("href");
      if (!href || seen.has(href)) continue;
      seen.add(href);
      anchors.push(anchor);
    }
  }

  return anchors;
}

async function fetchDownloadOptions(pageUrl) {
  let document = await fetchDownloadPageDocument(pageUrl);
  const selectors = DOWNLOAD_SELECTORS.quality;
  let anchors = collectAnchors(document, selectors);

  if (!anchors.length) {
    try {
      const retryUrl = await resolveRetryPageUrl(pageUrl);
      if (retryUrl !== pageUrl) {
        document = await fetchDownloadPageDocument(retryUrl);
        anchors = collectAnchors(document, selectors);
      }
    } catch (err) {
      console.warn("[downloads] retry via resolved main URL failed:", err.message);
    }
  }

  return {
    options: sortDownloadOptions(anchors.map((anchor) => ({
      label: (anchor.querySelector(".dll")?.textContent || anchor.textContent || "Download").trim(),
      href: new URL(anchor.getAttribute("href"), pageUrl).href,
    }))),
    selectors: selectorDiagnostics(document, selectors),
  };
}

async function fetchDirectDownloadOptions(pageUrl) {
  let document = await fetchDownloadPageDocument(pageUrl);
  const selectors = DOWNLOAD_SELECTORS.direct;
  let anchors = selectors.flatMap((selector) => [...document.querySelectorAll(selector)]);

  if (!anchors.length) {
    try {
      const retryUrl = await resolveRetryPageUrl(pageUrl);
      if (retryUrl !== pageUrl) {
        document = await fetchDownloadPageDocument(retryUrl);
        anchors = selectors.flatMap((selector) => [...document.querySelectorAll(selector)]);
      }
    } catch (err) {
      console.warn("[downloads] retry via resolved main URL failed:", err.message);
    }
  }

  return {
    options: sortDownloadOptions(anchors.map((anchor) => ({
      label: (anchor.textContent || "Download").trim(),
      href: new URL(anchor.getAttribute("href"), pageUrl).href,
    }))),
    selectors: selectorDiagnostics(document, selectors),
  };
}

async function resolveDownloadLink(detailUrl) {
  try {
    const response = await fetch(detailUrl);
    if (!response.ok) return detailUrl;

    const html = await response.text();
    const { document } = parseHTML(html);
    const anchor = document.querySelector(".dlbtn a");
    const href = anchor?.getAttribute("href");
    if (!href) return detailUrl;

    return new URL(href, detailUrl).href;
  } catch {
    return detailUrl;
  }
}

async function resolveDownloadLinks(movies, concurrency = 5) {
  const resolved = [...movies];

  for (let i = 0; i < resolved.length; i += concurrency) {
    const batch = resolved.slice(i, i + concurrency);
    const links = await Promise.all(batch.map((movie) => resolveDownloadLink(movie.link)));
    links.forEach((link, j) => {
      resolved[i + j] = { ...resolved[i + j], link };
    });
  }

  return resolved;
}

async function scrapeMoviesRange(fromPage, toPage) {
  const start = Math.max(1, Math.min(fromPage, toPage));
  const end = Math.min(maxPages, Math.max(fromPage, toPage));
  const seen = new Set();
  const movies = [];

  for (let page = start; page <= end; page++) {
    const pageUrl = buildPageUrl(mainUrl, page);
    const pageMovies = await scrapePage(pageUrl);

    for (const movie of pageMovies) {
      const tagged = tagQuality(movie, HD_KEYWORDS, K4_KEYWORDS);
      if (!seen.has(tagged.link)) {
        seen.add(tagged.link);
        movies.push(tagged);
      }
    }
  }

  const withDownloadLinks = await resolveDownloadLinks(movies);

  let result = withDownloadLinks;
  if (TMDB_API_KEY) {
    result = await enrichMovies(withDownloadLinks, TMDB_API_KEY);
  }

  return result.map((movie) => tagQuality(movie, HD_KEYWORDS, K4_KEYWORDS));
}

async function searchSourceMovies(query) {
  const q = String(query || "").trim();
  if (!q) return [];

  const searchUrl = buildSearchUrl(mainUrl, q);
  const pageMovies = await scrapePage(searchUrl);
  const seen = new Set();
  const movies = [];

  for (const movie of pageMovies) {
    const tagged = tagQuality(movie, HD_KEYWORDS, K4_KEYWORDS);
    if (!seen.has(tagged.link)) {
      seen.add(tagged.link);
      movies.push(tagged);
    }
  }

  const withDownloadLinks = await resolveDownloadLinks(movies);
  let result = withDownloadLinks;
  if (TMDB_API_KEY) {
    result = await enrichMovies(withDownloadLinks, TMDB_API_KEY);
  }

  return result.map((movie) => tagQuality(movie, HD_KEYWORDS, K4_KEYWORDS));
}

async function scrapeMovies() {
  return scrapeMoviesRange(1, maxPages);
}

function parsePageRange(searchParams) {
  const from = Number.parseInt(searchParams.get("from") || "1", 10);
  const to = Number.parseInt(searchParams.get("to") || String(maxPages), 10);

  return {
    from: Number.isFinite(from) ? Math.max(1, Math.min(from, maxPages)) : 1,
    to: Number.isFinite(to) ? Math.max(1, Math.min(to, maxPages)) : maxPages,
  };
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function serveFile(res, filePath) {
  const ext = path.extname(filePath);
  const types = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
  };

  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url?.split("?")[0] ?? "/";

  // Allows a locally-packaged client (e.g. the Tizen TV app in tizen/)
  // to call this server's API from a different origin.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (url === CINEBY_PROXY_PREFIX || url.startsWith(`${CINEBY_PROXY_PREFIX}/`)) {
    try {
      await handleCinebyProxy(req, res, cinebyUrl);
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { error: err.message });
    }
    return;
  }

  if (url.startsWith(HLS_PROXY_PREFIX)) {
    try {
      await handleHlsProxy(req, res);
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { error: err.message });
    }
    return;
  }

  if (url === "/api/streams" && req.method === "GET") {
    try {
      const catalog = await getCatalog();
      const movies = (catalog.movies || [])
        .filter((m) => Array.isArray(m.streams) && m.streams.length > 0)
        .map((m) => normalizeStreamMovie(m));
      sendJson(res, 200, {
        refreshedAt: catalog.refreshedAt || null,
        window: catalog.window || null,
        count: movies.length,
        playable: movies.length,
        refreshing: Boolean(catalog.refreshing),
        lastError: catalog.lastError || catalog.error || null,
        refererHint: catalog.refererHint || REFERER_DEFAULT,
        movies,
      });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  if (url === "/api/streams/refresh" && req.method === "POST") {
    try {
      const status = getRefreshStatus();
      if (status.refreshing) {
        sendJson(res, 202, { ok: false, refreshing: true, message: "Refresh already in progress" });
        return;
      }
      // Kick off in background so the HTTP call returns quickly; clients poll GET /api/streams.
      refreshCatalog("manual").catch((err) => {
        console.warn("[streams] manual refresh failed:", err.message);
      });
      sendJson(res, 202, { ok: true, refreshing: true, message: "Refresh started" });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  if (url === "/api/config" && req.method === "GET") {
    sendJson(res, 200, await getConfigPayloadAsync());
    return;
  }

  if (url === "/api/config" && req.method === "PUT") {
    if (isHomeAssistantAddon()) {
      sendJson(res, 403, { error: "Config is managed by the Home Assistant add-on options." });
      return;
    }

    try {
      const body = JSON.parse(await readBody(req));

      if (body.mainUrl !== undefined) {
        const nextUrl = String(body.mainUrl).trim();
        if (!nextUrl) {
          sendJson(res, 400, { error: "mainUrl is required" });
          return;
        }
        new URL(nextUrl);
        setMainUrl(nextUrl);
      }

      if (body.maxPages !== undefined) {
        const nextPages = Number.parseInt(body.maxPages, 10);
        if (!Number.isFinite(nextPages) || nextPages < 1 || nextPages > MAX_PAGES_LIMIT) {
          sendJson(res, 400, { error: `maxPages must be between 1 and ${MAX_PAGES_LIMIT}` });
          return;
        }
        setMaxPages(nextPages);
      }

      if (body.cinebyUrl !== undefined) {
        const nextCineby = String(body.cinebyUrl).trim();
        if (nextCineby) new URL(nextCineby);
        setCinebyUrl(nextCineby);
      }

      sendJson(res, 200, getConfigPayload({ message: "Config updated" }));
    } catch (err) {
      const message = err instanceof TypeError ? "Invalid URL" : err.message;
      sendJson(res, 400, { error: message });
    }
    return;
  }

  if (url === "/api/movies" || url === "/movies") {
    try {
      const searchParams = new URL(req.url, "http://localhost").searchParams;
      const range = parsePageRange(searchParams);
      const from = Math.min(range.from, range.to);
      const to = Math.max(range.from, range.to);
      const refresh =
        searchParams.get("refresh") === "1" || searchParams.get("refresh") === "true";
      const result = await getMovies(from, to, { refresh });
      sendJson(res, 200, {
        ...result,
        count: result.movies.length,
      });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  if ((url === "/api/movies/search" || url === "/movies/search") && req.method === "GET") {
    try {
      const query = new URL(req.url, "http://localhost").searchParams.get("q") || "";
      if (!String(query).trim()) {
        sendJson(res, 400, { error: "q query parameter is required" });
        return;
      }

      const movies = await searchSourceMovies(query);
      sendJson(res, 200, {
        query: String(query).trim(),
        searchUrl: buildSearchUrl(mainUrl, String(query).trim()),
        movies,
        count: movies.length,
        tmdbEnabled: Boolean(TMDB_API_KEY),
        source: mainUrl,
      });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  if (url === "/api/downloads/save" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req));
      const downloadUrl = String(body.url || "").trim();
      const label = String(body.label || "Download").trim();
      const movieTitle = body.movieTitle ? String(body.movieTitle).trim() : null;
      const tmdbId = body.tmdbId ? String(body.tmdbId).trim() : null;

      if (!downloadUrl) {
        sendJson(res, 400, { error: "url is required" });
        return;
      }

      new URL(downloadUrl);
      const job = startDownload({ url: downloadUrl, label, movieTitle, tmdbId });
      sendJson(res, 202, { message: "Download started", job });
    } catch (err) {
      const message = err instanceof TypeError ? "Invalid URL" : err.message;
      sendJson(res, 400, { error: message });
    }
    return;
  }

  if (url === "/api/downloads/jobs" && req.method === "GET") {
    sendJson(res, 200, { downloadDir: getDownloadDir(), jobs: listJobs() });
    return;
  }

  if (url === "/api/downloads/library" && req.method === "GET") {
    try {
      sendJson(res, 200, { downloadDir: getDownloadDir(), ...scanLibrary() });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  if (url === "/api/m3u8" && req.method === "GET") {
    try {
      const listed = listM3u8Playlists();
      let items = listed.items || [];
      if (TMDB_API_KEY && items.length) {
        const enriched = await enrichMovies(
          items.map((item) => ({ title: item.name, link: item.token })),
          TMDB_API_KEY
        );
        items = items.map((item, i) => ({
          ...item,
          tmdb: enriched[i]?.tmdb || null,
        }));
      }
      sendJson(res, 200, {
        dir: listed.dir,
        items,
        tmdbEnabled: Boolean(TMDB_API_KEY),
      });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  if (url === "/api/m3u8/play" && req.method === "GET") {
    try {
      const searchParams = new URL(req.url, "http://localhost").searchParams;
      const token = searchParams.get("file");
      const filePath = resolveM3u8Token(token);
      if (!filePath) {
        sendJson(res, 404, { error: "Playlist not found" });
        return;
      }
      streamM3u8Playlist(req, res, filePath);
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  if (url === "/api/downloads/media" && req.method === "DELETE") {
    try {
      const searchParams = new URL(req.url, "http://localhost").searchParams;
      const tmdbId = searchParams.get("tmdbId") || null;
      const title = searchParams.get("title") || null;

      if (!tmdbId && !title) {
        sendJson(res, 400, { error: "tmdbId or title is required" });
        return;
      }

      const { deletedDirs, deletedFiles } = deleteMedia({ tmdbId, title });
      if (!deletedDirs) {
        sendJson(res, 404, { error: "No downloaded media found for this title" });
        return;
      }

      for (const filePath of deletedFiles) {
        notifyAfterDelete(filePath).catch((err) => {
          console.warn(`[delete] Emby notify failed: ${err.message}`);
        });
      }

      sendJson(res, 200, { deletedDirs });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  if (url === "/api/downloads/play" && req.method === "GET") {
    try {
      const searchParams = new URL(req.url, "http://localhost").searchParams;
      const tmdbId = searchParams.get("tmdbId") || null;
      const title = searchParams.get("title") || null;
      const fileToken = searchParams.get("file") || null;
      const audioTrackParam = searchParams.get("audioTrack");
      const audioTrack = audioTrackParam !== null ? Number.parseInt(audioTrackParam, 10) : 0;
      // "raw" only bypasses the eac3->AAC workaround built for the old
      // <video>-element app (AVPlay decodes that natively, so forcing it
      // would just throw away embedded tracks for no reason) - it does
      // NOT mean "never touch the file." The H.264-level fix below applies
      // regardless, since that's a real format-rejection AVPlay itself
      // hits too, not something specific to the browser <video> element.
      const forceRaw = searchParams.get("raw") === "1";

      let filePath = fileToken ? resolveMediaToken(fileToken) : null;
      if (!filePath) {
        if (!tmdbId && !title) {
          sendJson(res, 400, { error: "tmdbId or title is required" });
          return;
        }
        filePath = findMediaFile({ tmdbId, title });
      }
      if (!filePath) {
        sendJson(res, 404, { error: "No downloaded file found for this title" });
        return;
      }

      // Track 0 is usually the file's own default audio, direct-played so
      // Range requests keep working for proper seeking. Any other track
      // requires remuxing since a raw byte stream can't switch which
      // embedded audio track plays - and so does track 0 itself when its
      // codec (Dolby Digital/Plus, DTS, TrueHD, ...) isn't something a
      // browser's <video> element can decode at all, regardless of the
      // hardware's own native decoder capability (confirmed: this is what
      // was crashing the TV on a file whose default track was eac3).
      const info = await probeMediaFile(filePath);
      const selectedTrack = info?.audioTracks?.[audioTrack];
      const transcodeAudio = !forceRaw && needsAudioTranscode(selectedTrack?.codec);
      // A file's H.264 level can be implausibly high for its actual
      // resolution (confirmed: AVPlay refused a plain 1080p-ish H.264/AAC
      // file outright - PLAYER_ERROR_NOT_SUPPORTED_FORMAT - because its
      // SPS declared Level 5.1, a tier meant for ~4K). Rewriting just that
      // header field costs nothing (no re-encode) and applies regardless
      // of raw=1, unlike the audio-transcode bypass above.
      const fixH264Level = needsH264LevelFix(info);

      if (audioTrack > 0 || transcodeAudio || fixH264Level) {
        streamAudioTrackRemux(req, res, filePath, audioTrack, { transcodeAudio, fixH264Level });
      } else {
        streamFile(req, res, filePath);
      }
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  if (url === "/api/downloads/subtitle" && req.method === "GET") {
    try {
      const searchParams = new URL(req.url, "http://localhost").searchParams;
      const fileToken = searchParams.get("file") || null;
      const trackParam = searchParams.get("track");
      const track = trackParam !== null ? Number.parseInt(trackParam, 10) : NaN;

      const filePath = fileToken ? resolveMediaToken(fileToken) : null;
      if (!filePath || !Number.isInteger(track) || track < 0) {
        sendJson(res, 400, { error: "file and a non-negative track index are required" });
        return;
      }

      const vtt = await getSubtitleVtt(filePath, track);
      res.writeHead(200, { "Content-Type": "text/vtt; charset=utf-8" });
      res.end(vtt);
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  if (url === "/api/trailer" && req.method === "GET") {
    const searchParams = new URL(req.url, "http://localhost").searchParams;
    await streamYoutubeTrailer(req, res, searchParams.get("key") || "");
    return;
  }

  if (url === "/api/downloads/versions" && req.method === "GET") {
    try {
      const searchParams = new URL(req.url, "http://localhost").searchParams;
      const tmdbId = searchParams.get("tmdbId") || null;
      const title = searchParams.get("title") || null;

      if (!tmdbId && !title) {
        sendJson(res, 400, { error: "tmdbId or title is required" });
        return;
      }

      const files = findMediaFiles({ tmdbId, title });
      const versions = await Promise.all(
        files.map(async (file) => {
          const probe = await probeMediaFile(file.path);
          return {
            token: file.token,
            filename: file.filename,
            size: file.size,
            duration: probe?.durationSeconds ?? null,
            width: probe?.width ?? null,
            height: probe?.height ?? null,
            videoCodec: probe?.videoCodec ?? null,
            videoProfile: probe?.videoProfile ?? null,
            videoBitDepth: probe?.videoBitDepth ?? null,
            videoLevel: probe?.videoLevel ?? null,
            audioTracks: probe?.audioTracks ?? [],
            subtitleTracks: probe?.subtitleTracks ?? [],
          };
        })
      );

      sendJson(res, 200, { versions });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  if (url === "/api/downloads/progress" && req.method === "GET") {
    try {
      const searchParams = new URL(req.url, "http://localhost").searchParams;
      const tmdbId = searchParams.get("tmdbId") || null;
      const title = searchParams.get("title") || null;
      const file = searchParams.get("file") || null;

      // No identifiers → Continue Watching list for home rails.
      if (!tmdbId && !title && !file) {
        sendJson(res, 200, { items: listProgress() });
        return;
      }

      if (!tmdbId && !title) {
        sendJson(res, 400, { error: "tmdbId or title is required" });
        return;
      }

      sendJson(res, 200, { progress: getProgress({ tmdbId, title, fileToken: file }) });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  if (url === "/api/downloads/progress" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req));
      const tmdbId = body.tmdbId ? String(body.tmdbId) : null;
      const title = body.title ? String(body.title) : null;
      const fileToken = body.file ? String(body.file) : null;
      const positionSeconds = Number(body.positionSeconds);
      const durationSeconds = Number(body.durationSeconds);
      const audioTrack = Number.isInteger(body.audioTrack) ? body.audioTrack : 0;
      const subtitleTrack = Number.isInteger(body.subtitleTrack) ? body.subtitleTrack : null;

      if ((!tmdbId && !title) || !Number.isFinite(positionSeconds) || !Number.isFinite(durationSeconds)) {
        sendJson(res, 400, { error: "tmdbId/title and numeric positionSeconds/durationSeconds are required" });
        return;
      }

      saveProgress({ tmdbId, title, fileToken, positionSeconds, durationSeconds, audioTrack, subtitleTrack });
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // The TV app runs on hardware we can't easily attach a debugger or
  // `sdb dlog` to from a dev machine, and Tizen's own error surface (a
  // generic on-screen message, sometimes followed by the whole TV
  // rebooting on an unsupported codec) doesn't leave anything to inspect
  // afterward. This just forwards whatever the client caught to the
  // server's own log output (visible via the HA add-on's Log tab / `docker
  // logs`), so a crash report is something we can actually read.
  if (url === "/api/client-log" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req));
      const { source, message, stack, context } = body || {};
      const line =
        `[${new Date().toISOString()}] ${source || "unknown"}: ${message || "(no message)"}` +
        (context ? ` | context: ${JSON.stringify(context)}` : "") +
        (stack ? ` | stack: ${String(stack).replace(/\s+/g, " ")}` : "");

      console.error(`[client-log] ${line}`);

      // Also written next to the downloaded movies themselves - same
      // network share the user already browses, so reading a crash report
      // doesn't require going through the HA add-on's Log tab or SSH.
      try {
        fs.appendFileSync(path.join(getDownloadDir(), "movieserver-client.log"), `${line}\n`);
      } catch (fileErr) {
        console.warn("[client-log] failed to write log file:", fileErr.message);
      }
    } catch (err) {
      console.warn("[client-log] failed to parse client log payload:", err.message);
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  // Companion read side for the log above - there's no other remote way to
  // pull this file back (the existing download/media routes only serve
  // recognized video extensions), and a TV crash leaves nothing else to
  // inspect after the fact.
  if (url === "/api/client-log" && req.method === "GET") {
    try {
      const logPath = path.join(getDownloadDir(), "movieserver-client.log");
      const content = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
      const lines = content.split("\n").filter(Boolean);
      const limit = Number(new URL(req.url, "http://localhost").searchParams.get("lines")) || 200;
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(lines.slice(-limit).join("\n"));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`Failed to read log: ${err.message}`);
    }
    return;
  }

  if (url === "/api/emby/status" && req.method === "GET") {
    sendJson(res, 200, { configured: isEmbyConfigured() });
    return;
  }

  if (url === "/api/emby/refresh" && req.method === "POST") {
    try {
      const result = await refreshLibrary();
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  if (url === "/api/redirect" && req.method === "GET") {
    try {
      const targetUrl = new URL(req.url, "http://localhost").searchParams.get("url");
      if (!targetUrl) {
        sendJson(res, 400, { error: "url query parameter is required" });
        return;
      }

      new URL(targetUrl);
      const finalUrl = await resolveRedirectUrl(targetUrl);
      sendJson(res, 200, { url: finalUrl });
    } catch (err) {
      const message = err instanceof TypeError ? "Invalid URL" : err.message;
      sendJson(res, 500, { error: message });
    }
    return;
  }

  if (url === "/api/downloads" && req.method === "GET") {
    try {
      const pageUrl = new URL(req.url, "http://localhost").searchParams.get("url");
      if (!pageUrl) {
        sendJson(res, 400, { error: "url query parameter is required" });
        return;
      }

      new URL(pageUrl);
      const type = new URL(req.url, "http://localhost").searchParams.get("type") || "quality";
      const result =
        type === "direct"
          ? await fetchDirectDownloadOptions(pageUrl)
          : await fetchDownloadOptions(pageUrl);
      sendJson(res, 200, {
        url: pageUrl,
        type,
        count: result.options.length,
        options: result.options,
        selectors: result.selectors,
      });
    } catch (err) {
      const message = err instanceof TypeError ? "Invalid URL" : err.message;
      sendJson(res, 500, { error: message });
    }
    return;
  }

  if (url === "/" || url === "/index.html") {
    serveFile(res, path.join(PUBLIC_DIR, "index.html"));
    return;
  }

  sendJson(res, 404, { error: "Not found" });
});

const CACHE_REFRESH_MS =
  (Number.parseFloat(process.env.CACHE_REFRESH_HOURS) || 4) * 60 * 60 * 1000;
const STREAM_REFRESH_MS =
  (Number.parseFloat(process.env.STREAM_REFRESH_HOURS) || 4) * 60 * 60 * 1000;

function normalizeStreamMovie(movie) {
  const referer = movie.referer || movie.streams?.[0]?.referer || REFERER_DEFAULT;
  const streams = (movie.streams || []).map((stream) => {
    const qualities = Array.isArray(stream.qualities) ? stream.qualities.filter((q) => q?.url) : [];
    const normalizedQualities =
      qualities.length > 0
        ? qualities.map((q) => ({
            label: q.label || q.resolution || "Auto",
            resolution: q.resolution || null,
            width: q.width || null,
            height: q.height || null,
            bandwidth: q.bandwidth || null,
            frameRate: q.frameRate || q.frame_rate || null,
            codecs: q.codecs || null,
            url: q.url,
          }))
        : [
            {
              label: stream.bestQuality || stream.best_quality || "Auto",
              resolution: null,
              width: null,
              height: null,
              bandwidth: null,
              frameRate: null,
              codecs: null,
              url: stream.url,
            },
          ];
    return {
      url: stream.url,
      type: stream.type || "hls",
      referer: stream.referer || referer,
      bestQuality: stream.bestQuality || stream.best_quality || normalizedQualities[0]?.label || null,
      qualities: normalizedQualities,
    };
  });

  return {
    tmdbId: movie.tmdbId != null ? String(movie.tmdbId) : null,
    title: movie.title || "Untitled",
    overview: movie.overview || null,
    year: movie.year || null,
    rating: movie.rating != null ? Number(movie.rating) : null,
    poster: movie.poster || null,
    backdrop: movie.backdrop || null,
    referer,
    playerHost: movie.playerHost || movie.player_host || null,
    streams,
  };
}

// Background subtitle prefetch (see fileDownloads.js's prefetchAllSubtitles
// for why): each new download already triggers this for just its own file,
// but a startup + periodic sweep also catches movies downloaded before this
// feature existed, or where a prior conversion attempt failed.
const SUBTITLE_PREFETCH_MS = 6 * 60 * 60 * 1000;

function runSubtitlePrefetchSweep() {
  prefetchAllSubtitles().catch((err) => {
    console.warn("[subtitles] prefetch sweep failed:", err.message);
  });
}

async function startServer() {
  try {
    await initMovieCache({
      redisUrl: process.env.REDIS_URL,
      refreshMs: CACHE_REFRESH_MS,
      scrapeMoviesRange,
      getConfig: () => ({
        mainUrl,
        maxPages,
        cinebyUrl,
        initialPages,
        tmdbEnabled: Boolean(TMDB_API_KEY),
      }),
    });
  } catch (err) {
    console.warn("Redis init failed, continuing without cache:", err.message);
  }

  let probeCacheEnabled = false;
  try {
    probeCacheEnabled = await initProbeCache(process.env.REDIS_URL);
  } catch (err) {
    console.warn("Probe cache Redis init failed, continuing without it:", err.message);
  }

  let tmdbCacheEnabled = false;
  try {
    tmdbCacheEnabled = await initTmdbCache(process.env.REDIS_URL);
  } catch (err) {
    console.warn("TMDB cache Redis init failed, continuing without it:", err.message);
  }

  let streamCatalogEnabled = false;
  try {
    streamCatalogEnabled = await initStreamCatalog({
      redisUrl: process.env.REDIS_URL,
      refreshMs: STREAM_REFRESH_MS,
      // Don't block listen on a long scrape; kick after listen below.
      refreshOnStartup: false,
    });
  } catch (err) {
    console.warn("Stream catalog Redis init failed, continuing without it:", err.message);
  }

  server.listen(PORT, () => {
    console.log(`Movie server listening on http://localhost:${PORT}`);
    console.log(`Dashboard: http://localhost:${PORT}/`);
    console.log(`API:       http://localhost:${PORT}/api/movies`);
    console.log(`Scraping:  ${mainUrl}`);
    console.log(`Pages:     1-${maxPages}`);
    console.log(`TMDB:      ${TMDB_API_KEY ? "enabled" : "disabled (set TMDB_API_KEY in .env)"}`);
    console.log(`Downloads: ${getDownloadDir()}`);
    console.log(`HD tags:   ${HD_KEYWORDS.join(", ")}`);
    console.log(`4K tags:   ${K4_KEYWORDS.join(", ")}`);
    console.log(`Emby:      ${isEmbyConfigured() ? "enabled" : "disabled (set EMBY_URL + EMBY_API_KEY)"}`);
    console.log(`Probe cache: ${probeCacheEnabled ? "enabled" : "disabled (no REDIS_URL)"}`);
    console.log(`TMDB cache:  ${tmdbCacheEnabled ? "enabled" : "disabled (no REDIS_URL)"}`);
    console.log(
      `Streams:     ${streamCatalogEnabled ? `enabled (refresh every ${Math.round(STREAM_REFRESH_MS / 3600000)}h)` : "disabled (no REDIS_URL)"}`
    );

    if (streamCatalogEnabled) {
      refreshCatalog("startup").catch((err) => {
        console.warn("[streams] startup refresh failed:", err.message);
      });
    }
  });

  runSubtitlePrefetchSweep();
  setInterval(runSubtitlePrefetchSweep, SUBTITLE_PREFETCH_MS);
}

startServer();
