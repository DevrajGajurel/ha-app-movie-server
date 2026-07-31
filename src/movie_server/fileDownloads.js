const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const { execFile, spawn } = require("child_process");
const { getCachedProbe, setCachedProbe } = require("./mediaProbeCache");

const MARKER_FILE = ".movieserver.json";
const PROGRESS_FILE = ".movieserver-progress.json";
const RESUME_MIN_SECONDS = 10;
const RESUME_DONE_RATIO = 0.95;
const jobs = [];
let jobId = 0;

function getDownloadDir() {
  return process.env.DOWNLOAD_DIR || path.join(__dirname, "downloads");
}

function sanitizeName(value) {
  return String(value || "download")
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function normalizeTitle(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\(tmdb-\d+\)/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function folderNameFor(movieTitle, tmdbId) {
  const base = sanitizeName(movieTitle || "download");
  return tmdbId ? `${base} (tmdb-${tmdbId})` : base;
}

function ensureDir(movieTitle, tmdbId) {
  const base = path.resolve(getDownloadDir());
  const dir = movieTitle || tmdbId ? path.join(base, folderNameFor(movieTitle, tmdbId)) : base;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeMarker(dir, data) {
  try {
    fs.writeFileSync(path.join(dir, MARKER_FILE), JSON.stringify(data, null, 2));
  } catch (err) {
    console.warn(`[download] could not write marker in ${dir}: ${err.message}`);
  }
}

function pickFilename(contentDisposition, finalUrl, label) {
  if (contentDisposition) {
    const utfMatch = /filename\*=UTF-8''([^;]+)/i.exec(contentDisposition);
    if (utfMatch) return decodeURIComponent(utfMatch[1]);
    const match = /filename="?([^";]+)"?/i.exec(contentDisposition);
    if (match) return match[1];
  }

  const urlName = path.basename(new URL(finalUrl).pathname);
  if (urlName && urlName !== "/" && urlName.includes(".")) return urlName;
  return `${sanitizeName(label)}.mkv`;
}

function uniquePath(dir, filename) {
  const safeName = sanitizeName(filename);
  let target = path.join(dir, safeName);
  if (!fs.existsSync(target)) return target;

  const ext = path.extname(safeName);
  const base = path.basename(safeName, ext);
  target = path.join(dir, `${base}-${Date.now()}${ext || ".bin"}`);
  return target;
}

// Plain single-connection fetch + stream-to-disk — the original (and
// still default) download path.
async function downloadFileWithFetch(job, dir) {
  const response = await fetch(job.url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status}`);
  }

  const filename = pickFilename(response.headers.get("content-disposition"), response.url, job.label);
  const filePath = uniquePath(dir, filename);

  job.totalBytes = Number(response.headers.get("content-length")) || 0;
  job.receivedBytes = 0;

  const fileStream = fs.createWriteStream(filePath);
  const body = Readable.fromWeb(response.body);

  body.on("data", (chunk) => {
    job.receivedBytes += chunk.length;
  });

  await pipeline(body, fileStream);
  return filePath;
}

// Same filename-resolution chain as downloadFileWithFetch (Content-
// Disposition, then the final URL, then a sanitized label) — a HEAD
// request gets us the header without pulling any body, since aria2c below
// handles the actual transfer itself. Falls back to the URL/label alone
// if the server doesn't support HEAD or the request fails outright;
// pickFilename already tolerates a null contentDisposition for that.
async function resolveAria2Filename(job) {
  let contentDisposition = null;
  let finalUrl = job.url;
  try {
    const res = await fetch(job.url, { method: "HEAD", redirect: "follow" });
    contentDisposition = res.headers.get("content-disposition");
    finalUrl = res.url || job.url;
  } catch {
    // Fall through to the URL/label-based name below.
  }
  return pickFilename(contentDisposition, finalUrl, job.label);
}

// aria2c prints a live-updating status line while downloading, e.g.
// "[#1a2b3c 120MiB/500MiB(24%) CN:8 DL:95MiB ETA:4s]" — parsed here for
// job progress instead of needing its RPC interface (which, unlike the
// plain CLI mode, keeps the process running indefinitely after the
// download finishes and would need an explicit shutdown call).
const ARIA2_PROGRESS_RE = /\[#\w+\s+([\d.]+)(B|KiB|MiB|GiB|TiB)\/([\d.]+)(B|KiB|MiB|GiB|TiB)\(/;
const ARIA2_UNIT_BYTES = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4 };
const ARIA2_CONNECTIONS = 8;

function parseAria2Progress(text) {
  const match = ARIA2_PROGRESS_RE.exec(text);
  if (!match) return null;
  const [, curVal, curUnit, totalVal, totalUnit] = match;
  return {
    receivedBytes: Math.round(Number.parseFloat(curVal) * ARIA2_UNIT_BYTES[curUnit]),
    totalBytes: Math.round(Number.parseFloat(totalVal) * ARIA2_UNIT_BYTES[totalUnit]),
  };
}

// Segmented, multi-connection download via aria2c — opt-in (see
// isAria2Enabled), since it's a separate binary and a different code path
// from the plain fetch above. Splits the file across ARIA2_CONNECTIONS
// parallel Range-request connections, which can substantially beat a
// single connection's throughput against slow/rate-limited source
// servers (common on piracy-mirror sites), at the cost of an extra
// process dependency.
function downloadFileWithAria2(job, dir) {
  return resolveAria2Filename(job).then((filename) => {
    const filePath = uniquePath(dir, filename);
    job.totalBytes = 0;
    job.receivedBytes = 0;

    return new Promise((resolve, reject) => {
      // aria2c's boolean/valued flags need the "=value" inline form —
      // space-separated ("--allow-overwrite" "true") gets parsed as a
      // valueless flag followed by "true" as a second, separate URI
      // argument, which aria2c then rejects as an invalid download target.
      const aria2 = spawn("aria2c", [
        `--dir=${dir}`,
        `--out=${path.basename(filePath)}`,
        `--max-connection-per-server=${ARIA2_CONNECTIONS}`,
        `--split=${ARIA2_CONNECTIONS}`,
        "--min-split-size=5M",
        "--summary-interval=1",
        "--console-log-level=warn",
        "--allow-overwrite=true",
        job.url,
      ]);

      let stderrTail = "";
      const handleOutput = (chunk) => {
        const text = chunk.toString();
        stderrTail = (stderrTail + text).slice(-2000);
        const progress = parseAria2Progress(text);
        if (progress) {
          job.receivedBytes = progress.receivedBytes;
          job.totalBytes = progress.totalBytes;
        }
      };
      aria2.stdout.on("data", handleOutput);
      aria2.stderr.on("data", handleOutput);

      aria2.on("error", reject);
      aria2.on("close", (code) => {
        if (code === 0) resolve(filePath);
        else reject(new Error(`aria2c exited ${code}: ${stderrTail}`));
      });
    });
  });
}

function isAria2Enabled() {
  return String(process.env.USE_ARIA2 || "").toLowerCase() === "true";
}

async function runDownload(job) {
  job.status = "downloading";

  try {
    const dir = ensureDir(job.movieTitle, job.tmdbId);
    const filePath = isAria2Enabled() ? await downloadFileWithAria2(job, dir) : await downloadFileWithFetch(job, dir);

    job.filePath = filePath;
    job.status = "completed";
    job.finishedAt = new Date().toISOString();

    writeMarker(dir, {
      tmdbId: job.tmdbId || null,
      movieTitle: job.movieTitle || null,
      label: job.label || null,
      file: path.basename(filePath),
      savedAt: job.finishedAt,
    });

    console.log(`[download] saved job #${job.id} -> ${filePath}`);

    try {
      const { refreshAfterDownload } = require("./emby");
      await refreshAfterDownload(filePath);
    } catch (err) {
      console.warn(`[download] Emby refresh failed: ${err.message}`);
    }

    // Convert this file's subtitle tracks now, not on first play — see
    // prefetchAllSubtitles' comment for why.
    prefetchSubtitlesForFile(filePath).catch((err) => {
      console.warn(`[subtitles] prefetch failed for ${filePath}: ${err.message}`);
    });
  } catch (err) {
    job.status = "failed";
    job.error = err.message;
    job.finishedAt = new Date().toISOString();
    console.error(`[download] failed job #${job.id}: ${err.message}`);
  }
}

