const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");

const MARKER_FILE = ".movieserver.json";
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
      if (name === MARKER_FILE) return false;
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

function findMediaFile({ tmdbId, title }) {
  const base = path.resolve(getDownloadDir());
  const normTitle = title ? normalizeTitle(title) : null;

  let entries;
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return null;
  }

  let best = null;

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

    let files;
    try {
      files = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    // Keep scanning every matching folder (e.g. separate HD/4K downloads of
    // the same movie) instead of stopping at the first one, so the largest
    // file across ALL of them wins, not just the largest in whichever
    // folder happens to be listed first.
    for (const file of files) {
      if (!file.isFile() || file.name === MARKER_FILE) continue;
      if (!VIDEO_EXTENSIONS.has(path.extname(file.name).toLowerCase())) continue;
      const full = path.join(dir, file.name);
      const size = fs.statSync(full).size;
      if (!best || size > best.size) best = { path: full, size };
    }
  }

  return best ? best.path : null;
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

module.exports = {
  getDownloadDir,
  startDownload,
  getJob,
  listJobs,
  initDownloadDir,
  scanLibrary,
  normalizeTitle,
  findMediaFile,
  streamFile,
};
