import { useState } from "react";
import { Home } from "./Home";
import { Player } from "./Player";
import { buildHlsProxyUrl, type Movie, type StreamMovie, type StreamQuality } from "./api";

type Playing =
  | { kind: "movie"; movie: Movie }
  | { kind: "stream"; item: StreamMovie; quality: StreamQuality };

export function App() {
  const [playing, setPlaying] = useState<Playing | null>(null);

  if (playing?.kind === "movie") {
    const movie = playing.movie;
    return (
      <div className="app">
        <Player
          tmdbId={movie.tmdb?.tmdbId ? String(movie.tmdb.tmdbId) : null}
          title={movie.tmdb?.tmdbTitle || movie.title}
          onClose={() => setPlaying(null)}
        />
      </div>
    );
  }

  if (playing?.kind === "stream") {
    const referer = playing.item.streams?.[0]?.referer || playing.item.referer;
    return (
      <div className="app">
        <Player
          title={`${playing.item.title}${playing.quality.label ? ` · ${playing.quality.label}` : ""}`}
          streamUrl={buildHlsProxyUrl(playing.quality.url, referer)}
          onClose={() => setPlaying(null)}
        />
      </div>
    );
  }

  return (
    <div className="app">
      <Home
        onPlay={(movie) => setPlaying({ kind: "movie", movie })}
        onPlayStream={(item, quality) => setPlaying({ kind: "stream", item, quality })}
      />
    </div>
  );
}
