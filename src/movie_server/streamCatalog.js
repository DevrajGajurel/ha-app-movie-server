const { spawn } = require("child_process");
const path = require("path");
const { createClient } = require("redis");

const CACHE_KEY = "movieserver:v1:vidsrc:catalog";
const MANUAL_KEY = "movieserver:v1:vidsrc:manual";
const DEFAULT_REFRESH_MS = 4 * 60 * 60 * 1000;
const VIDSRC_DIR = path.join(__dirname, "..", "vidsrc");
const REFERER_HINT = "https://cloudorchestranova.com/";

let client = null;
let refreshTimer = null;
let refreshInProgress = false;
let lastRefreshError = null;

function isReady() {
  return Boolean(client?.isReady);
}

async function initStreamCatalog({
  redisUrl,
  refreshMs = DEFAULT_REFRESH_MS,
  refreshOnStartup = true,
} = {}) {
  if (!redisUrl) {
    console.warn("[streams] Redis URL missing — stream catalog disabled");
    return false;
  }

  client = createClient({ url: redisUrl });
  client.on("error", (err) => console.warn("[streams-redis]", err.message));
  await client.connect();
  console.log(`[streams] Redis connected (refresh every ${Math.round(refreshMs / 3600000)}h)`);

  scheduleBackgroundRefresh(refreshMs);
  if (refreshOnStartup) {
    refreshCatalog("startup").catch((err) => {
      console.warn("[streams] startup refresh failed:", err.message);
    });
  }
  return true;
}

function scheduleBackgroundRefresh(refreshMs) {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    refreshCatalog("scheduled").catch((err) => {
      console.warn("[streams] scheduled refresh failed:", err.message);
    });
  }, refreshMs);
}

async function writeCatalog(catalog) {
  await client.set(CACHE_KEY, JSON.stringify(catalog));
}

