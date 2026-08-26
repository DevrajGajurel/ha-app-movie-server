const { execFile, spawn } = require("child_process");

// Samsung's own Tizen TV guidance only documents the native <video> element
// or their AVPlay API for video -- embedding a third-party site's own
// iframe player (YouTube's) isn't a supported pattern at all, and hits a
// "video player configuration error" that other Tizen developers have hit
// too, with no reliable fix (their referrer-policy checks don't play well
// with Tizen's WebKit). Resolving the trailer to a direct stream
// server-side and playing it through our own <video> sidesteps that
// entirely -- same pattern this app already uses for downloaded movies.
//
// Nothing here ever touches disk: yt-dlp only resolves direct CDN URLs for
// the chosen video/audio formats (-g), and ffmpeg reads both of those URLs
// straight over HTTPS and muxes them into a single stream piped directly
// to the HTTP response. avc1 (H.264) + m4a (AAC) are requested explicitly
// rather than letting yt-dlp pick "best" outright, since that can land on
// AV1/VP9/Opus, which isn't reliably hardware-decodable on Tizen's older
// TVs -- H.264/AAC is universally supported. Matroska output, not
// fragmented MP4: this app already hit Tizen's player rejecting fragmented
// MP4 outright for the audio-track remux case (see streamAudioTrackRemux
// in fileDownloads.js) even for a codec pair it plays fine otherwise;
// Matroska has no such requirement.
const YOUTUBE_KEY_RE = /^[A-Za-z0-9_-]{6,20}$/;
const FORMAT_SELECTOR = "bestvideo[height<=1080][vcodec^=avc1]+bestaudio[ext=m4a]/best[height<=1080]/best";

function isValidYoutubeKey(key) {
  return YOUTUBE_KEY_RE.test(String(key || ""));
}

function resolveStreamUrls(youtubeKey) {
  return new Promise((resolve, reject) => {
    execFile(
      "yt-dlp",
      ["-f", FORMAT_SELECTOR, "-g", `https://www.youtube.com/watch?v=${youtubeKey}`],
      { maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        const urls = stdout.trim().split("\n").filter(Boolean);
        if (!urls.length) {
          reject(new Error("yt-dlp returned no stream URLs"));
          return;
        }
        // A selector that resolved to an already-combined format (the
        // "best[height<=1080]/best" fallback tiers) prints one URL; the
        // preferred separate-streams tier prints two (video, then audio).
        resolve({ videoUrl: urls[0], audioUrl: urls[1] || urls[0] });
      }
    );
  });
}

async function streamYoutubeTrailer(req, res, youtubeKey) {
  if (!isValidYoutubeKey(youtubeKey)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid YouTube video key" }));
    return;
  }

  let videoUrl;
  let audioUrl;
  try {
    ({ videoUrl, audioUrl } = await resolveStreamUrls(youtubeKey));
  } catch (err) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Could not resolve trailer: ${err.message}` }));
    return;
  }

  const args =
    videoUrl === audioUrl
      ? ["-v", "error", "-i", videoUrl, "-c", "copy", "-f", "matroska", "pipe:1"]
      : [
          "-v", "error",
          "-i", videoUrl,
          "-i", audioUrl,
          "-map", "0:v:0",
          "-map", "1:a:0",
          "-c", "copy",
          "-f", "matroska",
          "pipe:1",
        ];
  const ffmpeg = spawn("ffmpeg", args);

  // Only commit to a 200 once ffmpeg has actually started (mirrors
  // streamAudioTrackRemux), so a missing binary or launch failure surfaces
  // as a real error instead of a 200 with an empty body.
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

// Startup-time sanity check (see main.js's boot log) - a missing yt-dlp
// binary otherwise only ever surfaces when a user actually clicks Trailer,
// as an opaque "Could not resolve trailer" with no clue why.
function checkYtDlpAvailable() {
  return new Promise((resolve) => {
    execFile("yt-dlp", ["--version"], { timeout: 5000 }, (err) => resolve(!err));
  });
}

module.exports = { isValidYoutubeKey, streamYoutubeTrailer, checkYtDlpAvailable };