function startDownload({ url, label, movieTitle, tmdbId }) {
  const job = {
    id: ++jobId,
    url,
    label,
    movieTitle: movieTitle || null,
    tmdbId: tmdbId ? String(tmdbId) : null,
    status: "queued",
    receivedBytes: 0,
    totalBytes: 0,
    filePath: null,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };

  jobs.unshift(job);
  if (jobs.length > 100) jobs.length = 100;

  console.log(`[download] queued job #${job.id} "${label}" -> ${getDownloadDir()}`);
  runDownload(job);
  return job;
}

function getJob(id) {
  return jobs.find((job) => job.id === id);
}

function listJobs() {
  return jobs;
}

function initDownloadDir() {
  const dir = path.resolve(getDownloadDir());
  fs.mkdirSync(dir, { recursive: true });
  console.log(`[download] folder ready: ${dir}`);
}

function hasMediaFiles(dir) {
  try {
    return fs.readdirSync(dir).some((name) => {
      if (name === MARKER_FILE || name === PROGRESS_FILE) return false;
      const full = path.join(dir, name);
      try {
        return fs.statSync(full).isFile();
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

const VIDEO_EXTENSIONS = new Set([".mp4", ".mkv", ".webm", ".avi", ".mov", ".m4v"]);
const MIME_TYPES = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".avi": "video/x-msvideo",
  ".mov": "video/quicktime",
};

function findMatchingDirs({ tmdbId, title }) {
  const base = path.resolve(getDownloadDir());
  const normTitle = title ? normalizeTitle(title) : null;

  let entries;
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }

  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(base, entry.name);

    let entryTmdbId = null;
    let entryTitle = entry.name;
    const marker = path.join(dir, MARKER_FILE);
    if (fs.existsSync(marker)) {
      try {
        const data = JSON.parse(fs.readFileSync(marker, "utf8"));
        if (data.tmdbId) entryTmdbId = String(data.tmdbId);
        if (data.movieTitle) entryTitle = data.movieTitle;
      } catch {
        // fall back to folder name parsing
      }
    }
    if (!entryTmdbId) {
      const match = /\(tmdb-(\d+)\)/i.exec(entry.name);
      if (match) entryTmdbId = match[1];
    }
    const cleanTitle = entry.name.replace(/\s*\(tmdb-\d+\)\s*/i, "").trim();

    const tmdbMatches = Boolean(tmdbId && entryTmdbId && String(tmdbId) === entryTmdbId);
    const titleMatches = Boolean(
      normTitle && (normalizeTitle(cleanTitle) === normTitle || normalizeTitle(entryTitle) === normTitle)
    );
    if (!tmdbMatches && !titleMatches) continue;

    dirs.push(dir);
  }
  return dirs;
}

// Every downloaded file matching a movie, across all of its matching
// folders (e.g. separate HD/4K/language downloads), largest first.
function findMediaFiles({ tmdbId, title }) {
  const base = path.resolve(getDownloadDir());
  const results = [];

  for (const dir of findMatchingDirs({ tmdbId, title })) {
    let files;
    try {
      files = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.isFile() || file.name === MARKER_FILE) continue;
      if (!VIDEO_EXTENSIONS.has(path.extname(file.name).toLowerCase())) continue;
      const full = path.join(dir, file.name);
      const size = fs.statSync(full).size;
      // Token is the path relative to the download root; it round-trips
      // through the client so a specific file can be requested later
      // (see resolveMediaToken) without exposing the absolute disk path.
      const token = path.relative(base, full).split(path.sep).join("/");
      results.push({ path: full, token, filename: file.name, size });
    }
  }

  results.sort((a, b) => b.size - a.size);
  return results;
}

function findMediaFile({ tmdbId, title }) {
  const files = findMediaFiles({ tmdbId, title });
  return files.length ? files[0].path : null;
}

// Removes every downloaded folder matching a movie (all versions, plus the
// marker/progress files living alongside them) — the same granularity
// findMatchingDirs already groups things at, so "delete this movie" removes
// exactly what "is this movie downloaded" considers to be its download.
function deleteMedia({ tmdbId, title }) {
  const dirs = findMatchingDirs({ tmdbId, title });
  if (!dirs.length) return { deletedDirs: 0, deletedFiles: [] };

  const deletedFiles = findMediaFiles({ tmdbId, title }).map((file) => file.path);
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { deletedDirs: dirs.length, deletedFiles };
}

// Resolves a token from findMediaFiles() back to an absolute path, refusing
// anything that escapes the download root or isn't a video file.
function resolveMediaToken(token) {
  const base = path.resolve(getDownloadDir());
  const full = path.resolve(base, String(token || ""));
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  if (!VIDEO_EXTENSIONS.has(path.extname(full).toLowerCase())) return null;
  try {
    if (!fs.statSync(full).isFile()) return null;
  } catch {
    return null;
  }
  return full;
}

// Resume position is tied to the movie's download folder (same place
// downloads/marker files already live) rather than a separate database,
// consistent with how everything else in this file is organized. Prefers
// the folder containing the exact file that was playing (via fileToken);
// falls back to a title/tmdbId match when no token is given.
function progressDirsFor({ tmdbId, title, fileToken }) {
  if (fileToken) {
    const resolved = resolveMediaToken(fileToken);
    if (resolved) return [path.dirname(resolved)];
  }
  return findMatchingDirs({ tmdbId, title });
}

function saveProgress({ tmdbId, title, fileToken, positionSeconds, durationSeconds, audioTrack, subtitleTrack }) {
  const dirs = progressDirsFor({ tmdbId, title, fileToken });
  if (!dirs.length) return false;

  // Treat "nearly finished" as complete: reset the resume position so the
  // next play starts from the beginning instead of resuming at 98%. The
  // audio/subtitle track choice is a standing preference for this title,
  // not a resume point, so it's kept even when the position resets.
  const nearlyDone = durationSeconds > 0 && positionSeconds / durationSeconds > RESUME_DONE_RATIO;
  const payload = {
    positionSeconds: nearlyDone ? 0 : positionSeconds,
    durationSeconds: nearlyDone ? 0 : durationSeconds,
    audioTrack: Number.isInteger(audioTrack) ? audioTrack : 0,
    subtitleTrack: Number.isInteger(subtitleTrack) ? subtitleTrack : null,
    updatedAt: new Date().toISOString(),
  };

  for (const dir of dirs) {
    const file = path.join(dir, PROGRESS_FILE);
    try {
      fs.writeFileSync(file, JSON.stringify(payload));
    } catch {
      // Best-effort — a failed write here shouldn't break playback.
    }
  }
  return true;
}

function getProgress({ tmdbId, title, fileToken }) {
  for (const dir of progressDirsFor({ tmdbId, title, fileToken })) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, PROGRESS_FILE), "utf8"));
      // Resume position only counts past a minimum threshold, but a
      // remembered track choice should still be returned even for a
      // freshly-reset (finished) file, so replaying it still uses the last
      // language/subtitles picked regardless of position.
      const hasTrackPreference = Boolean(data.audioTrack) || data.subtitleTrack != null;
      if (data.positionSeconds >= RESUME_MIN_SECONDS || hasTrackPreference) return data;
    } catch {
      // No progress file in this folder, or it's unreadable — keep looking.
    }
  }
  return null;
}

