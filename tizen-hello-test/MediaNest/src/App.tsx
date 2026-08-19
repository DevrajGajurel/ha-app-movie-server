import { useState } from "react";
import { Home } from "./Home";
import { Player } from "./Player";
import type { Movie } from "./api";

interface PlayingState {
  movie: Movie;
  fileToken?: string;
  startAtSeconds?: number;
}

export function App() {
  const [playing, setPlaying] = useState<PlayingState | null>(null);

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
