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
const { parseKeywordList, tagQuality } = require("./quality");
const {
  startDownload,
  getJob,
  listJobs,
  initDownloadDir,
  getDownloadDir,
  scanLibrary,
  findMediaFile,
  findMediaFiles,
  resolveMediaToken,
  probeMediaFile,
  streamFile,
  streamAudioTrackRemux,
  saveProgress,
  getProgress,
  listProgress,
} = require("./fileDownloads");
const { isEmbyConfigured, refreshLibrary, refreshAfterDownload } = require("./emby");
const { resolveRedirectUrl } = require("./urlUtils");
const { initMovieCache, getMovies, getCacheStatus } = require("./movieCache");
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

function isHomeAssistantAddon() {
  return process.env.HOME_ASSISTANT_ADDON === "true";
}

function getConfigPayload(extra = {}) {
  return {
    mainUrl,
    maxPages,
    initialPages,
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

function scrapePage(pageUrl) {
  return fetch(pageUrl)
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`Failed to fetch ${pageUrl}: ${response.status}`);
      }

      const html = await response.text();
      const { document } = parseHTML(html);

      const results = [...document.querySelectorAll(".row-thumb-link")].map((a) => ({
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
  const html = await fetchPageHtml(pageUrl);
  const { document } = parseHTML(html);
  const selectors = DOWNLOAD_SELECTORS.quality;
  const anchors = collectAnchors(document, selectors);

  return {
    options: sortDownloadOptions(anchors.map((anchor) => ({
      label: (anchor.querySelector(".dll")?.textContent || anchor.textContent || "Download").trim(),
      href: new URL(anchor.getAttribute("href"), pageUrl).href,
    }))),
    selectors: selectorDiagnostics(document, selectors),
  };
}

async function fetchDirectDownloadOptions(pageUrl) {
  const html = await fetchPageHtml(pageUrl);
  const { document } = parseHTML(html);
  const selectors = DOWNLOAD_SELECTORS.direct;
  const anchors = selectors.flatMap((selector) => [...document.querySelectorAll(selector)]);

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
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
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

  if (url === "/api/downloads/play" && req.method === "GET") {
    try {
      const searchParams = new URL(req.url, "http://localhost").searchParams;
      const tmdbId = searchParams.get("tmdbId") || null;
      const title = searchParams.get("title") || null;
      const fileToken = searchParams.get("file") || null;
      const audioTrackParam = searchParams.get("audioTrack");
      const audioTrack = audioTrackParam !== null ? Number.parseInt(audioTrackParam, 10) : 0;

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

      // Track 0 is always the file's own default audio — direct-play it so
      // Range requests keep working for proper seeking. Any other track
      // requires remuxing since a raw byte stream can't switch which
      // embedded audio track plays.
      if (audioTrack > 0) {
        streamAudioTrackRemux(req, res, filePath, audioTrack);
      } else {
        streamFile(req, res, filePath);
      }
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
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
            audioTracks: probe?.audioTracks ?? [],
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

      if ((!tmdbId && !title) || !Number.isFinite(positionSeconds) || !Number.isFinite(durationSeconds)) {
        sendJson(res, 400, { error: "tmdbId/title and numeric positionSeconds/durationSeconds are required" });
        return;
      }

      saveProgress({ tmdbId, title, fileToken, positionSeconds, durationSeconds });
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
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

async function startServer() {
  try {
    await initMovieCache({
      redisUrl: process.env.REDIS_URL,
      refreshMs: CACHE_REFRESH_MS,
      scrapeMoviesRange,
      getConfig: () => ({
        mainUrl,
        maxPages,
        initialPages,
        tmdbEnabled: Boolean(TMDB_API_KEY),
      }),
    });
  } catch (err) {
    console.warn("Redis init failed, continuing without cache:", err.message);
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
  });
}

startServer();
