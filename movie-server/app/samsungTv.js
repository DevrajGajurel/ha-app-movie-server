const WebSocket = require("ws");
const { createClient } = require("redis");

// Best-effort remote launch, NOT the reliable delivery path - that's
// tvSocket.js's WebSocket push straight to MediaNest, which works whether
// or not this succeeds. This only exists to bring MediaNest to the
// foreground when the TV is idle or on a different app; if the TV is
// already sitting on MediaNest, this is redundant (and if it fails, the
// push has already been sent regardless - see main.js's /api/tv/play).
//
// Two mechanisms, tried in order:
// 1. Samsung's plain REST app-launch endpoint (POST /api/v2/applications/
//    <appId>, no auth, no pairing) - confirmed live against the real TV
//    that this alone reliably brings MediaNest to the foreground. Tried
//    first since it's far simpler and has none of the WebSocket flow's
//    failure modes.
// 2. The WebSocket remote-control protocol (the same one Smart View/
//    SmartThings use, undocumented by Samsung but stable and well-covered
//    by community reference implementations - xchwarze/samsung-tv-ws-api,
//    Toxblh/samsung-tv-control) as a fallback, kept in case a different
//    TV/firmware combination doesn't accept the plain REST call the way
//    this one does. First connection to a given TV shows an on-screen
//    "Allow [app] to connect?" prompt; once approved, the TV hands back a
//    token reused on every future connection so the prompt never
//    reappears. Passing a `metaTag` on launch (the ed.apps.launch event)
//    is NOT reliably delivered to the app across firmware versions per
//    community reports - treated here purely as a bonus, never depended
//    on for actually starting playback.
const CACHE_PREFIX = "movieserver:v1:samsungtv:token";
const APP_NAME = "MovieServer";
const MEDIANEST_APP_ID = "avplaypoc1.AVPlayPOC";
// Generous specifically because the very first call requires a human to
// notice an on-screen prompt and approve it with the remote - confirmed
// too tight at 15s in real testing (the approval itself was fine, it just
// didn't happen inside the window). Every call after that first approval
// reuses the stored token and gets ms.channel.connect back almost
// immediately, so this long a ceiling only ever actually gets hit once.
const CONNECT_TIMEOUT_MS = 60000;

let redisClient = null;

async function initSamsungTv(redisUrl) {
  if (!redisUrl) return false;
  try {
    redisClient = createClient({ url: redisUrl });
    redisClient.on("error", (err) => console.warn("[samsung-tv]", err.message));
    await redisClient.connect();
    return true;
  } catch (err) {
    console.warn("[samsung-tv] Redis unavailable, pairing token won't survive a restart:", err.message);
    redisClient = null;
    return false;
  }
}

async function getStoredToken() {
  if (!redisClient?.isReady) return null;
  try {
    return await redisClient.get(CACHE_PREFIX);
  } catch {
    return null;
  }
}

async function storeToken(token) {
  if (!redisClient?.isReady || !token) return;
  try {
    await redisClient.set(CACHE_PREFIX, token);
  } catch (err) {
    console.warn("[samsung-tv] failed to persist pairing token:", err.message);
  }
}

// Resolves once connected+authorized (token confirmed or freshly issued),
// rejects on timeout/error. The on-screen "Allow?" prompt only appears the
// very first time a given token is unknown to the TV - every call after
// that approval is silent.
function connect(tvIp, token) {
  return new Promise((resolve, reject) => {
    const name = Buffer.from(APP_NAME).toString("base64");
    const url = `wss://${tvIp}:8002/api/v2/channels/samsung.remote.control?name=${name}${
      token ? `&token=${token}` : ""
    }`;
    const ws = new WebSocket(url, { rejectUnauthorized: false });

    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`timed out waiting for TV authorization after ${CONNECT_TIMEOUT_MS}ms - check for an "Allow connection?" prompt on the TV`));
    }, CONNECT_TIMEOUT_MS);

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.event === "ms.channel.connect") {
        clearTimeout(timer);
        if (msg.data?.token) storeToken(msg.data.token);
        resolve(ws);
      } else if (msg.event === "ms.channel.unauthorized" || msg.event === "ms.channel.timeOut") {
        clearTimeout(timer);
        ws.terminate();
        reject(new Error(`TV rejected the connection (${msg.event})`));
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

const REST_LAUNCH_TIMEOUT_MS = 8000;

// Plain, undocumented-but-standard Samsung REST launch - no pairing, no
// token, no on-screen prompt. Confirmed live: POSTing here brings an
// already-installed app to the foreground even when the TV was on
// something else. Throws on any failure; the caller decides what to do
// next (fall back to the WebSocket path).
async function launchViaRest(tvIp) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REST_LAUNCH_TIMEOUT_MS);
  try {
    const res = await fetch(`http://${tvIp}:8001/api/v2/applications/${MEDIANEST_APP_ID}`, {
      method: "POST",
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } finally {
    clearTimeout(timer);
  }
}

// metaTag: best-effort hint only (see file header) - pass the file token so
// MediaNest *could* pick it up directly if a given firmware happens to
// deliver it, but never rely on this alone.
async function launchMediaNest(tvIp, metaTag) {
  if (!tvIp) {
    console.warn("[samsung-tv] launch skipped: no tv_ip configured");
    return false;
  }

  try {
    await launchViaRest(tvIp);
    console.log(`[samsung-tv] launched via REST: ${tvIp}`);
    return true;
  } catch (err) {
    console.warn(`[samsung-tv] REST launch failed (${err.message}), falling back to WebSocket remote-control`);
  }

  let ws;
  try {
    const token = await getStoredToken();
    ws = await connect(tvIp, token);
    ws.send(
      JSON.stringify({
        method: "ms.channel.emit",
        params: {
          event: "ed.apps.launch",
          to: "host",
          data: { action_type: "DEEP_LINK", appId: MEDIANEST_APP_ID, metaTag: metaTag || "" },
        },
      })
    );
    console.log(`[samsung-tv] launched via WebSocket: ${tvIp}`);
    setTimeout(() => ws.close(), 1000);
    return true;
  } catch (err) {
    console.warn(`[samsung-tv] WebSocket launch also failed: ${err.message}`);
    try {
      ws?.terminate();
    } catch {
      // already closed
    }
    return false;
  }
}

module.exports = { initSamsungTv, launchMediaNest };
