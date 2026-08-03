import { useState } from "react";
import { Home } from "./Home";
import { Player } from "./Player";
import { buildM3u8PlayUrl, type Movie, type M3u8Playlist } from "./api";

type Playing =
  | { kind: "movie"; movie: Movie }
  | { kind: "stream"; item: M3u8Playlist };

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
    return (
      <div className="app">
        <Player
          title={playing.item.name}
          streamUrl={buildM3u8PlayUrl(playing.item.token)}
          onClose={() => setPlaying(null)}
        />
      </div>
    );
  }

  return (
    <div className="app">
      <Home
        onPlay={(movie) => setPlaying({ kind: "movie", movie })}
        onPlayStream={(item) => setPlaying({ kind: "stream", item })}
      />
    </div>
  );
}