// Inspects a file's streams via ffprobe. Resolves to null (rather than
// throwing) when ffprobe isn't installed or the file can't be parsed, so
// callers can degrade to filename/size-only version info.
//
// Subtitle tracks are filtered to text-based codecs only (subrip/ass/ssa/
// mov_text/webvtt) — those are the only ones ffmpeg can convert to WebVTT
// for <track> playback. Bitmap subtitle formats (PGS, DVD sub/VobSub) are
// pre-rendered images, not text, so there's no text to extract; they're
// left out of the list rather than offered as a subtitle option that would
// fail when selected.
const TEXT_SUBTITLE_CODECS = new Set(["subrip", "ass", "ssa", "mov_text", "webvtt"]);

function runFfprobe(filePath) {
  return new Promise((resolve) => {
    execFile(
      "ffprobe",
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath],
      { maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        try {
          const data = JSON.parse(stdout);
          const streams = data.streams || [];
          const videoStream = streams.find((s) => s.codec_type === "video");
          const audioTracks = streams
            .filter((s) => s.codec_type === "audio")
            .map((s, index) => ({
              index,
              language: s.tags?.language || null,
              title: s.tags?.title || null,
              codec: s.codec_name || null,
              channels: s.channels || null,
            }));
          const subtitleTracks = streams
            .filter((s) => s.codec_type === "subtitle")
            .map((s, index) => ({ index, codec: s.codec_name || null, language: s.tags?.language || null, title: s.tags?.title || null }))
            .filter((s) => TEXT_SUBTITLE_CODECS.has(s.codec));
          resolve({
            durationSeconds: data.format?.duration ? Math.round(Number(data.format.duration)) : null,
            width: videoStream?.width || null,
            height: videoStream?.height || null,
            videoCodec: videoStream?.codec_name || null,
            audioTracks,
            subtitleTracks,
          });
        } catch {
          resolve(null);
        }
      }
    );
  });
}

