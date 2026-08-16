const fs = require("fs");
const path = require("path");

const ENV_CANDIDATES = [
  path.join(__dirname, ".env"),
  path.join(__dirname, "..", "..", ".env"),
];
const ENV_PATH = ENV_CANDIDATES.find((candidate) => fs.existsSync(candidate)) || ENV_CANDIDATES[0];

require("dotenv").config({ path: ENV_PATH, override: true });

// HA's bashio::config prints the literal text "null" for unset optional
// options, which the add-on's run script writes straight into .env - guard
// against that string reaching fetch()/redis clients as if it were a real value.
function cleanEnvValue(raw) {
  const value = String(raw || "").trim();
  return value && value.toLowerCase() !== "null" ? value : "";
}
process.env.REDIS_URL = cleanEnvValue(process.env.REDIS_URL);

const http = require("http");
const { parseHTML } = require("linkedom");
const { enrichMovies, getTmdbById, suggestTitles, getSeasonEpisodes } = require("./tmdb");
const { initTmdbCache } = require("./tmdbCache");
const { parseKeywordList, tagQuality } = require("./quality");
const { streamYoutubeTrailer } = require("./trailer");
const {
  startDownload,
  hasEpisodeFile,
  startSeasonJob,
  cancelJob,
  waitForJob,
  getJob,
  listJobs,
  initJobHistory,
  initDownloadDir,
  getDownloadDir,
  scanLibrary,
  findMediaFile,
  findMediaFiles,
  findEpisodeFile,
  findDownloadedEpisodeNumbers,
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
  getSeriesResumePoint,
  listProgress,
} = require("./fileDownloads");
const { isEmbyConfigured, refreshLibrary, refreshAfterDownload, notifyAfterDelete } = require("./emby");
const { resolveRedirectUrl, BROWSER_HEADERS } = require("./urlUtils");
const { initMovieCache, getMovies, getCacheStatus } = require("./movieCache");
const { initProbeCache } = require("./mediaProbeCache");
const { initDownloadOptionsCache, resolveDirectOptionsCached, prefetchDirectOptionsInBackground } = require("./downloadOptionsCache");
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
let secondaryUrl = cleanEnvValue(process.env.SECONDARY_URL);

function isHomeAssistantAddon() {
  return process.env.HOME_ASSISTANT_ADDON === "true";
}

