const { spawn } = require("child_process");
const path = require("path");
const { createClient } = require("redis");
const { buildClientProxyPath, REFERER_DEFAULT } = require("./hlsProxy");
const { getCatalog } = require("./streamCatalog");

const VIDSRC_DIR = path.join(__dirname, "..", "vidsrc");
const CACHE_PREFIX = "movieserver:v1:vidsrc:resolve:";
const CACHE_TTL_SEC = Math.max(
  300,
  Math.round((Number.parseFloat(process.env.STREAM_RESOLVE_CACHE_HOURS) || 2) * 3600)
);

let resolveClient = null;
let resolveInflight = new Map();

function cacheKey({ type, tmdbId, season, episode }) {
  const s = type === "tv" ? Number(season) || 0 : 0;
  const e = type === "tv" ? Number(episode) || 0 : 0;
  return `${CACHE_PREFIX}${type}:${tmdbId}:s${s}:e${e}`;
}

async function initResolveCache(redisUrl) {
  if (!redisUrl || resolveClient) return Boolean(resolveClient?.isReady);
  try {
    resolveClient = createClient({ url: redisUrl });
    resolveClient.on("error", (err) => console.warn("[stream-resolve-redis]", err.message));
    await resolveClient.connect();
    return true;
  } catch (err) {
    console.warn("[stream-resolve] Redis unavailable:", err.message);
    resolveClient = null;
    return false;
  }
}

