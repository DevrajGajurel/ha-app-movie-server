import { useEffect, useState } from "react";
import { Home } from "./Home";
import { Player } from "./Player";
import { getTvSocketUrl, type Movie } from "./api";

interface PlayingState {
  movie: Movie;
  fileToken?: string;
  startAtSeconds?: number;
}

// The dashboard's "Play on TV" action arrives here, not through the
// scraped catalog - there's no matching Movie entry to look up, just
// whatever tmdbId/title the backend was given. Player only ever reads
// tmdb.tmdbId and tmdb.tmdbTitle-or-title, so a minimal stub (no poster/
// backdrop/genres - Player doesn't render any of those) is enough to
// start playback the same way any other Play action does.
interface RemotePlayMessage {
  type: "play";
  fileToken: string;
  title: string;
  tmdbId: string | null;
  season: number | null;
  episode: number | null;
}

function remotePlayToMovie(msg: RemotePlayMessage): Movie {
  const tmdbId = msg.tmdbId ? Number(msg.tmdbId) : null;
  return {
    title: msg.title,
    link: `tv-remote:${msg.tmdbId || msg.title}`,
    tmdb: tmdbId
      ? {
          tmdbId,
          tmdbTitle: msg.title,
          type: "movie",
          poster: null,
          backdrop: null,
          rating: null,
          year: null,
          genres: [],
          overview: null,
          tagline: null,
          runtimeMinutes: null,
          certification: null,
          director: null,
          trailerKey: null,
        }
      : undefined,
  };
}

// Reconnects with a capped exponential backoff instead of a fixed interval -
// a network blip should retry almost immediately, but a backend that's
// genuinely down shouldn't be hammered with a reconnect attempt every
// second for however long it stays down.
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

export function App() {
  const [playing, setPlaying] = useState<PlayingState | null>(null);

  // One persistent WebSocket to the backend's "Play on TV" push channel -
  // see tvSocket.js. Deliberately not polling: this connection just sits
  // open while MediaNest is otherwise idle, and the backend pushes the
  // instant a play request comes in instead of MediaNest needing to ask
  // repeatedly. An explicit remote command always takes over whatever's
  // currently playing (or not), matching how a physical remote's own Play
  // button would behave.
  useEffect(() => {
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let reconnectAttempt = 0;
    let stopped = false;

    function connect() {
      if (stopped) return;
      socket = new WebSocket(getTvSocketUrl());

      socket.onopen = () => {
        reconnectAttempt = 0;
      };

      socket.onmessage = (event) => {
        let msg: RemotePlayMessage | { type: string };
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        if (msg.type !== "play") return;
        const playMsg = msg as RemotePlayMessage;
        setPlaying({
          movie: remotePlayToMovie(playMsg),
          fileToken: playMsg.fileToken || undefined,
        });
        socket?.send(JSON.stringify({ type: "ack" }));
      };

      socket.onclose = () => {
        if (stopped) return;
        const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS);
        reconnectAttempt += 1;
        reconnectTimer = window.setTimeout(connect, delay);
      };

      socket.onerror = () => {
        socket?.close();
      };
    }

    connect();

    return () => {
      stopped = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, []);

  // Home stays mounted (just hidden) instead of being replaced by Player -
  // it previously unmounted entirely while playing, so Back from the
  // player always landed on a freshly-reset Home (browse view, scrolled to
  // the top) instead of wherever the user actually was (a Detail page, the
  // Library/Downloads view, a scrolled-down row) before pressing Play.
  return (
    <div className={"app" + (playing ? " playing" : "")}>
      <div style={playing ? { display: "none" } : undefined}>
        <Home
          onPlay={(movie, fileToken, startAtSeconds) => setPlaying({ movie, fileToken, startAtSeconds })}
          suspended={!!playing}
        />
      </div>
      {playing && (
        <Player
          tmdbId={playing.movie.tmdb?.tmdbId ? String(playing.movie.tmdb.tmdbId) : null}
          title={playing.movie.tmdb?.tmdbTitle || playing.movie.title}
          fileToken={playing.fileToken}
          startAtSeconds={playing.startAtSeconds}
          onClose={() => setPlaying(null)}
        />
      )}
    </div>
  );
}