// The same file gets probed repeatedly in one normal session (detail page,
// version picker, then the player itself), and the answer never changes
// for a given file — see mediaProbeCache.js for why this is cached there
// rather than re-run every time.
async function probeMediaFile(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }

  const cached = await getCachedProbe(filePath, stat);
  if (cached) return cached;

  const result = await runFfprobe(filePath);
  if (result) await setCachedProbe(filePath, stat, result);
  return result;
}

// Extracts one text-based subtitle stream, converted to WebVTT, as a plain
// string. This is a one-shot conversion (not a live stream like
// streamAudioTrackRemux) since subtitle files are tiny — simplest to
// buffer the whole thing rather than pipe it.
function extractSubtitleTrack(filePath, subtitleTrackIndex) {
  return new Promise((resolve, reject) => {
    execFile(
      "ffmpeg",
      ["-v", "error", "-i", filePath, "-map", `0:s:${subtitleTrackIndex}`, "-f", "webvtt", "pipe:1"],
      { maxBuffer: 20 * 1024 * 1024, encoding: "utf8" },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(stdout);
      }
    );
  });
}

// Converting a subtitle track to WebVTT still has to demux the whole file
// (ffmpeg has no "just the subtitles, instantly" shortcut), which on a
// large downloaded movie was visible as a spinner right at the start of
// playback. Caching the converted result as a sibling file means that cost
// is paid once — by a background prefetch — instead of on every play.
function subtitleCachePath(filePath, subtitleTrackIndex) {
  return `${filePath}.track${subtitleTrackIndex}.vtt`;
}