async function readResolveCache(key) {
  if (!resolveClient?.isReady) return null;
  try {
    const raw = await resolveClient.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function writeResolveCache(key, value) {
  if (!resolveClient?.isReady) return;
  try {
    await resolveClient.set(key, JSON.stringify(value), { EX: CACHE_TTL_SEC });
  } catch (err) {
    console.warn("[stream-resolve] cache write failed:", err.message);
  }
}

function absoluteProxyUrl(req, proxyPath) {
  const host = req.headers.host || "127.0.0.1:3001";
  const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim() || "http";
  return `${proto}://${host}${proxyPath}`;
}

function normalizeQualities(stream) {
  const referer = stream.referer || REFERER_DEFAULT;
  const qualities = Array.isArray(stream.qualities)
    ? stream.qualities.filter((q) => q?.url)
    : [];
  if (qualities.length) {
    return qualities.map((q) => ({
      label: q.label || q.resolution || "Auto",
      resolution: q.resolution || null,
      width: q.width || null,
      height: q.height || null,
      bandwidth: q.bandwidth || null,
      url: q.url,
      referer: q.referer || referer,
    }));
  }
  if (stream.url) {
    return [
      {
        label: stream.bestQuality || stream.best_quality || "Auto",
        resolution: null,
        width: null,
        height: null,
        bandwidth: null,
        url: stream.url,
        referer,
      },
    ];
  }
  return [];
}

function pickBestQuality(qualities) {
  if (!qualities.length) return null;
  return [...qualities].sort((a, b) => {
    const ah = a.height || 0;
    const bh = b.height || 0;
    if (bh !== ah) return bh - ah;
    return (b.bandwidth || 0) - (a.bandwidth || 0);
  })[0];
}

function withProxyFields(req, item) {
  const proxyPath = buildClientProxyPath(item.url, item.referer || REFERER_DEFAULT);
  return {
    ...item,
    proxyPath,
    proxyUrl: absoluteProxyUrl(req, proxyPath),
  };
}

function buildResolvePayload(req, { type, tmdbId, season, episode, movie, source, cached }) {
  const stream = (movie.streams || []).find((s) => s?.url) || movie.streams?.[0];
  if (!stream?.url) {
    const err = new Error("No playable streams found");
    err.statusCode = 404;
    throw err;
  }
  const referer = stream.referer || movie.referer || REFERER_DEFAULT;
  const qualities = normalizeQualities({ ...stream, referer }).map((q) => withProxyFields(req, q));
  const best = pickBestQuality(qualities) || withProxyFields(req, { url: stream.url, referer, label: "Auto" });
  const master = withProxyFields(req, {
    url: stream.url,
    referer,
    label: stream.bestQuality || stream.best_quality || best.label || "Auto",
  });

  return {
    ok: true,
    tmdbId: String(tmdbId),
    type,
    season: type === "tv" ? Number(season) : null,
    episode: type === "tv" ? Number(episode) : null,
    title: movie.title || null,
    year: movie.year || null,
    poster: movie.poster || null,
    referer,
    // Convenience: play the master playlist via proxy (player can pick levels).
    proxyUrl: master.proxyUrl,
    proxyPath: master.proxyPath,
    streamUrl: master.url,
    bestQuality: best.label || null,
    bestProxyUrl: best.proxyUrl,
    bestProxyPath: best.proxyPath,
    qualities,
    source,
    cached: Boolean(cached),
  };
}

function findInCatalog(catalog, tmdbId) {
  const id = String(tmdbId);
  return (catalog?.movies || []).find((m) => String(m.tmdbId) === id && Array.isArray(m.streams) && m.streams.length);
}

function runPythonResolve({ type, tmdbId, season, episode }) {
  const python = process.env.VIDSRC_PYTHON || (process.platform === "win32" ? "python" : "python3");
  const script = path.join(VIDSRC_DIR, "resolve_one.py");
  const args = [script, String(tmdbId), "--type", type, "--browser-timeout", "90"];
  if (type === "tv") {
    args.push("--season", String(season), "--episode", String(episode));
  }

  return new Promise((resolve, reject) => {
    const child = spawn(python, args, {
      cwd: VIDSRC_DIR,
      env: { ...process.env },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const line = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .pop();
      if (!line) {
        reject(new Error(stderr.slice(-400) || `resolve exited ${code} with no output`));
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        reject(new Error(`Invalid resolve JSON: ${err.message}`));
        return;
      }
      if (!parsed.ok) {
        const error = new Error(parsed.error || "Resolve failed");
        error.statusCode = 502;
        reject(error);
        return;
      }
      if (!Array.isArray(parsed.streams) || !parsed.streams.length) {
        const error = new Error("No playable streams found");
        error.statusCode = 404;
        reject(error);
        return;
      }
      resolve(parsed);
    });
  });
}

async function resolveStreamByTmdb(req, rawOpts = {}) {
  const type = String(rawOpts.type || "movie").toLowerCase() === "tv" ? "tv" : "movie";
  const tmdbId = String(rawOpts.tmdbId || rawOpts.id || "").trim();
  if (!tmdbId) {
    const err = new Error("tmdbId is required");
    err.statusCode = 400;
    throw err;
  }

  let season = rawOpts.season != null ? Number.parseInt(rawOpts.season, 10) : null;
  let episode = rawOpts.episode != null ? Number.parseInt(rawOpts.episode, 10) : null;
  if (type === "tv") {
    if (!Number.isFinite(season) || season < 1 || !Number.isFinite(episode) || episode < 1) {
      const err = new Error("season and episode are required for type=tv");
      err.statusCode = 400;
      throw err;
    }
  } else {
    season = null;
    episode = null;
  }

  const key = cacheKey({ type, tmdbId, season, episode });
  const cached = await readResolveCache(key);
  if (cached?.streams?.length) {
    return buildResolvePayload(req, {
      type,
      tmdbId,
      season,
      episode,
      movie: cached,
      source: cached.source || "cache",
      cached: true,
    });
  }

  if (type === "movie") {
    try {
      const catalog = await getCatalog();
      const hit = findInCatalog(catalog, tmdbId);
      if (hit) {
        const movie = {
          title: hit.title,
          year: hit.year,
          poster: hit.poster,
          referer: hit.referer,
          streams: hit.streams,
          source: "catalog",
        };
        await writeResolveCache(key, movie);
        return buildResolvePayload(req, {
          type,
          tmdbId,
          season,
          episode,
          movie,
          source: "catalog",
          cached: false,
        });
      }
    } catch {
      // fall through to live scrape
    }
  }

  if (resolveInflight.has(key)) {
    const movie = await resolveInflight.get(key);
    return buildResolvePayload(req, {
      type,
      tmdbId,
      season,
      episode,
      movie,
      source: movie.source || "live",
      cached: false,
    });
  }

  const pending = runPythonResolve({ type, tmdbId, season, episode })
    .then((result) => {
      const movie = {
        title: null,
        year: null,
        poster: null,
        referer: result.streams?.[0]?.referer || REFERER_DEFAULT,
        streams: result.streams,
        playerHost: result.player_host || null,
        source: "live",
      };
      return writeResolveCache(key, movie).then(() => movie);
    })
    .finally(() => {
      resolveInflight.delete(key);
    });

  resolveInflight.set(key, pending);
  const movie = await pending;
  return buildResolvePayload(req, {
    type,
    tmdbId,
    season,
    episode,
    movie,
    source: "live",
    cached: false,
  });
}

module.exports = {
  initResolveCache,
  resolveStreamByTmdb,
};
