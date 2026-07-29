const { spawn } = require("child_process");

// Samsung's own Tizen TV guidance only documents two supported video
// approaches: the native <video> element or their AVPlay API -- embedding a
// third-party site's own iframe player (YouTube's) isn't one of them, and
// in practice it hits a "video player configuration error" there that
// several other Tizen developers have hit too, with no reliable fix (their
// referrer-policy checks don't play well with Tizen's WebKit). Resolving
// the trailer to a direct stream server-side and playing it through our
// own <video> element sidesteps the whole problem -- same pattern this app
// already uses for downloaded movies.
const YOUTUBE_KEY_RE = /^[A-Za-z0-9_-]{6,20}$/;

// Prefers a format that already combines audio+video (YouTube's older
// "progressive" formats, e.g. itag 18) so nothing needs merging while
// piping to a single stdout stream -- falls back to whatever yt-dlp
// considers best if no such format exists for this particular video.
const FORMAT_SELECTOR =
  "best[ext=mp4][acodec!=none][vcodec!=none]/best[acodec!=none][vcodec!=none]/best";

function isValidYoutubeKey(key) {
  return YOUTUBE_KEY_RE.test(String(key || ""));
}

function streamYoutubeTrailer(req, res, youtubeKey) {
  if (!isValidYoutubeKey(youtubeKey)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid YouTube video key" }));
    return;
  }

  const videoUrl = `https://www.youtube.com/watch?v=${youtubeKey}`;
  const ytdlp = spawn("yt-dlp", ["-f", FORMAT_SELECTOR, "-o", "-", videoUrl]);

  // Only commit to a 200 once yt-dlp has actually started (mirrors
  // streamAudioTrackRemux in fileDownloads.js), so a missing binary or
  // other launch failure surfaces as a real error instead of a 200 with an
  // empty body.
  ytdlp.on("spawn", () => {
    res.writeHead(200, { "Content-Type": "video/mp4" });
    ytdlp.stdout.pipe(res);
  });

  ytdlp.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end();
    }
  });

  let stderrTail = "";
  ytdlp.stderr.on("data", (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000);
  });

  ytdlp.on("close", (code) => {
    if (code !== 0 && !res.headersSent) {
      console.warn(`[trailer] yt-dlp exited ${code} for ${youtubeKey}: ${stderrTail}`);
      res.writeHead(502);
      res.end();
    }
  });

  const cleanup = () => {
    if (!ytdlp.killed) ytdlp.kill("SIGKILL");
  };
  req.on("close", cleanup);
  res.on("close", cleanup);
}

module.exports = { streamYoutubeTrailer };
