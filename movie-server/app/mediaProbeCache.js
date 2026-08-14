const crypto = require("crypto");
const { createClient } = require("redis");

// ffprobe has to demux a file's headers/streams to answer "what audio and
// subtitle tracks does this have, what resolution/codec is it" -- cheap
// compared to the video-transcode work elsewhere in this app, but it's a
// subprocess spawn per call, and the same file gets probed 2-3 times in one
// normal session (detail page open, the version picker, then the player
// itself all hit /api/downloads/versions independently). None of that
// answer ever changes for a given file unless the file itself changes, so
// it's cached here indefinitely rather than re-run every time.
// Bumped to v2 when videoProfile/videoBitDepth were added to the probe
// result, and to v3 when videoLevel was added - old entries are missing
// new fields entirely (not just null), which would silently defeat
// whatever guard/fix depends on them for every file already cached before
// that change.
const CACHE_PREFIX = "movieserver:v3:probe";

let client = null;

async function initProbeCache(redisUrl) {
  if (!redisUrl) return false;
  client = createClient({ url: redisUrl });
  client.on("error", (err) => console.warn("[probe-cache]", err.message));
  await client.connect();
  return true;
}

function isReady() {
  return Boolean(client?.isReady);
}

// Keyed by path + size + mtime rather than path alone: a file replaced by a
// re-download (different size/mtime, same filename) gets a fresh cache
// entry automatically instead of serving stale track info for the old
// file. The old entry is just orphaned, not cleaned up -- same tradeoff
// already made for the trailer/subtitle caches elsewhere in this app.
function keyFor(filePath, stat) {
  const hash = crypto
    .createHash("sha256")
    .update(`${filePath}:${stat.size}:${stat.mtimeMs}`)
    .digest("hex")
    .slice(0, 24);
  return `${CACHE_PREFIX}:${hash}`;
}

async function getCachedProbe(filePath, stat) {
  if (!isReady()) return null;
  try {
    const raw = await client.get(keyFor(filePath, stat));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function setCachedProbe(filePath, stat, result) {
  if (!isReady()) return;
  try {
    await client.set(keyFor(filePath, stat), JSON.stringify(result));
  } catch {
    // Best-effort — a failed cache write shouldn't affect the response
    // that already has the freshly-probed result.
  }
}

module.exports = { initProbeCache, isReady, getCachedProbe, setCachedProbe };
