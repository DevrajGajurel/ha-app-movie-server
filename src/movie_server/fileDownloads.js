const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");

const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || path.join(__dirname, "downloads");
const jobs = [];
let jobId = 0;

function sanitizeName(value) {
  return String(value || "download")
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function ensureDir(movieTitle) {
  const base = path.resolve(DOWNLOAD_DIR);
  const dir = movieTitle ? path.join(base, sanitizeName(movieTitle)) : base;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
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

    const dir = ensureDir(job.movieTitle);
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
  } catch (err) {
    job.status = "failed";
    job.error = err.message;
    job.finishedAt = new Date().toISOString();
  }
}

function startDownload({ url, label, movieTitle }) {
  const job = {
    id: ++jobId,
    url,
    label,
    movieTitle: movieTitle || null,
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
  fs.mkdirSync(path.resolve(DOWNLOAD_DIR), { recursive: true });
}

module.exports = {
  DOWNLOAD_DIR,
  startDownload,
  getJob,
  listJobs,
  initDownloadDir,
};
