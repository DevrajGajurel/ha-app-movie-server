const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const { execFile, spawn } = require("child_process");
const { createClient } = require("redis");
const { getCachedProbe, setCachedProbe } = require("./mediaProbeCache");

const MARKER_FILE = ".movieserver.json";
const PROGRESS_FILE = ".movieserver-progress.json";
const RESUME_MIN_SECONDS = 10;
const RESUME_DONE_RATIO = 0.95;
const jobs = [];
let jobId = 0;

// Job history is otherwise pure in-memory (jobs[] above) - a backend
// restart (every deploy, every HA add-on update) used to wipe the whole
// downloads history. This mirrors it into a Redis hash (jobId -> JSON job)
// so /api/downloads/jobs still has something to show right after a restart.
// Only queued/final-state snapshots are written, not every progress tick -
// an in-flight download's byte-by-byte progress isn't worth surviving a
// restart (the download itself doesn't survive one either).
const JOB_HISTORY_KEY = "movieserver:v1:jobhistory";
const JOB_HISTORY_MAX = 200;
let historyClient = null;

async function initJobHistory(redisUrl) {
  if (!redisUrl) return false;
  try {
    historyClient = createClient({ url: redisUrl });
    historyClient.on("error", (err) => console.warn("[job-history]", err.message));
    await historyClient.connect();

    const all = await historyClient.hGetAll(JOB_HISTORY_KEY);
    const loaded = Object.values(all)
      .map((raw) => {
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    // Anything still "queued"/"downloading" when the process died has no
    // real download behind it anymore - surface that instead of a job that
    // looks stuck forever.
    for (const job of loaded) {
      if (job.status === "queued" || job.status === "downloading") {
        job.status = "failed";
        job.error = "Interrupted by server restart";
        job.finishedAt = job.finishedAt || new Date().toISOString();
      }
    }

    loaded.sort((a, b) => (b.id || 0) - (a.id || 0));
    jobs.push(...loaded);
    if (jobs.length > JOB_HISTORY_MAX) jobs.length = JOB_HISTORY_MAX;
    jobId = loaded.reduce((max, job) => Math.max(max, job.id || 0), jobId);

    return true;
  } catch (err) {
    console.warn("[job-history] Redis unavailable:", err.message);
    historyClient = null;
    return false;
  }
}

function serializeJob(job) {
  const { _promise, ...rest } = job;
  return rest;
}

async function persistJob(job) {
  if (!historyClient?.isReady) return;
  try {
    await historyClient.hSet(JOB_HISTORY_KEY, String(job.id), JSON.stringify(serializeJob(job)));
  } catch (err) {
    console.warn(`[job-history] persist failed for job #${job.id}:`, err.message);
  }
}

async function pruneJobHistory() {
  if (!historyClient?.isReady) return;
  try {
    const all = await historyClient.hGetAll(JOB_HISTORY_KEY);
    const ids = Object.keys(all)
      .map(Number)
      .sort((a, b) => b - a);
    if (ids.length <= JOB_HISTORY_MAX) return;
    const stale = ids.slice(JOB_HISTORY_MAX).map(String);
    if (stale.length) await historyClient.hDel(JOB_HISTORY_KEY, stale);
  } catch {
    // best-effort - a missed prune just means a few extra hash entries
  }
}

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

function seasonFolderName(season) {
  return `S${String(season).padStart(2, "0")}`;
}

// TV downloads nest under a season subfolder (Series (tmdb-id)/S01/...) so a
// whole show lives in one folder tree instead of one folder per episode.
function ensureDir(movieTitle, tmdbId, season) {
  const base = path.resolve(getDownloadDir());
  let dir = movieTitle || tmdbId ? path.join(base, folderNameFor(movieTitle, tmdbId)) : base;
  if (Number.isInteger(season) && season > 0) {
    dir = path.join(dir, seasonFolderName(season));
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Whether this episode's season folder already has a file for it - checked
// before the season-batch downloader (and a season-type redownload) starts
// a new job for that episode, so re-running a season doesn't re-download
// every episode from scratch every time regardless of what's already on
// disk (confirmed the hard way: ~28GB of duplicate House of the Dragon S02
// episodes from repeated runs before this check existed). Matches on the
// "SxxEyy" tag every episode file carries (see withEpisodeTag below) -
// either our own prefix or one the source's own filename already had.
function hasEpisodeFile(movieTitle, tmdbId, season, episode) {
  const base = path.resolve(getDownloadDir());
  const dir = path.join(base, folderNameFor(movieTitle, tmdbId), seasonFolderName(season));
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return false;
  }
  const tag = `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
  return names.some((name) => {
    if (!VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase())) return false;
    return name.toUpperCase().includes(tag);
  });
}

// Depth-capped recursive file listing - covers both flat movie folders and
// Series (tmdb-id)/S01/ episode subfolders without treating arbitrary deep
// nesting as media.
function listFilesRecursive(dir, maxDepth = 6) {
  let results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (maxDepth > 0) results = results.concat(listFilesRecursive(full, maxDepth - 1));
      continue;
    }
    if (entry.isFile()) results.push(full);
  }
  return results;
}

// Tags a picked filename with its episode so files sharing a season folder
// never collide, even if the source gives two episodes the same generic name.
function withEpisodeTag(filename, season, episode) {
  if (!Number.isInteger(season) || !Number.isInteger(episode)) return filename;
  const tag = `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
  return filename.toUpperCase().includes(tag) ? filename : `${tag} - ${filename}`;
}

// Tags a season-pack filename with its "Part-01"/"Part-02"/... batch (see
// findPartLabel in main.js) so findSeasonPackFiles can tell the parts of a
// split season apart - the source's own filename doesn't reliably carry
// this, and without it every part would look like the same untagged pack.
// Also carries the batch's episode range (e.g. "Ep.01-06"), when the source
// listed one, so findSeasonPackFiles can later estimate where each episode
// starts within the part (proportionally by TMDB runtime - see
// estimateEpisodeOffsetSeconds on the frontend) without ever having to
// re-scrape the original listing.
function withPartTag(filename, part) {
  const partMatch = part ? /Part[-\s]?(\d+)/i.exec(part) : null;
  if (!partMatch) return filename;
  const partNum = partMatch[1].padStart(2, "0");
  const epMatch = /Ep\.?\s*(\d+)\s*-\s*(\d+)/i.exec(part);
  const epTag = epMatch ? ` EP${epMatch[1].padStart(2, "0")}-${epMatch[2].padStart(2, "0")}` : "";
  const tag = `PART-${partNum}${epTag}`;
  return filename.toUpperCase().includes(`PART-${partNum}`) ? filename : `${tag} - ${filename}`;
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

// A failed attempt (this candidate link, this retry) leaves whatever bytes
// it managed to write behind on disk - without this, every fallback
// candidate in the retry loop below piles up its own leftover partial file
// (uniquePath renames around existing files rather than overwriting them).
// Also removes aria2's `.aria2` resume-control sibling, if present.
function cleanupPartialFile(filePath) {
  if (!filePath) return;
  for (const target of [filePath, `${filePath}.aria2`]) {
    try {
      fs.rmSync(target, { force: true });
    } catch (err) {
      console.warn(`[download] could not remove partial file ${target}: ${err.message}`);
    }
  }
}

// Confirmed real bug: aria2c's segmented download (ARIA2_CONNECTIONS-way
// split) can exit 0 - and job.receivedBytes can match totalBytes - even
// though one of those segments left a gap of zero bytes in the middle of
// the file. A duration-only ffprobe (see probeMediaFile) never notices,
// since Matroska's duration lives in the header; only demuxing the actual
// packets surfaces it ("invalid as first byte of an EBML number").
//
// This was originally a full-file stream-copy-to-null pass, which reads
// every byte of a 15-20GB file a second time after the download itself -
// several extra minutes per file, on every download, every time. The
// corruption this catches showed up densely when it happened (confirmed on
// real affected files: dozens of instances spread every 200-800MB through
// the whole file), so a handful of short windows spread across the runtime
// catches the same class of corruption for a small fraction of the cost -
// this is a sampling check, not a guarantee every byte is intact.
const VERIFY_SAMPLE_COUNT = 6;
const VERIFY_SAMPLE_WINDOW_SECONDS = 15;
const CORRUPTION_SIGNATURE = /invalid as first byte of an EBML number/i;

function ffmpegWindowHasCorruption(filePath, startSeconds, windowSeconds) {
  return new Promise((resolve) => {
    let ffmpeg;
    try {
      ffmpeg = spawn("ffmpeg", [
        "-v",
        "error",
        "-ss",
        String(Math.max(0, Math.floor(startSeconds))),
        "-i",
        filePath,
        "-t",
        String(windowSeconds),
        "-map",
        "0",
        "-c",
        "copy",
        "-f",
        "null",
        "-",
      ]);
    } catch {
      resolve(false); // ffmpeg unavailable - can't verify, don't block the download over it
      return;
    }
    let stderr = "";
    ffmpeg.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    ffmpeg.on("error", () => resolve(false));
    ffmpeg.on("close", () => {
      resolve(CORRUPTION_SIGNATURE.test(stderr));
    });
  });
}

async function verifyDownloadedFile(filePath) {
  if (!VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return true;

  const probe = await probeMediaFile(filePath);
  const duration = probe?.durationSeconds;
  if (!duration || duration <= VERIFY_SAMPLE_WINDOW_SECONDS) {
    // Too short (or duration unknown) to usefully sample - fall back to a
    // single check of whatever's there.
    return !(await ffmpegWindowHasCorruption(filePath, 0, VERIFY_SAMPLE_WINDOW_SECONDS));
  }

  const offsets = Array.from(
    { length: VERIFY_SAMPLE_COUNT },
    (_, i) => (duration * (i + 1)) / (VERIFY_SAMPLE_COUNT + 1)
  );
  for (const offset of offsets) {
    if (await ffmpegWindowHasCorruption(filePath, offset, VERIFY_SAMPLE_WINDOW_SECONDS)) return false;
  }
  return true;
}

// Plain single-connection fetch + stream-to-disk — the original (and
// still default) download path.
async function downloadFileWithFetch(job, dir) {
  const controller = new AbortController();
  job._cancel = () => controller.abort();

  const response = await fetch(job.url, { redirect: "follow", signal: controller.signal });
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status}`);
  }

  const filename = withPartTag(
    withEpisodeTag(
      pickFilename(response.headers.get("content-disposition"), response.url, job.label),
      job.season,
      job.episode
    ),
    job.part
  );
  const filePath = uniquePath(dir, filename);

  job.totalBytes = Number(response.headers.get("content-length")) || 0;
  job.receivedBytes = 0;

  const fileStream = fs.createWriteStream(filePath);
  const body = Readable.fromWeb(response.body);

  body.on("data", (chunk) => {
    job.receivedBytes += chunk.length;
  });

  try {
    await pipeline(body, fileStream);
  } catch (err) {
    cleanupPartialFile(filePath);
    throw err;
  }
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
// Was 8 - confirmed via direct testing that these mirror links intermittently
// 403 a fraction of requests fired at the same signed URL (reproduced with
// plain concurrent curl, no aria2 involved), and a segmented download can't
// tolerate even one of its N connections failing - a single connection only
// needs one request to succeed instead of all N, and produces no scattered
// zero-byte gaps if a segment ever does come up short.
const ARIA2_CONNECTIONS = 1;

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
    const filePath = uniquePath(dir, withPartTag(withEpisodeTag(filename, job.season, job.episode), job.part));
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
      job._cancel = () => aria2.kill("SIGTERM");

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

      aria2.on("error", (err) => {
        cleanupPartialFile(filePath);
        reject(err);
      });
      aria2.on("close", (code) => {
        if (code === 0) {
          resolve(filePath);
        } else {
          cleanupPartialFile(filePath);
          reject(new Error(`aria2c exited ${code}: ${stderrTail}`));
        }
      });
    });
  });
}

function isAria2Enabled() {
  return String(process.env.USE_ARIA2 || "").toLowerCase() === "true";
}

function isAria2MissingError(err) {
  return Boolean(err && (err.code === "ENOENT" || /spawn aria2c ENOENT/i.test(String(err.message || ""))));
}

async function downloadFile(job, dir) {
  if (!isAria2Enabled()) {
    return downloadFileWithFetch(job, dir);
  }
  try {
    return await downloadFileWithAria2(job, dir);
  } catch (err) {
    if (!isAria2MissingError(err)) throw err;
    console.warn("[downloads] aria2c not found; falling back to single-connection fetch");
    return downloadFileWithFetch(job, dir);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Confirmed real bug: the 4khdhub/shegu mirror links are served through
// ephemeral Cloudflare Worker proxies that intermittently 403 a request for
// no discernible reason - reproduced directly with curl: the exact same
// signed URL, requested sequentially with no concurrency at all, returned
// 403 twice in a row and then 206 on the third try. aria2c treats HTTP 403
// as a permanent client error and gives up immediately (confirmed: neither
// --max-tries nor --retry-wait make it retry a 403), so without a retry of
// our own here, a plain warm-up hiccup on their end permanently fails the
// whole candidate instead of the couple of seconds' wait it actually needed.
const SAME_CANDIDATE_RETRIES = 3;
const SAME_CANDIDATE_RETRY_DELAY_MS = 3000;

async function runDownload(job) {
  job.status = "downloading";

  const candidates =
    Array.isArray(job.candidates) && job.candidates.length
      ? job.candidates
      : [{ url: job.url, label: job.label }];

  let lastError = null;

  outer: for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    job.url = candidate.url;
    job.label = candidate.label || job.label;
    job.attempt = i + 1;
    job.attemptsTotal = candidates.length;
    job.error = null;

    for (let retry = 0; retry < SAME_CANDIDATE_RETRIES; retry++) {
      try {
        const dir = ensureDir(job.movieTitle, job.tmdbId, job.season);
        const filePath = await downloadFile(job, dir);

        // Stays "downloading" through verification (rather than a new status
        // value) so the dashboard/MediaNest job lists - which only recognize
        // queued/downloading/completed/failed - keep showing it as active
        // instead of it vanishing from every tab for however long this takes.
        const verified = await verifyDownloadedFile(filePath);
        if (!verified) {
          cleanupPartialFile(filePath);
          throw new Error("Downloaded file failed integrity check (corrupted segment detected)");
        }

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

        console.log(
          `[download] saved job #${job.id} (candidate ${job.attempt}/${job.attemptsTotal}, try ${retry + 1}/${SAME_CANDIDATE_RETRIES}) -> ${filePath}`
        );

        try {
          const { refreshAfterDownload } = require("./emby");
          await refreshAfterDownload(filePath);
        } catch (err) {
          console.warn(`[download] Emby refresh failed: ${err.message}`);
        }

        prefetchSubtitlesForFile(filePath).catch((err) => {
          console.warn(`[subtitles] prefetch failed for ${filePath}: ${err.message}`);
        });
        persistJob(job);
        pruneJobHistory();
        return;
      } catch (err) {
        lastError = err;
        console.warn(
          `[download] job #${job.id} candidate ${i + 1}/${candidates.length} try ${retry + 1}/${SAME_CANDIDATE_RETRIES} failed (${candidate.label || candidate.url}): ${err.message}`
        );
        // A cancelled job shouldn't retry or fall through to the next
        // fallback link - the user asked for this to stop, not to keep
        // trying alternates.
        if (job._cancelled) break outer;
        if (retry < SAME_CANDIDATE_RETRIES - 1) await sleep(SAME_CANDIDATE_RETRY_DELAY_MS);
      }
    }
  }

  job.status = "failed";
  job.error = job._cancelled ? "Cancelled" : lastError?.message || "All download links failed";
  job.finishedAt = new Date().toISOString();
  console.error(`[download] failed job #${job.id}: ${job.error}`);
  persistJob(job);
  pruneJobHistory();
}

