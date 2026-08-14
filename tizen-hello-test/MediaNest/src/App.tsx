import { useState } from "react";
import { Home } from "./Home";
import { Player } from "./Player";
import type { Movie } from "./api";

interface PlayingState {
  movie: Movie;
  fileToken?: string;
}

export function App() {
  const [playing, setPlaying] = useState<PlayingState | null>(null);

  if (playing) {
    return (
      <div className="app playing">
        <Player
          tmdbId={playing.movie.tmdb?.tmdbId ? String(playing.movie.tmdb.tmdbId) : null}
          title={playing.movie.tmdb?.tmdbTitle || playing.movie.title}
          fileToken={playing.fileToken}
          onClose={() => setPlaying(null)}
        />
      </div>
    );
  }

  return (
    <div className="app">
      <Home onPlay={(movie, fileToken) => setPlaying({ movie, fileToken })} />
    </div>
  );
}