function getConfigPayload(extra = {}) {
  return {
    mainUrl,
    secondaryUrl,
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
    setEnvVar("SECONDARY_URL", secondaryUrl);
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

function setSecondaryUrl(newUrl) {
  secondaryUrl = String(newUrl || "").trim();
  process.env.SECONDARY_URL = secondaryUrl;
  persistConfig();
}

function setMaxPages(pages) {
  maxPages = parseMaxPages(pages);  
  process.env.MAX_PAGES = String(maxPages);
  persistConfig();
}

function buildPageUrl(baseUrl, page, { secondary = false } = {}) {
  if (secondary) {
    // 4khdhub paginates as /page/1/, /page/2/, … — ?page=N is ignored and
    // always returns the homepage listing.
    const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    return new URL(`page/${page}/`, base).href;
  }

  const url = new URL(baseUrl);
  if (page > 1) {
    url.searchParams.set("page", String(page));
  } else {
    url.searchParams.delete("page");
  }
  return url.href;
}

function buildSearchUrl(baseUrl, query, { secondary = false } = {}) {
  if (secondary) {
    const url = new URL(baseUrl);
    url.searchParams.set("s", query);
    return url.href;
  }
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = new URL("search.html", base);
  url.searchParams.set("search", query);
  return url.href;
}

function parseSecondaryMeta(text) {
  const cleaned = String(text || "")
    .replace(/[\u0000-\u001f]/g, " ")
    .replace(/[•·|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const yearMatch = cleaned.match(/\b((?:19|20)\d{2})\b/);
  const year = yearMatch ? Number.parseInt(yearMatch[1], 10) : null;
  const seasonMatch = cleaned.match(/\b(S\d{1,2}(?:\s*-\s*S\d{1,2})?(?:\s*EP\d{1,2})?)\b/i);
  const seasons = seasonMatch ? seasonMatch[1].replace(/\s+/g, " ").trim() : null;
  return { year, seasons, meta: cleaned };
}

// Node's bare fetch() identifies itself as `User-Agent: node` with
// `Accept: */*`, which Cloudflare (fronting the source sites) scores as a bot
// and answers with 403 - while resolveRedirectUrl() against the same origin
// succeeds because urlUtils sends a real browser identity. Every outbound
// scrape goes through here so the two code paths look alike on the wire.
async function scrapeFetch(targetUrl, { referer, label = "scrape" } = {}) {
  let refererValue = referer;
  if (!refererValue) {
    try {
      refererValue = `${new URL(targetUrl).origin}/`;
    } catch {
      refererValue = null;
    }
  }

  const response = await fetch(targetUrl, {
    redirect: "follow",
    headers: {
      ...BROWSER_HEADERS,
      "Upgrade-Insecure-Requests": "1",
      ...(refererValue ? { Referer: refererValue } : {}),
    },
  });

  // Host hops are worth surfacing on their own: these sites rotate domains
  // (filmyfly.luxe -> .fail) and hand download links off across hosts
  // (new1.filesdl.in -> new6.filesdl.top), and the destination often has
  // different protection than the URL we were given.
  logHostHop(label, targetUrl, response);
  return response;
}

function logHostHop(label, requestedUrl, response) {
  const finalUrl = response.url;
  if (!finalUrl || finalUrl === requestedUrl) return;

  try {
    const from = new URL(requestedUrl).host;
    const to = new URL(finalUrl).host;
    if (from === to) return;
    console.log(`[${label}] redirected ${from} -> ${to} (${response.status}) ${finalUrl}`);
  } catch {
    // Unparseable URL - the status log below still carries the useful detail.
  }
}

// A Cloudflare JS/Turnstile interstitial answers with 403 + `cf-mitigated:
// challenge` and a "Just a moment..." body. No combination of request headers
// passes it - it needs a real browser, which this server no longer bundles -
// so name it explicitly in the failure message rather than letting it
// surface as an unexplained 403.
async function classifyFetchFailure(response) {
  const mitigated = response.headers.get("cf-mitigated");
  const ray = response.headers.get("cf-ray");
  let challenge = mitigated === "challenge";

  if (!challenge && response.headers.get("server") === "cloudflare") {
    try {
      const body = await response.text();
      challenge = /Just a moment|challenges\.cloudflare\.com|cf-turnstile/i.test(body);
    } catch {
      // Body unreadable - the header signals above still stand on their own.
    }
  }

  const parts = [];
  if (challenge) {
    parts.push("Cloudflare browser challenge - headers alone cannot pass it");
  } else if (mitigated) {
    parts.push(`Cloudflare mitigation: ${mitigated}`);
  }
  if (ray) parts.push(`cf-ray ${ray}`);
  return { challenge, detail: parts.join("; ") };
}

const FLARESOLVERR_URL = cleanEnvValue(process.env.FLARESOLVERR_URL).replace(/\/$/, "");
const FLARESOLVERR_TIMEOUT_MS = Number(process.env.FLARESOLVERR_TIMEOUT_MS || 60000);

// Optional, self-hosted, external to this container: https://github.com/FlareSolverr/FlareSolverr
// POST {FLARESOLVERR_URL} { cmd: "request.get", url, maxTimeout } -> { status: "ok"|"error", solution: { response: "<html>", url } }
// Unlike the removed cf-clearance sidecar, this never bundles a browser
// inside this image - it's just an HTTP client pointed at a FlareSolverr
// instance the user runs themselves (their own machine/container).
async function fetchPageViaFlareSolverr(targetUrl) {
  if (!FLARESOLVERR_URL) {
    throw new Error("FLARESOLVERR_URL is not configured");
  }

  console.log(`[downloads] flaresolverr: ${targetUrl} via ${FLARESOLVERR_URL}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FLARESOLVERR_TIMEOUT_MS + 5000);
  let response;
  try {
    response = await fetch(FLARESOLVERR_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ cmd: "request.get", url: targetUrl, maxTimeout: FLARESOLVERR_TIMEOUT_MS }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`flaresolverr timed out after ${FLARESOLVERR_TIMEOUT_MS}ms`);
    }
    throw new Error(`flaresolverr unreachable: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`flaresolverr returned non-JSON (HTTP ${response.status})`);
  }

  if (!response.ok || data?.status !== "ok" || !data?.solution?.response) {
    throw new Error(data?.message || `flaresolverr failed (HTTP ${response.status}, status ${data?.status})`);
  }

  const html = String(data.solution.response);
  if (/Just a moment|challenges\.cloudflare\.com|cf-turnstile/i.test(html)) {
    throw new Error("flaresolverr returned a Cloudflare challenge page");
  }

  return { html, url: data.solution.url || targetUrl };
}

function scrapeSecondaryPage(pageUrl) {
  return scrapeFetch(pageUrl)
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`Failed to fetch ${pageUrl}: ${response.status}`);
      }

      const html = await response.text();
      const { document } = parseHTML(html);
      const cards = [...document.querySelectorAll("a.movie-card")];

      const results = cards.map((card) => {
        const aria = String(card.getAttribute("aria-label") || "");
        const titleFromAria = aria.replace(/\s+details\s*$/i, "").trim();
        const title = titleFromAria || card.querySelector("img")?.alt || "";
        const href = card.getAttribute("href");
        const { year, seasons, meta } = parseSecondaryMeta(
          card.querySelector(".movie-card-meta")?.textContent
        );
        const formats = [...card.querySelectorAll(".movie-card-format")]
          .map((el) => String(el.textContent || "").trim())
          .filter(Boolean);

        return {
          title,
          link: href ? new URL(href, pageUrl).href : pageUrl,
          year,
          seasons,
          meta,
          formats,
          source: "secondary",
        };
      }).filter((movie) => movie.title && movie.link);

      recordScrapeSuccess();
      return results;
    })
    .catch((err) => {
      recordScrapeError(err);
      throw err;
    });
}

const SHEGU_DOWNLOADS_ORIGIN = String(
  process.env.SHEGU_DOWNLOADS_URL || "https://downloads.shegu.st"
)
  .replace(/\/$/, "")
  .replace(/\/(movie|tv)$/i, "");

function parseScrapedSeasonRange(seasonsText) {
  const text = String(seasonsText || "");
  const range = text.match(/S(\d{1,2})\s*-\s*S(\d{1,2})/i);
  if (range) {
    return {
      from: Number.parseInt(range[1], 10),
      to: Number.parseInt(range[2], 10),
    };
  }
  const single = text.match(/S(\d{1,2})/i);
  if (single) {
    const n = Number.parseInt(single[1], 10);
    return { from: n, to: n };
  }
  return null;
}

function parseSizeToGb(size) {
  const text = String(size || "").trim();
  const match = text.match(/^([\d.]+)\s*(tb|gb|mb|kb|b)?$/i);
  if (!match) return 0;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value)) return 0;
  const unit = (match[2] || "gb").toLowerCase();
  if (unit === "tb") return value * 1024;
  if (unit === "gb") return value;
  if (unit === "mb") return value / 1024;
  if (unit === "kb") return value / (1024 * 1024);
  return value / (1024 ** 3);
}