// Stops an in-flight job (regular or season) as cleanly as the download
// backend in use allows: aborts the fetch/kills the aria2c process, which
// throws/exits inside runDownload above and is treated as a normal (if
// immediate) failure - cleanupPartialFile already runs on that path, so no
// separate cleanup is needed here.
function cancelJob(id) {
  const job = jobs.find((item) => item.id === id);
  if (!job) return false;

  if (job.type === "season") {
    if (job.status !== "queued" && job.status !== "downloading") return false;
    job._cancelled = true;
    // activeEpisodeJobIds (not episodeJobIds) - the latter is only
    // populated once an episode's download finishes, too late to reach one
    // that's still in flight.
    for (const episodeId of job.activeEpisodeJobIds || []) {
      cancelJob(episodeId);
    }
    return true;
  }

  if (job.status !== "queued" && job.status !== "downloading") return false;
  job._cancelled = true;
  if (typeof job._cancel === "function") job._cancel();
  return true;
}

function startDownload({
  url,
  label,
  movieTitle,
  tmdbId,
  candidates = null,
  parentId = null,
  season = null,
  episode = null,
  part = null,
}) {
  const normalizedCandidates =
    Array.isArray(candidates) && candidates.length
      ? candidates
          .filter((c) => c?.url)
          .map((c) => ({ url: String(c.url), label: String(c.label || label || "Download") }))
      : null;

  const job = {
    id: ++jobId,
    url: normalizedCandidates?.[0]?.url || url,
    label: normalizedCandidates?.[0]?.label || label,
    candidates: normalizedCandidates,
    parentId: parentId || null,
    movieTitle: movieTitle || null,
    tmdbId: tmdbId ? String(tmdbId) : null,
    season: Number.isInteger(season) ? season : null,
    episode: Number.isInteger(episode) ? episode : null,
    part: part || null,
    status: "queued",
    receivedBytes: 0,
    totalBytes: 0,
    filePath: null,
    error: null,
    attempt: 0,
    attemptsTotal: normalizedCandidates?.length || 1,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };

  jobs.unshift(job);
  if (jobs.length > 200) jobs.length = 200;
  persistJob(job);

  console.log(`[download] queued job #${job.id} "${job.label}" -> ${getDownloadDir()}`);
  job._promise = runDownload(job).finally(() => {
    delete job._promise;
  });
  return job;
}

