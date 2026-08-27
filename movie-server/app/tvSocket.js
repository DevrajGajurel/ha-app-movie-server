const { WebSocketServer } = require("ws");

// MediaNest runs inside the TV's own browser, which can't speak Redis's
// protocol directly - there's no way for it to subscribe to a Redis
// channel itself. A single persistent WebSocket connection is the
// browser-compatible equivalent: MediaNest opens it once on startup and
// just listens, instead of repeatedly polling an HTTP endpoint (which
// would mean the TV app doing real work on a timer even while idle). The
// backend is a single process, so there's no need for Redis to broker this
// server-side either - an in-memory Set of open sockets plays the same
// "publish once, every subscriber reacts instantly" role with less moving
// parts.
//
// A request nobody's connected to pick up yet (e.g. the TV is still on its
// way to foreground after samsungTv.js's launch call) is held here and
// delivered the moment a socket connects - not lost just because nothing
// was listening at the exact instant it was requested.
const PENDING_TTL_MS = 2 * 60 * 1000;

const sockets = new Set();
let pending = null; // { payload, expiresAt }

function broadcast(payload) {
  const message = JSON.stringify({ type: "play", ...payload });
  for (const ws of sockets) {
    if (ws.readyState === ws.OPEN) ws.send(message);
  }
}

// Called from POST /api/tv/play - stores the request and pushes it to any
// already-connected socket immediately.
function notifyPendingPlay(payload) {
  pending = { payload, expiresAt: Date.now() + PENDING_TTL_MS };
  broadcast(payload);
}

function attachTvSocket(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: "/api/tv/socket" });

  wss.on("connection", (ws) => {
    sockets.add(ws);
    console.log(`[tv-socket] MediaNest connected (${sockets.size} active)`);

    if (pending && pending.expiresAt > Date.now()) {
      ws.send(JSON.stringify({ type: "play", ...pending.payload }));
    }

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      // MediaNest acks once playback has actually started, clearing the
      // pending slot so a stale request never gets replayed to a later,
      // unrelated reconnect (the TV app restarting hours afterward).
      if (msg.type === "ack") pending = null;
    });

    ws.on("close", () => {
      sockets.delete(ws);
      console.log(`[tv-socket] MediaNest disconnected (${sockets.size} active)`);
    });

    ws.on("error", (err) => {
      console.warn("[tv-socket] socket error:", err.message);
    });
  });

  return { notifyPendingPlay };
}

module.exports = { attachTvSocket };