function rankSheguOptionsByQuality(options) {
  return [...(options || [])]
    .filter((opt) => opt?.href)
    .sort((a, b) => {
      const qA = Number(a.quality) || 0;
      const qB = Number(b.quality) || 0;
      if (qA !== qB) return qB - qA;
      return parseSizeToGb(b.size) - parseSizeToGb(a.size);
    });
}

function padSeasonEpisode(n) {
  return String(n).padStart(2, "0");
}

async function fetchSheguDownloadOptions({
  tmdbId,
  mediaType = "movie",
  season = null,
  episode = null,
} = {}) {
  const id = String(tmdbId || "").trim();
  if (!id) {
    throw new Error("tmdbId is required");
  }

  const type = String(mediaType || "movie").toLowerCase() === "tv" ? "tv" : "movie";
  let apiUrl;
  let selector;

  if (type === "tv") {
    const s = Number.parseInt(season, 10);
    const e = Number.parseInt(episode, 10);
    if (!Number.isFinite(s) || s < 1 || !Number.isFinite(e) || e < 1) {
      throw new Error("season and episode are required for TV downloads");
    }
    apiUrl = `${SHEGU_DOWNLOADS_ORIGIN}/tv/${encodeURIComponent(id)}/${s}/${e}`;
    selector = "downloads.shegu.st/tv/{tmdbId}/{season}/{episode}";
  } else {
    apiUrl = `${SHEGU_DOWNLOADS_ORIGIN}/movie/${encodeURIComponent(id)}`;
    selector = "downloads.shegu.st/movie/{tmdbId}";
  }

  const response = await fetch(apiUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch secondary downloads: ${response.status}`);
  }

  const data = await response.json();
  const links = Array.isArray(data?.links) ? data.links : [];
  const options = links
    .filter((link) => link?.url)
    .map((link) => ({
      label: link.name || `${link.source || "Download"}${link.size ? ` [${link.size}]` : ""}`,
      href: link.url,
      quality: link.quality || null,
      size: link.size || null,
      source: link.source || null,
      provider: link.provider || "4khdhub",
      direct: true,
    }));

  return {
    options: sortDownloadOptions(options),
    selectors: [{ selector, matches: options.length }],
    requestUrl: apiUrl,
  };
}

async function downloadSheguEpisodeWithFallback({
  tmdbId,
  season,
  episode,
  movieTitle,
  parentId = null,
  seasonJob = null,
}) {
  if (seasonJob?._cancelled) {
    return { id: null, status: "skipped", error: "Cancelled", season, episode };
  }

  if (hasEpisodeFile(movieTitle, tmdbId, season, episode)) {
    return {
      id: null,
      status: "skipped",
      error: "Already downloaded",
      season,
      episode,
    };
  }

  const result = await fetchSheguDownloadOptions({
    tmdbId,
    mediaType: "tv",
    season,
    episode,
  });
  const ranked = rankSheguOptionsByQuality(result.options);
  if (!ranked.length) {
    return {
      id: null,
      status: "skipped",
      error: "No download links found",
      season,
      episode,
    };
  }

  const job = startDownload({
    url: ranked[0].href,
    label: ranked[0].label,
    movieTitle,
    tmdbId,
    season,
    episode,
    parentId,
    candidates: ranked.map((opt) => ({ url: opt.href, label: opt.label })),
  });
  // Registered before awaiting completion (not just after) so cancelling the
  // season job can reach this episode's own job while it's still in flight.
  seasonJob?.activeEpisodeJobIds?.add(job.id);
  try {
    await waitForJob(job);
  } finally {
    seasonJob?.activeEpisodeJobIds?.delete(job.id);
  }
  return job;
}

// Shared by the initial /api/downloads/season request and the redownload
// route (re-running a past season job by tmdbId/season/episodeCount).
function runSeasonDownload({ tmdbId, season, episodeCount, movieTitle }) {
  return startSeasonJob({
    tmdbId,
    season,
    episodeCount,
    movieTitle,
    downloadEpisode: async ({ seasonJob, season: s, episode: e }) =>
      downloadSheguEpisodeWithFallback({
        tmdbId,
        season: s,
        episode: e,
        movieTitle,
        parentId: seasonJob.id,
        seasonJob,
      }),
  });
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

function scrapePage(pageUrl, { search = false } = {}) {
  return scrapeFetch(pageUrl)
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`Failed to fetch ${pageUrl}: ${response.status}`);
      }

      const html = await response.text();
      const { document } = parseHTML(html);
      const latestMarker = findLatestMoviesMarker(document);
      const order = latestMarker ? documentOrderIndex(document) : null;
      const markerIndex = order?.get(latestMarker);

      // Listing pages: keep cards after "Latest Movies" (skip trending ads).
      // Search pages: keep cards before "Latest Movies" (search hits come
      // first; the homepage grid is appended below on the same page).
      let anchors = [...document.querySelectorAll(".row-thumb-link")];
      if (markerIndex !== undefined) {
        anchors = search
          ? anchors.filter((a) => order.get(a) < markerIndex)
          : anchors.filter((a) => order.get(a) > markerIndex);
      }

      const results = anchors.map((a) => ({
        title: a.querySelector("img")?.alt ?? "",
        link: new URL(a.getAttribute("href"), response.url || pageUrl).href,
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

async function fetchPageHtml(pageUrl, { referer } = {}) {
  // Same resolver as GET /api/redirect — download hosts (e.g. new1.filesdl.in)
  // 302 across domains before the real page is available. Fetching the
  // original URL as Node often gets 403 on the hop; resolving first lands us
  // on the final host (new6.filesdl.top) the way a browser click would.
  let targetUrl = pageUrl;
  try {
    const resolved = await resolveRedirectUrl(pageUrl);
    if (resolved && resolved !== pageUrl) {
      console.log(`[downloads] resolved redirect: ${pageUrl} -> ${resolved}`);
      targetUrl = resolved;
    }
  } catch (err) {
    console.warn(`[downloads] resolveRedirectUrl failed, using original: ${err.message}`);
  }

  console.log(`[downloads] fetching page: ${targetUrl}`);
  const response = await scrapeFetch(targetUrl, { referer, label: "downloads" });

  if (!response.ok) {
    const { challenge, detail } = await classifyFetchFailure(response);
    console.warn(
      `[downloads] page fetch failed: ${response.status} ${response.url || targetUrl}` +
        (detail ? ` - ${detail}` : "")
    );

    if (challenge && FLARESOLVERR_URL) {
      const browserUrl = response.url || targetUrl;
      try {
        const { html, url: finalUrl } = await fetchPageViaFlareSolverr(browserUrl);
        console.log(`[downloads] flaresolverr ok: ${finalUrl} (${html.length} bytes)`);
        return { html, url: finalUrl };
      } catch (err) {
        console.warn(`[downloads] flaresolverr failed: ${err.message}`);
        throw new Error(
          `Failed to fetch download page: ${response.status} - ${detail} - flaresolverr also failed: ${err.message}`
        );
      }
    }

    throw new Error(
      `Failed to fetch download page: ${response.status}` + (detail ? ` - ${detail}` : "")
    );
  }

  const html = await response.text();
  const finalUrl = response.url || targetUrl;
  console.log(`[downloads] page ok: ${response.status} ${finalUrl} (${html.length} bytes)`);
  return { html, url: finalUrl };
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
  const { html, url } = await fetchPageHtml(pageUrl);
  return { document: parseHTML(html).document, url };
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

async function fetchDownloadOptions(pageUrl, source = null) {
  let { document, url: resolvedUrl } = await fetchDownloadPageDocument(pageUrl);
  const selectors = DOWNLOAD_SELECTORS.quality;
  let anchors = collectAnchors(document, selectors);

  if (!anchors.length) {
    try {
      const retryUrl = await resolveRetryPageUrl(pageUrl);
      if (retryUrl !== pageUrl && retryUrl !== resolvedUrl) {
        ({ document, url: resolvedUrl } = await fetchDownloadPageDocument(retryUrl));
        anchors = collectAnchors(document, selectors);
      }
    } catch (err) {
      console.warn("[downloads] retry via resolved main URL failed:", err.message);
    }
  }

  const baseUrl = resolvedUrl || pageUrl;
  const options = sortDownloadOptions(anchors.map((anchor) => ({
    label: (anchor.querySelector(".dll")?.textContent || anchor.textContent || "Download").trim(),
    href: new URL(anchor.getAttribute("href"), baseUrl).href,
  })));

  // Each option.href is itself a page (e.g. linkmake.in) that has to be
  // resolved one level deeper to find the actual file-host buttons - and
  // that inner resolution is the one likely to hit a Cloudflare Turnstile
  // challenge (new1.filesdl.in -> new6.filesdl.top). Warm the cache for all
  // of them now, in the background, so that by the time the user actually
  // clicks a quality the "direct" list is already resolved instead of
  // paying the Cloudflare cost inside that click's own request.
  prefetchDirectOptionsInBackground(options.map((o) => o.href), source, fetchDirectDownloadOptionsLive);

  return {
    options,
    selectors: selectorDiagnostics(document, selectors),
  };
}

async function fetchDirectDownloadOptionsLive(pageUrl) {
  let { document, url: resolvedUrl } = await fetchDownloadPageDocument(pageUrl);
  const selectors = DOWNLOAD_SELECTORS.direct;
  let anchors = selectors.flatMap((selector) => [...document.querySelectorAll(selector)]);

  if (!anchors.length) {
    try {
      const retryUrl = await resolveRetryPageUrl(pageUrl);
      if (retryUrl !== pageUrl && retryUrl !== resolvedUrl) {
        ({ document, url: resolvedUrl } = await fetchDownloadPageDocument(retryUrl));
        anchors = selectors.flatMap((selector) => [...document.querySelectorAll(selector)]);
      }
    } catch (err) {
      console.warn("[downloads] retry via resolved main URL failed:", err.message);
    }
  }

  const baseUrl = resolvedUrl || pageUrl;
  return {
    options: sortDownloadOptions(anchors.map((anchor) => ({
      label: (anchor.textContent || "Download").trim(),
      href: new URL(anchor.getAttribute("href"), baseUrl).href,
    }))),
    selectors: selectorDiagnostics(document, selectors),
  };
}

// Cache-checked wrapper around fetchDirectDownloadOptionsLive - see
// downloadOptionsCache.js. Both the real /api/downloads?type=direct request
// and the background prefetch above go through this, so a click that lands
// after the prefetch already finished gets the cached result instantly, and
// one that lands while it's still running joins the same in-flight
// resolution instead of starting a second one.
async function fetchDirectDownloadOptions(pageUrl, source = null) {
  return resolveDirectOptionsCached(pageUrl, source, () => fetchDirectDownloadOptionsLive(pageUrl));
}

async function resolveDownloadLink(detailUrl) {
  try {
    const response = await scrapeFetch(detailUrl, { label: "resolve" });
    if (!response.ok) {
      const { detail } = await classifyFetchFailure(response);
      console.warn(
        `[resolve] ${response.status} for ${response.url || detailUrl}` +
          (detail ? ` - ${detail}` : "") +
          " - falling back to the unresolved link"
      );
      return detailUrl;
    }

    const html = await response.text();
    const { document } = parseHTML(html);
    const anchor = document.querySelector(".dlbtn a");
    const href = anchor?.getAttribute("href");
    if (!href) return detailUrl;

    return new URL(href, response.url || detailUrl).href;
  } catch {
    return detailUrl;
  }
}

async function resolveDownloadLinks(movies, concurrency = 5) {
  const resolved = [...movies];

  for (let i = 0; i < resolved.length; i += concurrency) {
    const batch = resolved.slice(i, i + concurrency);
    const links = await Promise.all(
      batch.map((movie) =>
        movie.source === "secondary" ? Promise.resolve(movie.link) : resolveDownloadLink(movie.link)
      )
    );
    links.forEach((link, j) => {
      resolved[i + j] = { ...resolved[i + j], link };
    });
  }

  return resolved;
}

function tagSecondaryMovie(movie) {
  const formatText = [...(movie.formats || []), movie.meta, movie.title].filter(Boolean).join(" ");
  const tagged = tagQuality({ ...movie, title: formatText }, HD_KEYWORDS, K4_KEYWORDS);
  return {
    ...movie,
    source: "secondary",
    quality: {
      hd: true,
      k4: Boolean(tagged.quality?.k4),
    },
  };
}

function finalizeQuality(movie) {
  if (movie.source === "secondary") {
    return tagSecondaryMovie(movie);
  }
  return tagQuality(movie, HD_KEYWORDS, K4_KEYWORDS);
}

function movieTitleKey(movie) {
  return String(movie?.title || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// Scrapes one listing site over a page range. When secondary is set, uses the
// 4khdhub movie-card scraper (and treats every card as HD). When hdOnly is set
// on the primary-style scraper, titles that don't match HD_KEYWORDS are dropped.
async function scrapeSourceRange(baseUrl, fromPage, toPage, { hdOnly = false, secondary = false } = {}) {
  const start = Math.max(1, Math.min(fromPage, toPage));
  const end = Math.min(maxPages, Math.max(fromPage, toPage));
  const seen = new Set();
  const movies = [];

  for (let page = start; page <= end; page++) {
    const pageUrl = buildPageUrl(baseUrl, page, { secondary });
    const pageMovies = secondary
      ? await scrapeSecondaryPage(pageUrl)
      : await scrapePage(pageUrl);

    for (const movie of pageMovies) {
      const tagged = secondary
        ? tagSecondaryMovie(movie)
        : tagQuality(movie, HD_KEYWORDS, K4_KEYWORDS);
      if (hdOnly && !tagged.quality?.hd) continue;
      if (!seen.has(tagged.link)) {
        seen.add(tagged.link);
        movies.push(tagged);
      }
    }
  }

  return movies;
}

function mergeSecondaryHd(primary, secondary) {
  const seenLinks = new Set(primary.map((m) => m.link));
  const hdTitles = new Set(
    primary.filter((m) => m.quality?.hd).map(movieTitleKey).filter(Boolean)
  );
  const merged = [...primary];

  for (const movie of secondary) {
    if (seenLinks.has(movie.link)) continue;
    const key = movieTitleKey(movie);
    if (key && hdTitles.has(key)) continue;
    seenLinks.add(movie.link);
    if (key) hdTitles.add(key);
    merged.push(movie);
  }

  return merged;
}

async function scrapeMoviesRange(fromPage, toPage) {
  const primary = await scrapeSourceRange(mainUrl, fromPage, toPage);
  let movies = primary;

  if (secondaryUrl) {
    try {
      const secondaryHd = await scrapeSourceRange(secondaryUrl, fromPage, toPage, {
        secondary: true,
      });
      movies = mergeSecondaryHd(primary, secondaryHd);
      console.log(
        `[scrape] secondary HD source: kept ${secondaryHd.length} title(s) from ${secondaryUrl} (merged total ${movies.length})`
      );
    } catch (err) {
      console.warn(`[scrape] secondary HD source failed (${secondaryUrl}): ${err.message}`);
    }
  }

  const withDownloadLinks = await resolveDownloadLinks(movies);

  let result = withDownloadLinks;
  if (TMDB_API_KEY) {
    result = await enrichMovies(withDownloadLinks, TMDB_API_KEY);
  }

  return result.map((movie) => finalizeQuality(movie));
}

async function searchSourceMovies(query) {
  const q = String(query || "").trim();
  if (!q) return [];

  // MAIN_URL may be a rotated domain (e.g. .faith) that redirects search
  // pages to the homepage. Resolve the live origin first so search.html
  // stays on the current domain.
  let primaryBase = mainUrl;
  try {
    primaryBase = await resolveRedirectUrl(mainUrl);
  } catch (err) {
    console.warn(`[search] resolve main URL failed: ${err.message}`);
  }

  async function searchOne(baseUrl, { secondary = false } = {}) {
    const searchUrl = buildSearchUrl(baseUrl, q, { secondary });
    console.log(`[search] ${secondary ? "secondary" : "primary"}: ${searchUrl}`);
    const pageMovies = secondary
      ? await scrapeSecondaryPage(searchUrl)
      : await scrapePage(searchUrl, { search: true });
    const seen = new Set();
    const movies = [];
    for (const movie of pageMovies) {
      const tagged = secondary
        ? tagSecondaryMovie(movie)
        : tagQuality(movie, HD_KEYWORDS, K4_KEYWORDS);
      if (!seen.has(tagged.link)) {
        seen.add(tagged.link);
        movies.push(tagged);
      }
    }
    return { movies, searchUrl };
  }

  const tasks = [searchOne(primaryBase, { secondary: false })];
  if (secondaryUrl) {
    tasks.push(searchOne(secondaryUrl, { secondary: true }));
  }

  const settled = await Promise.allSettled(tasks);
  const primaryResult = settled[0];
  const secondaryResult = settled[1];

  let primary = [];
  let primarySearchUrl = buildSearchUrl(primaryBase, q);
  if (primaryResult.status === "fulfilled") {
    primary = primaryResult.value.movies;
    primarySearchUrl = primaryResult.value.searchUrl;
  } else {
    console.warn(`[search] primary source failed: ${primaryResult.reason?.message || primaryResult.reason}`);
  }

  let secondary = [];
  let secondarySearchUrl = secondaryUrl ? buildSearchUrl(secondaryUrl, q, { secondary: true }) : null;
  if (secondaryResult) {
    if (secondaryResult.status === "fulfilled") {
      secondary = secondaryResult.value.movies;
      secondarySearchUrl = secondaryResult.value.searchUrl;
    } else {
      console.warn(
        `[search] secondary source failed (${secondaryUrl}): ${secondaryResult.reason?.message || secondaryResult.reason}`
      );
    }
  }

  const movies = secondary.length ? mergeSecondaryHd(primary, secondary) : primary;
  console.log(
    `[search] "${q}": primary ${primary.length}, secondary ${secondary.length}, merged ${movies.length}`
  );

  const withDownloadLinks = await resolveDownloadLinks(movies);
  let result = withDownloadLinks;
  if (TMDB_API_KEY) {
    result = await enrichMovies(withDownloadLinks, TMDB_API_KEY);
  }

  const finalized = result.map((movie) => finalizeQuality(movie));
  return {
    movies: finalized,
    primarySearchUrl,
    secondarySearchUrl,
    primaryCount: primary.length,
    secondaryCount: secondary.length,
  };
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
    ".json": "application/json",
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

      if (body.secondaryUrl !== undefined) {
        const nextSecondary = String(body.secondaryUrl).trim();
        if (nextSecondary) new URL(nextSecondary);
        setSecondaryUrl(nextSecondary);
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

      const searchResult = await searchSourceMovies(query);
      sendJson(res, 200, {
        query: String(query).trim(),
        searchUrl: searchResult.primarySearchUrl || buildSearchUrl(mainUrl, String(query).trim()),
        secondarySearchUrl: searchResult.secondarySearchUrl || null,
        primaryCount: searchResult.primaryCount,
        secondaryCount: searchResult.secondaryCount,
        movies: searchResult.movies,
        count: searchResult.movies.length,
        tmdbEnabled: Boolean(TMDB_API_KEY),
        source: mainUrl,
        secondaryUrl: secondaryUrl || null,
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
      const candidates = Array.isArray(body.candidates) ? body.candidates : null;
      // Optional: a single-episode download (e.g. MediaNest's episode grid) -
      // when present, the file nests under Series (tmdb-id)/S0X/ and gets an
      // "SxxEyy - " filename tag, same as the season-batch downloader,
      // instead of movieTitle alone creating a separate flat folder per
      // episode (the pre-1.7.3 layout).
      const season = Number.isInteger(body.season) ? body.season : Number.parseInt(body.season, 10);
      const episode = Number.isInteger(body.episode) ? body.episode : Number.parseInt(body.episode, 10);

      if (!downloadUrl && !(candidates && candidates.length)) {
        sendJson(res, 400, { error: "url is required" });
        return;
      }

      if (downloadUrl) new URL(downloadUrl);
      const job = startDownload({
        url: downloadUrl,
        label,
        movieTitle,
        tmdbId,
        candidates,
        season: Number.isFinite(season) ? season : null,
        episode: Number.isFinite(episode) ? episode : null,
      });
      sendJson(res, 202, { message: "Download started", job: getJob(job.id) });
    } catch (err) {
      const message = err instanceof TypeError ? "Invalid URL" : err.message;
      sendJson(res, 400, { error: message });
    }
    return;
  }

  if (url === "/api/downloads/season" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req));
      const tmdbId = body.tmdbId ? String(body.tmdbId).trim() : "";
      const season = Number.parseInt(body.season, 10);
      const episodeCount = Number.parseInt(body.episodeCount, 10);
      const movieTitle = String(body.movieTitle || "Series").trim() || "Series";

      if (!tmdbId) {
        sendJson(res, 400, { error: "tmdbId is required" });
        return;
      }
      if (!Number.isFinite(season) || season < 1) {
        sendJson(res, 400, { error: "season must be >= 1" });
        return;
      }
      if (!Number.isFinite(episodeCount) || episodeCount < 1) {
        sendJson(res, 400, { error: "episodeCount must be >= 1" });
        return;
      }

      const job = runSeasonDownload({ tmdbId, season, episodeCount, movieTitle });

      sendJson(res, 202, {
        message: "Season download started",
        job: getJob(job.id),
      });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  if (url === "/api/downloads/jobs" && req.method === "GET") {
    sendJson(res, 200, { downloadDir: getDownloadDir(), jobs: listJobs() });
    return;
  }

  // Re-runs a past job (by id) with the same target - a completed download's
  // candidates/season/episode, or a season job's tmdbId/season/episodeCount.
  // Works even after a restart: job history survives in Redis (see
  // initJobHistory), so the id from a past session is still resolvable here.
  if (url === "/api/downloads/redownload" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req));
      const jobId = Number.parseInt(body.jobId, 10);
      if (!Number.isFinite(jobId)) {
        sendJson(res, 400, { error: "jobId is required" });
        return;
      }
      const source = getJob(jobId);
      if (!source) {
        sendJson(res, 404, { error: "Job not found" });
        return;
      }

      let job;
      if (source.type === "season") {
        if (!source.tmdbId || !source.season || !source.episodeCount) {
          sendJson(res, 400, { error: "Original season job is missing tmdbId/season/episodeCount" });
          return;
        }
        job = runSeasonDownload({
          tmdbId: source.tmdbId,
          season: source.season,
          episodeCount: source.episodeCount,
          movieTitle: source.movieTitle,
        });
      } else {
        if (!source.url && !(source.candidates && source.candidates.length)) {
          sendJson(res, 400, { error: "Original job has no URL/candidates to retry" });
          return;
        }

        // The stored candidates are shegu-issued signed URLs (season+episode
        // present is the reliable signal a job came from shegu, since only
        // TV downloads set those) that expire in a few hours - reusing them
        // as-is on a redownload triggered later just retries an already-dead
        // link every time. Re-resolving live here mirrors what the season
        // redownload path above already does on every run.
        let url = source.url;
        let label = source.label;
        let candidates = source.candidates;
        if (source.tmdbId && source.season && source.episode) {
          try {
            const fresh = await fetchSheguDownloadOptions({
              tmdbId: source.tmdbId,
              mediaType: "tv",
              season: source.season,
              episode: source.episode,
            });
            const ranked = rankSheguOptionsByQuality(fresh.options);
            if (ranked.length) {
              url = ranked[0].href;
              label = ranked[0].label;
              candidates = ranked.map((opt) => ({ url: opt.href, label: opt.label }));
            }
          } catch (err) {
            console.warn(`[download] redownload #${jobId}: failed to refresh shegu links, falling back to stored candidates: ${err.message}`);
          }
        }

        job = startDownload({
          url,
          label,
          movieTitle: source.movieTitle,
          tmdbId: source.tmdbId,
          season: source.season,
          episode: source.episode,
          candidates,
        });
      }

      sendJson(res, 202, { message: "Redownload started", job: getJob(job.id) });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  // Stops a queued/downloading job (regular or season) - aborts the
  // fetch/kills aria2c, or for a season job also stops it from picking up
  // any further episodes and cancels whichever episode is currently
  // in-flight. The job ends up "failed" with error "Cancelled", same as any
  // other failure, so it's still visible in history and redownloadable.
  if (url === "/api/downloads/cancel" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req));
      const jobId = Number.parseInt(body.jobId, 10);
      if (!Number.isFinite(jobId)) {
        sendJson(res, 400, { error: "jobId is required" });
        return;
      }
      const cancelled = cancelJob(jobId);
      if (!cancelled) {
        sendJson(res, 400, { error: "Job not found or not cancellable" });
        return;
      }
      sendJson(res, 200, { message: "Cancelled", job: getJob(jobId) });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
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

  // Live type-ahead suggestions for the search box - checked before the
  // by-id route below since both share the "/api/tmdb" prefix.
  if (url.startsWith("/api/tmdb/suggest") && req.method === "GET") {
    try {
      const searchParams = new URL(req.url, "http://localhost").searchParams;
      const q = searchParams.get("q") || "";
      if (!TMDB_API_KEY) {
        sendJson(res, 400, { error: "TMDB is not configured" });
        return;
      }
      const results = await suggestTitles(TMDB_API_KEY, q);
      sendJson(res, 200, { results });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // Per-episode name/overview/still for a TV season's detail view - checked
  // before the by-id route below since both share the "/api/tmdb" prefix.
  if (url.startsWith("/api/tmdb/season") && req.method === "GET") {
    try {
      const searchParams = new URL(req.url, "http://localhost").searchParams;
      const tmdbId = searchParams.get("id");
      const season = searchParams.get("season");
      if (!tmdbId || season == null) {
        sendJson(res, 400, { error: "id and season query parameters are required" });
        return;
      }
      if (!TMDB_API_KEY) {
        sendJson(res, 400, { error: "TMDB is not configured" });
        return;
      }
      const episodes = await getSeasonEpisodes(TMDB_API_KEY, tmdbId, season);
      sendJson(res, 200, { episodes });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // Direct-by-id TMDB lookup for a downloaded library item whose tmdbId
  // falls outside the currently cached listing pages - enrichMovies() only
  // ever runs against scraped listing pages, so a title downloaded a while
  // ago (and since rotated off those pages) never gets a poster any other
  // way.
  if (url.startsWith("/api/tmdb") && req.method === "GET") {
    try {
      const searchParams = new URL(req.url, "http://localhost").searchParams;
      const tmdbId = searchParams.get("id");
      const type = searchParams.get("type") === "tv" ? "tv" : undefined;
      if (!tmdbId) {
        sendJson(res, 400, { error: "id query parameter is required" });
        return;
      }
      if (!TMDB_API_KEY) {
        sendJson(res, 400, { error: "TMDB is not configured" });
        return;
      }
      const meta = await getTmdbById(TMDB_API_KEY, tmdbId, type);
      if (!meta) {
        sendJson(res, 404, { error: "Not found" });
        return;
      }
      sendJson(res, 200, meta);
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

  // Looks up a specific episode's file token (if downloaded) so the caller
  // can decide "play this episode" vs "open the download flow" - unlike
  // findMediaFile, which just returns the largest file this whole series
  // has anywhere and has no way to pick out one specific episode.
  if (url === "/api/downloads/episode-file" && req.method === "GET") {
    try {
      const searchParams = new URL(req.url, "http://localhost").searchParams;
      const tmdbId = searchParams.get("tmdbId") || null;
      const title = searchParams.get("title") || null;
      const season = searchParams.get("season");
      const episode = searchParams.get("episode");
      if ((!tmdbId && !title) || season == null || episode == null) {
        sendJson(res, 400, { error: "tmdbId or title, plus season and episode, are required" });
        return;
      }
      const file = findEpisodeFile({ tmdbId, title, season: Number(season), episode: Number(episode) });
      sendJson(res, 200, { token: file?.token || null });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // Which episodes of a season are already downloaded - one call per season
  // shown, for a "downloaded" badge on each episode card.
  if (url === "/api/downloads/season-status" && req.method === "GET") {
    try {
      const searchParams = new URL(req.url, "http://localhost").searchParams;
      const tmdbId = searchParams.get("tmdbId") || null;
      const title = searchParams.get("title") || null;
      const season = searchParams.get("season");
      if ((!tmdbId && !title) || season == null) {
        sendJson(res, 400, { error: "tmdbId or title, plus season, are required" });
        return;
      }
      const episodes = findDownloadedEpisodeNumbers({ tmdbId, title, season: Number(season) });
      sendJson(res, 200, { episodes });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // The series-wide "continue watching" point (which file, what position) -
  // used to decide whether a TV show's primary action should say "Play"
  // (start from S1E1) or "Continue Watching" (resume exactly where the user
  // left off), across however many seasons/episodes have been watched.
  if (url === "/api/downloads/series-resume" && req.method === "GET") {
    try {
      const searchParams = new URL(req.url, "http://localhost").searchParams;
      const tmdbId = searchParams.get("tmdbId") || null;
      const title = searchParams.get("title") || null;
      if (!tmdbId && !title) {
        sendJson(res, 400, { error: "tmdbId or title is required" });
        return;
      }
      const resume = getSeriesResumePoint({ tmdbId, title });
      sendJson(res, 200, resume || { fileToken: null });
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
      const searchParams = new URL(req.url, "http://localhost").searchParams;
      const source = String(searchParams.get("source") || "").trim().toLowerCase();
      const tmdbId = searchParams.get("tmdbId") || searchParams.get("tmdb_id");

      // Secondary (4khdhub) downloads are resolved via shegu.st using TMDB id —
      // movies: /movie/{id}, TV: /tv/{id}/{season}/{episode}. Links are direct.
      if (source === "secondary" || searchParams.get("type") === "shegu") {
        if (!tmdbId) {
          sendJson(res, 400, { error: "tmdbId query parameter is required for secondary downloads" });
          return;
        }
        const mediaType =
          String(searchParams.get("mediaType") || "").toLowerCase() === "tv" ? "tv" : "movie";
        const season = searchParams.get("season");
        const episode = searchParams.get("episode");
        const result = await fetchSheguDownloadOptions({
          tmdbId,
          mediaType,
          season,
          episode,
        });
        sendJson(res, 200, {
          tmdbId: String(tmdbId),
          type: "direct",
          source: "secondary",
          mediaType,
          season: mediaType === "tv" ? Number.parseInt(season, 10) : null,
          episode: mediaType === "tv" ? Number.parseInt(episode, 10) : null,
          count: result.options.length,
          options: result.options,
          selectors: result.selectors,
          requestUrl: result.requestUrl,
        });
        return;
      }

      const pageUrl = searchParams.get("url");
      if (!pageUrl) {
        sendJson(res, 400, { error: "url query parameter is required" });
        return;
      }

      new URL(pageUrl);
      const type = searchParams.get("type") || "quality";
      const result =
        type === "direct"
          ? await fetchDirectDownloadOptions(pageUrl, source || null)
          : await fetchDownloadOptions(pageUrl, source || null);
      sendJson(res, 200, {
        url: pageUrl,
        type,
        count: result.options.length,
        options: result.options,
        selectors: result.selectors,
        cached: Boolean(result.cached),
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

  if (url === "/swagger" || url === "/swagger.html") {
    serveFile(res, path.join(PUBLIC_DIR, "swagger.html"));
    return;
  }

  if (url === "/openapi.json") {
    serveFile(res, path.join(PUBLIC_DIR, "openapi.json"));
    return;
  }


  sendJson(res, 404, { error: "Not found" });
});

const CACHE_REFRESH_MS =
  (Number.parseFloat(process.env.CACHE_REFRESH_HOURS) || 4) * 60 * 60 * 1000;
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
        secondaryUrl,
        maxPages,
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

  try {
    await initDownloadOptionsCache(process.env.REDIS_URL);
  } catch (err) {
    console.warn("Download options cache init failed:", err.message);
  }

  let jobHistoryEnabled = false;
  try {
    jobHistoryEnabled = await initJobHistory(process.env.REDIS_URL);
  } catch (err) {
    console.warn("Job history Redis init failed, continuing without it:", err.message);
  }

  server.listen(PORT, () => {
    console.log(`Movie server listening on http://localhost:${PORT}`);
    console.log(`Dashboard: http://localhost:${PORT}/`);
    console.log(`Swagger:   http://localhost:${PORT}/swagger`);
    console.log(`API:       http://localhost:${PORT}/api/movies`);
    console.log(`Scraping:  ${mainUrl}`);
    console.log(
      `Secondary: ${secondaryUrl ? `${secondaryUrl} (HD only)` : "disabled (set SECONDARY_URL)"}`
    );
    console.log(`Pages:     1-${maxPages}`);
    console.log(`TMDB:      ${TMDB_API_KEY ? "enabled" : "disabled (set TMDB_API_KEY in .env)"}`);
    console.log(`Downloads: ${getDownloadDir()}`);
    console.log(`HD tags:   ${HD_KEYWORDS.join(", ")}`);
    console.log(`4K tags:   ${K4_KEYWORDS.join(", ")}`);
    console.log(`Emby:      ${isEmbyConfigured() ? "enabled" : "disabled (set EMBY_URL + EMBY_API_KEY)"}`);
    console.log(`Probe cache: ${probeCacheEnabled ? "enabled" : "disabled (no REDIS_URL)"}`);
    console.log(`TMDB cache:  ${tmdbCacheEnabled ? "enabled" : "disabled (no REDIS_URL)"}`);
    console.log(`Job history: ${jobHistoryEnabled ? "enabled" : "disabled (no REDIS_URL)"}`);
  });

  runSubtitlePrefetchSweep();
  setInterval(runSubtitlePrefetchSweep, SUBTITLE_PREFETCH_MS);
}

startServer();
