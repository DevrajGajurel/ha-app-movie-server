const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const { execFile, spawn } = require("child_process");

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

async function runDownload(job) {
  job.status = "downloading";

  try {
    const response = await fetch(job.url, { redirect: "follow" });
    if (!response.ok) {
      throw new Error(`Download failed: ${response.status}`);
    }

    const dir = ensureDir(job.movieTitle, job.tmdbId);
    const filename = pickFilename(
      response.headers.get("content-disposition"),
      response.url,
      job.label
    );
    const filePath = uniquePath(dir, filename);
    const totalBytes = Number(response.headers.get("content-length")) || 0;

    job.filePath = filePath;
    job.totalBytes = totalBytes;
    job.receivedBytes = 0;

    const fileStream = fs.createWriteStream(filePath);
    const body = Readable.fromWeb(response.body);

    body.on("data", (chunk) => {
      job.receivedBytes += chunk.length;
    });

    await pipeline(body, fileStream);

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

function saveProgress({ tmdbId, title, fileToken, positionSeconds, durationSeconds }) {
  const dirs = progressDirsFor({ tmdbId, title, fileToken });
  if (!dirs.length) return false;

  // Treat "nearly finished" as complete: clear progress so the next play
  // starts from the beginning instead of resuming at 98%.
  const nearlyDone = durationSeconds > 0 && positionSeconds / durationSeconds > RESUME_DONE_RATIO;
  const payload = nearlyDone
    ? null
    : { positionSeconds, durationSeconds, updatedAt: new Date().toISOString() };

  for (const dir of dirs) {
    const file = path.join(dir, PROGRESS_FILE);
    try {
      if (payload) {
        fs.writeFileSync(file, JSON.stringify(payload));
      } else {
        fs.rmSync(file, { force: true });
      }
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
      if (data.positionSeconds >= RESUME_MIN_SECONDS) return data;
    } catch {
      // No progress file in this folder, or it's unreadable — keep looking.
    }
  }
  return null;
}

// Inspects a file's streams via ffprobe. Resolves to null (rather than
// throwing) when ffprobe isn't installed or the file can't be parsed, so
// callers can degrade to filename/size-only version info.
function probeMediaFile(filePath) {
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
          resolve({
            durationSeconds: data.format?.duration ? Math.round(Number(data.format.duration)) : null,
            width: videoStream?.width || null,
            height: videoStream?.height || null,
            audioTracks,
          });
        } catch {
          resolve(null);
        }
      }
    );
  });
}

// Streams a specific (non-default) embedded audio track by remuxing on the
// fly: video is stream-copied (no re-encode) and only the chosen audio
// track is included, muxed as fragmented MP4 so it can be piped without
// seeking the output. This is a live process, so unlike streamFile() above
// it can't honor Range requests / precise seeking.
function streamAudioTrackRemux(req, res, filePath, audioTrackIndex) {
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
    "-movflags",
    "frag_keyframe+empty_moov+default_base_moof",
    "-f",
    "mp4",
    "pipe:1",
  ]);

  // Only commit to a 200 once ffmpeg has actually started (Node's "spawn"
  // event) so a missing ffmpeg binary or other launch failure surfaces as a
  // real error response instead of a 200 with an empty body.
  ffmpeg.on("spawn", () => {
    res.writeHead(200, { "Content-Type": "video/mp4" });
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
  resolveMediaToken,
  probeMediaFile,
  streamFile,
  streamAudioTrackRemux,
  saveProgress,
  getProgress,
};