async function readManualMovies() {
  if (!isReady()) return [];
  try {
    const raw = await client.get(MANUAL_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeManualMovies(movies) {
  await client.set(MANUAL_KEY, JSON.stringify(movies));
}

function safeHttpUrl(raw) {
  let parsed;
  try {
    parsed = new URL(String(raw || "").trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!parsed.host) return null;
  return parsed.href;
}

function buildManualEntry({ title, url, referer, poster, year, tmdbId, overview }) {
  const streamUrl = safeHttpUrl(url);
  if (!streamUrl) {
    throw new Error("url must be a valid http(s) address");
  }
  const cleanTitle = String(title || "").trim();
  if (!cleanTitle) {
    throw new Error("title is required");
  }
  const cleanReferer = safeHttpUrl(referer) || REFERER_HINT;
  const cleanPoster = poster ? safeHttpUrl(poster) : null;
  const id = `manual-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    manual: true,
    tmdbId: tmdbId != null && String(tmdbId).trim() ? String(tmdbId).trim() : null,
    title: cleanTitle,
    overview: overview ? String(overview).trim() : null,
    year: year != null && String(year).trim() ? String(year).trim().slice(0, 4) : null,
    rating: null,
    poster: cleanPoster,
    backdrop: null,
    referer: cleanReferer,
    playerHost: null,
    streams: [
      {
        url: streamUrl,
        type: "hls",
        referer: cleanReferer,
        bestQuality: "Auto",
        qualities: [
          {
            label: "Auto",
            resolution: null,
            width: null,
            height: null,
            bandwidth: null,
            frameRate: null,
            codecs: null,
            url: streamUrl,
          },
        ],
      },
    ],
    errors: [],
    addedAt: new Date().toISOString(),
  };
}

async function addManualStream(input) {
  if (!isReady()) throw new Error("Stream catalog Redis is not ready");
  const entry = buildManualEntry(input || {});
  const manuals = await readManualMovies();
  const next = [entry, ...manuals.filter((m) => m?.streams?.[0]?.url !== entry.streams[0].url)];
  await writeManualMovies(next);
  console.log(`[streams] manual add: ${entry.title}`);
  return entry;
}

async function removeManualStream(id) {
  if (!isReady()) throw new Error("Stream catalog Redis is not ready");
  const cleanId = String(id || "").trim();
  if (!cleanId) throw new Error("id is required");
  const manuals = await readManualMovies();
  const next = manuals.filter((m) => m?.id !== cleanId);
  if (next.length === manuals.length) {
    throw new Error("Manual stream not found");
  }
  await writeManualMovies(next);
  console.log(`[streams] manual remove: ${cleanId}`);
  return { ok: true, id: cleanId };
}

function emptyCatalog(reason, window = "week") {
  return {
    refreshedAt: null,
    window,
    count: 0,
    playable: 0,
    refererHint: REFERER_HINT,
    refreshReason: reason,
    movies: [],
  };
}

function runPythonRefreshIncremental(reason) {
  const python = process.env.VIDSRC_PYTHON || (process.platform === "win32" ? "python" : "python3");
  const script = path.join(VIDSRC_DIR, "refresh_trending.py");
  const limit = String(process.env.STREAM_TRENDING_LIMIT || "20");
  const window = process.env.STREAM_TRENDING_WINDOW || "week";

  return new Promise((resolve, reject) => {
    const child = spawn(python, [script, "--window", window, "--limit", limit], {
      cwd: VIDSRC_DIR,
      env: { ...process.env },
      windowsHide: true,
    });

    let stderr = "";
    let lineBuf = "";
    let catalog = emptyCatalog(reason, window);
    let writeChain = Promise.resolve();
    let failed = false;

    const queueWrite = (nextCatalog) => {
      catalog = nextCatalog;
      writeChain = writeChain
        .then(() => writeCatalog(catalog))
        .catch((err) => {
          console.warn("[streams] incremental Redis write failed:", err.message);
        });
      return writeChain;
    };

    const handleEvent = (event) => {
      if (!event || typeof event !== "object") return;

      if (event.event === "start") {
        catalog = {
          ...emptyCatalog(reason, event.window || window),
          window: event.window || window,
          count: Number(event.total) || 0,
          refererHint: event.refererHint || REFERER_HINT,
        };
        console.log(`[streams] scrape started (${catalog.count} titles)`);
        return queueWrite(catalog);
      }

      if (event.event === "movie" && event.movie) {
        const movies = [...(catalog.movies || []), event.movie];
        const playable = movies.filter((m) => Array.isArray(m.streams) && m.streams.length > 0).length;
        catalog = {
          ...catalog,
          movies,
          playable,
          // Keep declared total from start; fall back to progress index.
          count: catalog.count || Number(event.total) || movies.length,
        };
        const title = event.movie.title || event.movie.tmdbId || "?";
        const labels = [];
        const seen = new Set();
        for (const stream of event.movie.streams || []) {
          for (const q of stream.qualities || []) {
            if (q?.label && !seen.has(q.label)) {
              seen.add(q.label);
              labels.push(q.label);
            }
          }
          if (stream.bestQuality && !seen.has(stream.bestQuality)) {
            seen.add(stream.bestQuality);
            labels.push(stream.bestQuality);
          }
        }
        console.log(
          `[streams] ${event.index}/${event.total || "?"} ${title} — ${labels.length ? labels.join(", ") : "no streams"}`
        );
        return queueWrite(catalog);
      }

      if (event.event === "done") {
        catalog = {
          ...catalog,
          refreshedAt: event.refreshedAt || new Date().toISOString(),
          window: event.window || catalog.window,
          count: event.count != null ? event.count : catalog.movies.length,
          playable:
            event.playable != null
              ? event.playable
              : catalog.movies.filter((m) => Array.isArray(m.streams) && m.streams.length > 0).length,
          refererHint: event.refererHint || catalog.refererHint || REFERER_HINT,
          refreshReason: reason,
        };
        return queueWrite(catalog);
      }
    };

    child.stdout.on("data", (chunk) => {
      lineBuf += chunk.toString("utf8");
      const parts = lineBuf.split(/\r?\n/);
      lineBuf = parts.pop() || "";
      for (const line of parts) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // Only structured events are NDJSON; anything else is scraper noise.
        if (!trimmed.startsWith("{")) {
          console.log(`[vidsrc] ${trimmed}`);
          continue;
        }
        try {
          handleEvent(JSON.parse(trimmed));
        } catch (err) {
          console.warn("[streams] bad NDJSON line:", err.message, trimmed.slice(0, 120));
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderr += text;
      // Only forward the brief per-title summaries (and failures); drop Chrome noise.
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        if (line.startsWith("[vidsrc-refresh]")) {
          console.log(line);
        }
      }
    });

    child.on("error", (err) => {
      failed = true;
      reject(err);
    });

    child.on("close", (code) => {
      const finish = async () => {
        try {
          await writeChain;
        } catch {
          // already logged
        }
        if (failed) return;
        if (lineBuf.trim()) {
          try {
            handleEvent(JSON.parse(lineBuf.trim()));
            await writeChain;
          } catch {
            // ignore trailing garbage
          }
        }
        if (code !== 0) {
          reject(new Error(`vidsrc refresh exited ${code}: ${stderr.slice(-800) || "no stderr"}`));
          return;
        }
        resolve(catalog);
      };
      finish().catch(reject);
    });
  });
}

async function refreshCatalog(reason = "manual") {
  if (!isReady()) throw new Error("Stream catalog Redis is not ready");
  if (refreshInProgress) {
    return { ok: false, refreshing: true, reason: "already-running" };
  }

  refreshInProgress = true;
  lastRefreshError = null;
  console.log(`[streams] refreshing catalog (${reason})…`);

  try {
    // Clear previous catalog so the TV shows titles as they arrive.
    await writeCatalog(emptyCatalog(reason));
    const payload = await runPythonRefreshIncremental(reason);
    console.log(
      `[streams] refresh complete (${reason}): ${payload.playable || 0}/${payload.count || 0} playable`
    );
    return { ok: true, refreshing: false, catalog: summarizeCatalog(payload) };
  } catch (err) {
    lastRefreshError = err.message;
    console.warn(`[streams] refresh failed (${reason}):`, err.message);
    throw err;
  } finally {
    refreshInProgress = false;
  }
}

function summarizeCatalog(catalog) {
  if (!catalog) return null;
  return {
    refreshedAt: catalog.refreshedAt || null,
    window: catalog.window || null,
    count: catalog.count || 0,
    playable: catalog.playable || 0,
  };
}

async function getCatalog() {
  if (!isReady()) {
    return {
      movies: [],
      refreshedAt: null,
      refreshing: refreshInProgress,
      error: "Stream catalog Redis is not ready",
    };
  }

  let raw = null;
  try {
    raw = await client.get(CACHE_KEY);
  } catch (err) {
    return {
      movies: [],
      refreshedAt: null,
      refreshing: refreshInProgress,
      error: err.message,
    };
  }

  if (!raw) {
    const manuals = await readManualMovies();
    return {
      movies: manuals,
      refreshedAt: null,
      count: manuals.length,
      playable: manuals.filter((m) => Array.isArray(m.streams) && m.streams.length > 0).length,
      refreshing: refreshInProgress,
      lastError: lastRefreshError,
    };
  }

  try {
    const catalog = JSON.parse(raw);
    const scraped = Array.isArray(catalog.movies) ? catalog.movies : [];
    const manuals = await readManualMovies();
    const movies = [...manuals, ...scraped.filter((m) => !m?.manual)];
    return {
      ...catalog,
      movies,
      count: movies.length,
      playable: movies.filter((m) => Array.isArray(m.streams) && m.streams.length > 0).length,
      refreshing: refreshInProgress,
      lastError: lastRefreshError,
    };
  } catch (err) {
    return {
      movies: [],
      refreshedAt: null,
      refreshing: refreshInProgress,
      error: `Corrupt catalog: ${err.message}`,
      lastError: lastRefreshError,
    };
  }
}

function getRefreshStatus() {
  return {
    refreshing: refreshInProgress,
    lastError: lastRefreshError,
    ready: isReady(),
  };
}

async function shutdownStreamCatalog() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
  if (client?.isReady) {
    try {
      await client.quit();
    } catch {
      // ignore
    }
  }
  client = null;
}

module.exports = {
  initStreamCatalog,
  refreshCatalog,
  getCatalog,
  getRefreshStatus,
  addManualStream,
  removeManualStream,
  shutdownStreamCatalog,
  isReady,
};