function waitForJob(job) {
  if (!job) return Promise.resolve();
  if (job._promise) return job._promise;
  if (job.status === "completed" || job.status === "failed") return Promise.resolve(job);
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (job.status === "completed" || job.status === "failed") {
        clearInterval(timer);
        resolve(job);
      }
    }, 500);
  });
}

const SEASON_DOWNLOAD_CONCURRENCY = 5;

function startSeasonJob({
  tmdbId,
  season,
  episodeCount,
  movieTitle,
  downloadEpisode,
}) {
  const seasonNum = Number.parseInt(season, 10);
  const episodes = Number.parseInt(episodeCount, 10);
  if (!tmdbId || !Number.isFinite(seasonNum) || seasonNum < 1) {
    throw new Error("tmdbId and season are required");
  }
  if (!Number.isFinite(episodes) || episodes < 1) {
    throw new Error("episodeCount must be >= 1");
  }
  if (typeof downloadEpisode !== "function") {
    throw new Error("downloadEpisode callback is required");
  }

  const job = {
    id: ++jobId,
    type: "season",
    url: null,
    label: `${movieTitle || "Series"} S${String(seasonNum).padStart(2, "0")} (full season)`,
    movieTitle: movieTitle || null,
    tmdbId: String(tmdbId),
    season: seasonNum,
    episodeCount: episodes,
    completedEpisodes: 0,
    failedEpisodes: 0,
    skippedEpisodes: 0,
    currentEpisode: null,
    episodeJobIds: [],
    // Populated as soon as each episode's own job is created (not just once
    // it finishes) so cancelJob() can actually reach an in-flight episode
    // download, not just ones that already completed.
    activeEpisodeJobIds: new Set(),
    status: "queued",
    receivedBytes: 0,
    totalBytes: 0,
    filePath: null,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };

  jobs.unshift(job);
  if (jobs.length > 200) jobs.length = 200;
  persistJob(job);

  console.log(
    `[download] queued season job #${job.id} "${job.label}" (${episodes} episode(s))`
  );

  job._promise = (async () => {
    job.status = "downloading";
    job.inFlightEpisodes = [];

    // Bounded worker pool: up to SEASON_DOWNLOAD_CONCURRENCY episodes in
    // flight at once, each worker picking up the next episode as soon as
    // its previous one finishes, instead of downloading strictly one at a
    // time. `nextEpisode` is only ever read+incremented synchronously
    // (no await between), so concurrent workers never grab the same episode.
    let nextEpisode = 1;

    async function worker() {
      while (true) {
        if (job._cancelled) return;
        const ep = nextEpisode;
        if (ep > episodes) return;
        nextEpisode += 1;

        job.currentEpisode = ep;
        job.inFlightEpisodes.push(ep);
        try {
          const episodeJob = await downloadEpisode({
            seasonJob: job,
            season: seasonNum,
            episode: ep,
          });
          if (episodeJob?.id) job.episodeJobIds.push(episodeJob.id);
          if (episodeJob?.status === "completed") {
            job.completedEpisodes += 1;
          } else if (episodeJob?.status === "skipped") {
            job.skippedEpisodes += 1;
          } else {
            job.failedEpisodes += 1;
          }
        } catch (err) {
          job.failedEpisodes += 1;
          console.warn(
            `[download] season job #${job.id} S${seasonNum}E${ep} failed: ${err.message}`
          );
        } finally {
          job.inFlightEpisodes = job.inFlightEpisodes.filter((n) => n !== ep);
        }
        // Surface aggregate progress for UI polling.
        job.receivedBytes = job.completedEpisodes + job.skippedEpisodes;
        job.totalBytes = episodes;
      }
    }

    const workerCount = Math.min(SEASON_DOWNLOAD_CONCURRENCY, episodes);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    job.currentEpisode = null;
    job.inFlightEpisodes = [];
    job.finishedAt = new Date().toISOString();
    if (job._cancelled) {
      job.status = "failed";
      job.error = "Cancelled";
    } else if (job.completedEpisodes + job.skippedEpisodes === 0) {
      job.status = "failed";
      job.error = "No episodes downloaded";
    } else if (job.failedEpisodes > 0) {
      job.status = "completed";
      job.error = `${job.failedEpisodes} episode(s) failed`;
    } else {
      job.status = "completed";
      job.error = null;
    }
    console.log(
      `[download] season job #${job.id} finished: ${job.completedEpisodes} ok, ${job.skippedEpisodes} skipped, ${job.failedEpisodes} failed`
    );
    persistJob(job);
    pruneJobHistory();
  })().finally(() => {
    delete job._promise;
  });

  return job;
}

