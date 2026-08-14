import { useState } from "react";
import { Home } from "./Home";
import { Player } from "./Player";
import type { Movie } from "./api";

export function App() {
  const [playing, setPlaying] = useState<Movie | null>(null);

  if (playing) {
    return (
      <div className="app playing">
        <Player
          tmdbId={playing.tmdb?.tmdbId ? String(playing.tmdb.tmdbId) : null}
          title={playing.tmdb?.tmdbTitle || playing.title}
          onClose={() => setPlaying(null)}
        />
      </div>
    );
  }

  return (
    <div className="app">
      <Home onPlay={setPlaying} />
    </div>
  );
}