async function ensureSubtitleCache(filePath, subtitleTrackIndex) {
  const cachePath = subtitleCachePath(filePath, subtitleTrackIndex);
  if (fs.existsSync(cachePath)) return cachePath;
  const vtt = await extractSubtitleTrack(filePath, subtitleTrackIndex);
  fs.writeFileSync(cachePath, vtt);
  return cachePath;
}

// Used by the on-demand /api/downloads/subtitle route: serves the cached
// conversion when the background prefetch has already run, and only falls
// back to a live (slower) conversion for a file that hasn't been prefetched
// yet — e.g. a movie downloaded in the last few minutes, or one whose
// prefetch attempt previously failed.
async function getSubtitleVtt(filePath, subtitleTrackIndex) {
  const cachePath = subtitleCachePath(filePath, subtitleTrackIndex);
  try {
    return await fs.promises.readFile(cachePath, "utf8");
  } catch {
    return extractSubtitleTrack(filePath, subtitleTrackIndex);
  }
}

// Walks every downloaded movie's folder and makes sure each of its text
// subtitle tracks has a cached WebVTT conversion, so playback never has to
// wait on ffmpeg for a title that's already been through this once. Run
// once at server startup and again on a slow interval (see main.js) to
// pick up movies added since the last sweep or where a prior attempt
// failed; also triggered immediately after each download completes so a
// freshly downloaded movie doesn't have to wait for the next sweep either.
async function prefetchAllSubtitles() {
  const base = path.resolve(getDownloadDir());
  let entries;
  try {
    entries = await fs.promises.readdir(base, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(base, entry.name);

    let files;
    try {
      files = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.isFile() || !VIDEO_EXTENSIONS.has(path.extname(file.name).toLowerCase())) continue;
      await prefetchSubtitlesForFile(path.join(dir, file.name));
    }
  }
}