function getJob(id) {
  const job = jobs.find((item) => item.id === id);
  if (!job) return null;
  const { _promise, ...rest } = job;
  return rest;
}

function listJobs() {
  return jobs.map(({ _promise, ...rest }) => rest);
}

function initDownloadDir() {
  const dir = path.resolve(getDownloadDir());
  fs.mkdirSync(dir, { recursive: true });
  console.log(`[download] folder ready: ${dir}`);
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
    for (const full of listFilesRecursive(dir)) {
      const filename = path.basename(full);
      if (filename === MARKER_FILE) continue;
      if (!VIDEO_EXTENSIONS.has(path.extname(filename).toLowerCase())) continue;
      let size;
      try {
        size = fs.statSync(full).size;
      } catch {
        continue;
      }
      // Token is the path relative to the download root; it round-trips
      // through the client so a specific file can be requested later
      // (see resolveMediaToken) without exposing the absolute disk path.
      const token = path.relative(base, full).split(path.sep).join("/");
      results.push({ path: full, token, filename, size });
    }
  }

  results.sort((a, b) => b.size - a.size);
  return results;
}

function findMediaFile({ tmdbId, title }) {
  const files = findMediaFiles({ tmdbId, title });
  return files.length ? files[0].path : null;
}

// A specific episode's file (if downloaded) rather than just "the largest
// file this series has anywhere" - findMediaFile alone is meaningless for a
// TV show once it has more than one episode on disk, since it has no idea
// which one the caller actually wants.
function findEpisodeFile({ tmdbId, title, season, episode }) {
  const tag = `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
  return findMediaFiles({ tmdbId, title }).find((f) => f.filename.toUpperCase().includes(tag)) || null;
}

// Which episode numbers of a season are already downloaded - one call for
// the whole season's episode grid (a "downloaded" badge per card) instead
// of a separate lookup per episode.
function findDownloadedEpisodeNumbers({ tmdbId, title, season }) {
  const seasonTag = `S${String(season).padStart(2, "0")}E`;
  const epRegex = new RegExp(`${seasonTag}(\\d{2})`, "i");
  const found = new Set();
  for (const f of findMediaFiles({ tmdbId, title })) {
    const m = epRegex.exec(f.filename.toUpperCase());
    if (m) found.add(Number.parseInt(m[1], 10));
  }
  return [...found];
}

// A file covering a whole season (or a "Part-01"/"Part-02"/... batch of one,
// when the source splits the season that way - see v1.7.23) rather than one
// episode - main-source TV downloads publish exactly this, so it has no
// SxxEyy tag at all. Distinguished from an episode file by that absence,
// scoped to this season's own folder so a same-named pack sitting in a
// different season isn't matched. Returns every matching file (there can be
// more than one when the season was downloaded as multiple parts), sorted
// by part number so a "Play Part-01/02/03" row lists them in order. Each
// entry also carries its actual duration (probed once, then cached - see
// probeMediaFile) plus the episode range tagged on it at download time
// (withPartTag), if any, so the frontend can estimate per-episode start
// offsets proportionally by TMDB runtime without decoding the file itself.
async function findSeasonPackFiles({ tmdbId, title, season }) {
  const seasonFolder = seasonFolderName(season);
  const episodeTagPattern = /S\d{2}E\d{2}/i;
  const partTagPattern = /PART-(\d+)/i;
  const epRangeTagPattern = /EP(\d+)-(\d+)/i;
  const files = findMediaFiles({ tmdbId, title }).filter((f) => {
    const segments = f.token.split("/");
    const parentDir = segments[segments.length - 2];
    if (parentDir !== seasonFolder) return false;
    return !episodeTagPattern.test(f.filename.toUpperCase());
  });

  const entries = await Promise.all(
    files.map(async (f) => {
      const upper = f.filename.toUpperCase();
      const partMatch = partTagPattern.exec(upper);
      const epMatch = epRangeTagPattern.exec(upper);
      const probe = await probeMediaFile(f.path);
      return {
        token: f.token,
        part: partMatch ? `Part-${partMatch[1].padStart(2, "0")}` : null,
        episodeFrom: epMatch ? Number.parseInt(epMatch[1], 10) : null,
        episodeTo: epMatch ? Number.parseInt(epMatch[2], 10) : null,
        durationSeconds: probe?.durationSeconds || null,
      };
    })
  );

  return entries.sort((a, b) => {
    const an = a.part ? Number.parseInt(a.part.slice(5), 10) : 0;
    const bn = b.part ? Number.parseInt(b.part.slice(5), 10) : 0;
    return an - bn;
  });
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
    // Which file this position applies to - a season folder can hold
    // several episodes sharing one progress file, so without this a
    // "resume" reader would have no way to tell which episode it's for.
    fileToken: fileToken || null,
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

// The single "where did I leave off" point for an entire TV series, across
// however many season folders it has - getProgress() alone only checks the
// top-level series folder, which is never where an episode's own progress
// file actually lives (see progressDirsFor: that's always the season
// subfolder containing the specific file that was played). Picks whichever
// season's progress was updated most recently.
function getSeriesResumePoint({ tmdbId, title }) {
  let best = null;
  for (const dir of findMatchingDirs({ tmdbId, title })) {
    const candidateDirs = [dir];
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && /^S\d+$/i.test(entry.name)) candidateDirs.push(path.join(dir, entry.name));
      }
    } catch {
      // dir unreadable - just check it directly, no season subfolders
    }

    for (const candidateDir of candidateDirs) {
      let data;
      try {
        data = JSON.parse(fs.readFileSync(path.join(candidateDir, PROGRESS_FILE), "utf8"));
      } catch {
        continue;
      }
      if (!(data.positionSeconds >= RESUME_MIN_SECONDS) || !data.fileToken) continue;
      // The file itself may have since been deleted/replaced (e.g. a
      // redownload, or cleaning up a duplicate) - a resume point pointing
      // at a file that's gone is worse than no resume point at all.
      if (!resolveMediaToken(data.fileToken)) continue;
      if (!best || new Date(data.updatedAt) > new Date(best.updatedAt)) best = data;
    }
  }
  return best;
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
          // 10-bit HEVC (Main 10 profile) is what both real crashes on this
          // TV had in common with each other, on top of the eac3 audio
          // issue already fixed - and the crash persisted even after that
          // fix, which points at the video stream itself. bits_per_raw_sample
          // is ffprobe's direct answer when present; pix_fmt (e.g.
          // "yuv420p10le") is the fallback for files where it isn't.
          const rawBitDepth = Number(videoStream?.bits_per_raw_sample);
          const pixFmtBitDepth = /10(le|be)$/i.test(videoStream?.pix_fmt || "")
            ? 10
            : /12(le|be)$/i.test(videoStream?.pix_fmt || "")
            ? 12
            : null;
          const videoBitDepth = Number.isFinite(rawBitDepth) && rawBitDepth > 0 ? rawBitDepth : pixFmtBitDepth;
          // ffprobe reports H.264 level as an integer (51 = Level 5.1, 41 =
          // Level 4.1, etc.) - see needsH264LevelFix for why this matters.
          const videoLevel = Number.isFinite(Number(videoStream?.level)) ? Number(videoStream.level) : null;

          resolve({
            durationSeconds: data.format?.duration ? Math.round(Number(data.format.duration)) : null,
            width: videoStream?.width || null,
            height: videoStream?.height || null,
            videoCodec: videoStream?.codec_name || null,
            videoProfile: videoStream?.profile || null,
            videoBitDepth,
            videoLevel,
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

    for (const full of listFilesRecursive(dir)) {
      if (!VIDEO_EXTENSIONS.has(path.extname(full).toLowerCase())) continue;
      await prefetchSubtitlesForFile(full);
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
// Browsers (Tizen's WebKit-based <video> element included) essentially
// never support Dolby Digital/Dolby Digital Plus/DTS/TrueHD audio in HTML5
// video, even on hardware whose native decoder chip fully supports them
// (which is exactly why Emby/Jellyfin's Tizen apps - built on the native
// AVPlay API instead of a web <video> element - can play the same file
// fine). Confirmed via ffprobe against a file that was crashing the TV:
// its default audio track is "eac3". Rather than trying to detect and
// recover from that failure after the fact, avoid ever handing the
// browser a codec it can't decode in the first place.
const BROWSER_INCOMPATIBLE_AUDIO_CODECS = new Set(["ac3", "eac3", "dts", "truehd", "mlp"]);

function needsAudioTranscode(codec) {
  return Boolean(codec) && BROWSER_INCOMPATIBLE_AUDIO_CODECS.has(String(codec).toLowerCase());
}

// H.264 Level 5.0+ is a spec tier meant for ~4K/very-high-bitrate content;
// legitimate HD (<=1088p) footage never actually needs it. Confirmed via
// ffprobe against a real file AVPlay refused to play at all
// (PLAYER_ERROR_NOT_SUPPORTED_FORMAT): plain 1920x1000 H.264/AAC, nothing
// exotic, but its SPS declares Level 5.1 - almost certainly a mistake from
// whatever tool produced the (low-quality "HQCam") release, since the
// actual bitrate/resolution don't remotely need it. AVPlay's hardware
// decoder checks the declared level against its own certified ceiling
// BEFORE attempting to decode and refuses the whole file if it looks too
// demanding, regardless of whether the real content would decode fine.
// Scoped to h264 only (HEVC's level field means something different) and
// to <=1088p (genuine 4K H.264, if it exists in the library, legitimately
// can need a high level - only implausible combinations get "fixed").
const MAX_PLAUSIBLE_HD_H264_LEVEL = 42; // Level 4.2
const REPAIRED_H264_LEVEL = "41"; // Level 4.1 - comfortably covers HD at any real bitrate
const MAX_HD_HEIGHT = 1088;

function needsH264LevelFix(probe) {
  return (
    probe?.videoCodec === "h264" &&
    Number(probe?.videoLevel) > MAX_PLAUSIBLE_HD_H264_LEVEL &&
    Number(probe?.height) > 0 &&
    Number(probe?.height) <= MAX_HD_HEIGHT
  );
}

function streamAudioTrackRemux(req, res, filePath, audioTrackIndex, { transcodeAudio = false, fixH264Level = false } = {}) {
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
    "-c:v",
    "copy",
    // Patches just the SPS level field in-place (no re-encode, no quality
    // loss, near-instant) - see needsH264LevelFix for why this is needed.
    ...(fixH264Level ? ["-bsf:v", `h264_metadata=level=${REPAIRED_H264_LEVEL}`] : []),
    "-c:a",
    transcodeAudio ? "aac" : "copy",
    ...(transcodeAudio ? ["-b:a", "256k"] : []),
    "-f",
    "matroska",
    "pipe:1",
  ]);

  // Only commit to a 200 once ffmpeg has actually started (Node's "spawn"
  // event) so a missing ffmpeg binary or other launch failure surfaces as a
  // real error response instead of a 200 with an empty body.
  ffmpeg.on("spawn", () => {
    res.writeHead(200, { "Content-Type": "video/x-matroska", "Cache-Control": "no-store" });
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
      "Cache-Control": "no-store",
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  const match = /bytes=(\d*)-(\d*)/.exec(range);
  const start = match[1] ? Number.parseInt(match[1], 10) : 0;
  let end = match[2] ? Number.parseInt(match[2], 10) : stat.size - 1;
  if (Number.isNaN(end) || end >= stat.size) end = stat.size - 1;

  // Same URL (tmdbId/title, no explicit file token) can end up pointing at
  // different bytes over time - a re-download, a newly-preferred larger
  // file, or (as of 1.4.49) a track that now gets transcoded when it
  // didn't before - so this must never be cached. Confirmed this was
  // exactly what made a server-side fix look like it "didn't work": the
  // TV kept replaying an old cached response for the same URL instead of
  // re-fetching after the backend was rebuilt.
  res.writeHead(206, {
    "Content-Range": `bytes ${start}-${end}/${stat.size}`,
    "Accept-Ranges": "bytes",
    "Content-Length": end - start + 1,
    "Content-Type": contentType,
    "Cache-Control": "no-store",
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
    // One recursive walk per folder (not two) - this used to call
    // hasMediaFiles(dir) and then walk again for downloadedAt below, which
    // doubled every folder's directory-tree traversal for no reason. On a
    // large, especially network-mounted, /media library that duplication
    // was the dominant cost of "Loading library from cache".
    const files = listFilesRecursive(dir);
    const hasMedia = files.some((full) => {
      const name = path.basename(full);
      return name !== MARKER_FILE && name !== PROGRESS_FILE;
    });
    if (!hasMedia) continue;

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

    // "Recently Downloaded" wants the actual video file's creation date, not
    // the marker's save timestamp or the folder's own mtime (the folder can
    // predate the file, e.g. re-downloading into an existing title folder) -
    // birthtime on whichever video file is newest in this folder is the most
    // direct signal of when this download actually landed on disk.
    let downloadedAt = null;
    for (const full of files) {
      if (!VIDEO_EXTENSIONS.has(path.extname(full).toLowerCase())) continue;
      try {
        const stat = fs.statSync(full);
        const created = stat.birthtime && stat.birthtime.getTime() > 0 ? stat.birthtime : stat.ctime;
        if (!downloadedAt || created > downloadedAt) downloadedAt = created;
      } catch {
        // skip unreadable file
      }
    }
    if (downloadedAt) {
      downloadedAt = downloadedAt.toISOString();
    } else {
      // No readable video file stat at all - folder mtime is the last resort.
      try {
        downloadedAt = fs.statSync(dir).mtime.toISOString();
      } catch {
        downloadedAt = null;
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

    // TMDB movie and TV ids aren't in the same namespace - the same numeric
    // id can (and does, confirmed: 94997) refer to a completely unrelated
    // movie and TV show. A season subfolder (S01, S02, ...) is the one
    // reliable, already-on-disk signal for which one a given download
    // actually is, since only the TV season downloader creates those.
    let seasonEntries;
    try {
      seasonEntries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      seasonEntries = [];
    }
    const type = seasonEntries.some((e) => e.isDirectory() && /^S\d+$/i.test(e.name)) ? "tv" : "movie";

    items.push({ folder: entry.name, tmdbId, title, downloadedAt, type });
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

  // seriesFolderName drives the tmdbId/title fallback parsing below - always
  // the top-level "Title (tmdb-id)" folder, even when the progress file
  // itself lives one level deeper in a season subfolder.
  function collect(seriesFolderName, dir) {
    const progressPath = path.join(dir, PROGRESS_FILE);
    if (!fs.existsSync(progressPath)) return;

    let data;
    try {
      data = JSON.parse(fs.readFileSync(progressPath, "utf8"));
    } catch {
      return;
    }

    const position = Number(data.positionSeconds) || 0;
    const duration = Number(data.durationSeconds) || 0;
    if (position < RESUME_MIN_SECONDS) return;
    if (duration > 0 && position / duration >= RESUME_DONE_RATIO) return;

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
      const match = /\(tmdb-(\d+)\)/i.exec(seriesFolderName);
      if (match) tmdbId = match[1];
    }
    if (!title) {
      title = seriesFolderName.replace(/\s*\(tmdb-\d+\)\s*/i, "").trim() || seriesFolderName;
    }

    const percent =
      duration > 0
        ? Math.min(99, Math.max(1, Math.round((position / duration) * 100)))
        : 0;

    // A progress file living one level deeper than the series folder is
    // always a season subfolder (only TV downloads create those) - same
    // signal scanLibrary() already uses to tell movies and TV apart, needed
    // here so a stub recovery lookup (when the title has rotated off the
    // scraped catalog - see progressItemToMovie in api.ts) can pass the
    // right type hint and avoid a movie/TV tmdbId collision.
    const type = path.basename(dir) !== seriesFolderName ? "tv" : "movie";

    items.push({
      folder: seriesFolderName,
      tmdbId,
      title,
      type,
      positionSeconds: position,
      durationSeconds: duration,
      percent,
      updatedAt: data.updatedAt || null,
    });
  }

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    collect(entry.name, dir);

    let subEntries;
    try {
      subEntries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      subEntries = [];
    }
    for (const sub of subEntries) {
      if (!sub.isDirectory()) continue;
      collect(entry.name, path.join(dir, sub.name));
    }
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
  hasEpisodeFile,
  startDownload,
  startSeasonJob,
  cancelJob,
  waitForJob,
  getJob,
  listJobs,
  initJobHistory,
  initDownloadDir,
  scanLibrary,
  listProgress,
  normalizeTitle,
  findMediaFile,
  findMediaFiles,
  findEpisodeFile,
  findDownloadedEpisodeNumbers,
  findSeasonPackFiles,
  deleteMedia,
  resolveMediaToken,
  probeMediaFile,
  streamFile,
  streamAudioTrackRemux,
  needsAudioTranscode,
  needsH264LevelFix,
  extractSubtitleTrack,
  getSubtitleVtt,
  prefetchAllSubtitles,
  saveProgress,
  getProgress,
  getSeriesResumePoint,
};
