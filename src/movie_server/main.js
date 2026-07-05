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
const { startDownload, getJob, listJobs, initDownloadDir, getDownloadDir, scanLibrary } = require("./fileDownloads");
const { isEmbyConfigured, refreshLibrary, refreshAfterDownload } = require("./emby");
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
  return fetch(pageUrl).then(async (response) => {
    if (!response.ok) {
      throw new Error(`Failed to fetch ${pageUrl}: ${response.status}`);
    }

    const html = await response.text();
    const { document } = parseHTML(html);

    return [...document.querySelectorAll(".row-thumb-link")].map((a) => ({
      title: a.querySelector("img")?.alt ?? "",
      link: new URL(a.getAttribute("href"), pageUrl).href,
    }));
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

async function fetchPageHtml(pageUrl) {
  const response = await fetch(pageUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch download page: ${response.status}`);
  }
  return response.text();
}

async function fetchDownloadOptions(pageUrl) {
  const html = await fetchPageHtml(pageUrl);
  const { document } = parseHTML(html);

  return sortDownloadOptions(
    [...document.querySelectorAll(".dlink.dl a")].map((anchor) => ({
      label: (anchor.querySelector(".dll")?.textContent || anchor.textContent || "Download").trim(),
      href: new URL(anchor.getAttribute("href"), pageUrl).href,
    }))
  );
}

async function fetchDirectDownloadOptions(pageUrl) {
  const html = await fetchPageHtml(pageUrl);
  const { document } = parseHTML(html);

  return sortDownloadOptions(
    [...document.querySelectorAll('a[class*="button"]')].map((anchor) => ({
      label: (anchor.textContent || "Download").trim(),
      href: new URL(anchor.getAttribute("href"), pageUrl).href,
    }))
  );
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

  if (url === "/api/config" && req.method === "GET") {
    sendJson(res, 200, { mainUrl, maxPages, initialPages, embyConfigured: isEmbyConfigured() });
    return;
  }

  if (url === "/api/config" && req.method === "PUT") {
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

      sendJson(res, 200, { mainUrl, maxPages, initialPages, message: "Config updated" });
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
      const movies = await scrapeMoviesRange(from, to);
      sendJson(res, 200, {
        source: mainUrl,
        maxPages,
        initialPages,
        from,
        to,
        count: movies.length,
        tmdbEnabled: Boolean(TMDB_API_KEY),
        movies,
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

  if (url === "/api/downloads" && req.method === "GET") {
    try {
      const pageUrl = new URL(req.url, "http://localhost").searchParams.get("url");
      if (!pageUrl) {
        sendJson(res, 400, { error: "url query parameter is required" });
        return;
      }

      new URL(pageUrl);
      const type = new URL(req.url, "http://localhost").searchParams.get("type") || "quality";
      const options =
        type === "direct"
          ? await fetchDirectDownloadOptions(pageUrl)
          : await fetchDownloadOptions(pageUrl);
      sendJson(res, 200, { url: pageUrl, type, count: options.length, options });
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