async function prefetchSubtitlesForFile(filePath) {
  const probe = await probeMediaFile(filePath);
  for (const track of probe?.subtitleTracks || []) {
    try {
      await ensureSubtitleCache(filePath, track.index);
    } catch (err) {
      console.warn(`[subtitles] prefetch failed for ${filePath} track ${track.index}: ${err.message}`);
    }
  }
}

// Streams a specific (non-default) embedded audio track by remuxing on the
// fly: video is stream-copied (no re-encode) and only the chosen audio
// track is included, muxed as fragmented MP4 so it can be piped without
// seeking the output. This is a live process, so unlike streamFile() above
// it can't honor Range requests / precise seeking.
function streamAudioTrackRemux(req, res, filePath, audioTrackIndex) {
  // Matroska, not fragmented MP4: MP4's moov atom normally has to be
  // written after all the media data, so streaming MP4 to a pipe requires
  // fragmentation flags (frag_keyframe+empty_moov) to work around that —
  // but Tizen's player was rejecting that fragmented-MP4 output outright
  // ("unsupported container/codec") even for a video/audio codec pair that
  // plays fine via direct byte-range passthrough of the original file.
  // Matroska has no such limitation (its clusters stream progressively by
  // design), and since these downloads are already .mkv in practice, this
  // just re-wraps the same codecs Tizen already proved it can play.
  const ffmpeg = spawn("ffmpeg", [
    "-v",
    "error",
    "-i",
    filePath,
    "-map",
    "0:v:0",
    "-map",
    `0:a:${audioTrackIndex}`,
    "-c",
    "copy",
    "-f",
    "matroska",
    "pipe:1",
  ]);

  // Only commit to a 200 once ffmpeg has actually started (Node's "spawn"
  // event) so a missing ffmpeg binary or other launch failure surfaces as a
  // real error response instead of a 200 with an empty body.
  ffmpeg.on("spawn", () => {
    res.writeHead(200, { "Content-Type": "video/x-matroska" });
    ffmpeg.stdout.pipe(res);
  });

  ffmpeg.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end();
    }
  });

  const cleanup = () => {
    if (!ffmpeg.killed) ffmpeg.kill("SIGKILL");
  };
  req.on("close", cleanup);
  res.on("close", cleanup);
}

