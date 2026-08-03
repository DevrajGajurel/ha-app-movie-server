const { spawn } = require("child_process");
const path = require("path");
const { createClient } = require("redis");

const CACHE_KEY = "movieserver:v1:vidsrc:catalog";
const DEFAULT_REFRESH_MS = 4 * 60 * 60 * 1000;
const VIDSRC_DIR = path.join(__dirname, "..", "vidsrc");

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

function runPythonRefresh() {
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

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderr += text;
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        console.log(`[vidsrc-refresh] ${line}`);
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`vidsrc refresh exited ${code}: ${stderr.slice(-800) || "no stderr"}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        reject(new Error(`vidsrc refresh returned invalid JSON: ${err.message}`));
      }
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
    const payload = await runPythonRefresh();
    payload.refreshedAt = payload.refreshedAt || new Date().toISOString();
    payload.refreshReason = reason;
    await client.set(CACHE_KEY, JSON.stringify(payload));
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
    return {
      movies: [],
      refreshedAt: null,
      refreshing: refreshInProgress,
      lastError: lastRefreshError,
    };
  }

  try {
    const catalog = JSON.parse(raw);
    return {
      ...catalog,
      movies: Array.isArray(catalog.movies) ? catalog.movies : [],
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
  shutdownStreamCatalog,
  isReady,
};