function streamFile(req, res, filePath) {
  const stat = fs.statSync(filePath);
  const contentType = MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
  const range = req.headers.range;

  if (!range) {
    res.writeHead(200, {
      "Content-Length": stat.size,
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  const match = /bytes=(\d*)-(\d*)/.exec(range);
  const start = match[1] ? Number.parseInt(match[1], 10) : 0;
  let end = match[2] ? Number.parseInt(match[2], 10) : stat.size - 1;
  if (Number.isNaN(end) || end >= stat.size) end = stat.size - 1;

  res.writeHead(206, {
    "Content-Range": `bytes ${start}-${end}/${stat.size}`,
    "Accept-Ranges": "bytes",
    "Content-Length": end - start + 1,
    "Content-Type": contentType,
  });
  fs.createReadStream(filePath, { start, end }).pipe(res);
}

function scanLibrary() {
  const base = path.resolve(getDownloadDir());
  const tmdbIds = new Set();
  const titles = new Set();
  const items = [];

  let entries;
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return { tmdbIds: [], titles: [], items: [] };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(base, entry.name);
    if (!hasMediaFiles(dir)) continue;

    let tmdbId = null;
    let title = entry.name;

    const marker = path.join(dir, MARKER_FILE);
    if (fs.existsSync(marker)) {
      try {
        const data = JSON.parse(fs.readFileSync(marker, "utf8"));
        if (data.tmdbId) tmdbId = String(data.tmdbId);
        if (data.movieTitle) title = data.movieTitle;
      } catch {
        // fall back to folder name parsing
      }
    }

    if (!tmdbId) {
      const match = /\(tmdb-(\d+)\)/i.exec(entry.name);
      if (match) tmdbId = match[1];
    }

    const cleanTitle = entry.name.replace(/\s*\(tmdb-\d+\)\s*/i, "").trim();
    if (cleanTitle) title = title === entry.name ? cleanTitle : title;

    if (tmdbId) tmdbIds.add(String(tmdbId));
    const norm = normalizeTitle(cleanTitle || title);
    if (norm) titles.add(norm);

    items.push({ folder: entry.name, tmdbId, title });
  }

  return {
    tmdbIds: [...tmdbIds],
    titles: [...titles],
    items,
  };
}

/**
 * Scan download folders for in-progress resume markers.
 * Returns newest-first entries still considered "continue watching".
 */
function listProgress() {
  const root = getDownloadDir();
  if (!fs.existsSync(root)) return [];

  const items = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const progressPath = path.join(dir, PROGRESS_FILE);
    if (!fs.existsSync(progressPath)) continue;

    let data;
    try {
      data = JSON.parse(fs.readFileSync(progressPath, "utf8"));
    } catch {
      continue;
    }

    const position = Number(data.positionSeconds) || 0;
    const duration = Number(data.durationSeconds) || 0;
    if (position < RESUME_MIN_SECONDS) continue;
    if (duration > 0 && position / duration >= RESUME_DONE_RATIO) continue;

    let tmdbId = data.tmdbId != null ? String(data.tmdbId) : null;
    let title = data.title || "";
    const markerPath = path.join(dir, MARKER_FILE);
    if (fs.existsSync(markerPath)) {
      try {
        const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
        if (!tmdbId && marker.tmdbId != null) tmdbId = String(marker.tmdbId);
        if (!title && (marker.movieTitle || marker.title)) title = marker.movieTitle || marker.title;
      } catch {
        // ignore
      }
    }
    if (!tmdbId) {
      const match = /\(tmdb-(\d+)\)/i.exec(entry.name);
      if (match) tmdbId = match[1];
    }
    if (!title) {
      title = entry.name.replace(/\s*\(tmdb-\d+\)\s*/i, "").trim() || entry.name;
    }

    const percent =
      duration > 0
        ? Math.min(99, Math.max(1, Math.round((position / duration) * 100)))
        : 0;

    items.push({
      folder: entry.name,
      tmdbId,
      title,
      positionSeconds: position,
      durationSeconds: duration,
      percent,
      updatedAt: data.updatedAt || null,
    });
  }

  items.sort((a, b) => {
    const ta = Date.parse(a.updatedAt || "") || 0;
    const tb = Date.parse(b.updatedAt || "") || 0;
    return tb - ta;
  });

  return items;
}

module.exports = {
  getDownloadDir,
  startDownload,
  getJob,
  listJobs,
  initDownloadDir,
  scanLibrary,
  listProgress,
  normalizeTitle,
  findMediaFile,
  findMediaFiles,
  deleteMedia,
  resolveMediaToken,
  probeMediaFile,
  streamFile,
  streamAudioTrackRemux,
  extractSubtitleTrack,
  getSubtitleVtt,
  prefetchAllSubtitles,
  saveProgress,
  getProgress,
};
