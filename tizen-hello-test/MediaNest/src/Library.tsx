import { useEffect, useRef, useState } from "react";
import type { Movie } from "./api";
import { PosterCard } from "./PosterCard";

const COLS = 7;

interface LibraryProps {
  movies: Movie[];
  active: boolean;
  onSelect: (movie: Movie) => void;
  onPlay: (movie: Movie) => void;
  onLeaveToSidebar: () => void;
  progressFor?: (movie: Movie) => number | undefined;
}

export function Library({ movies, active, onSelect, onPlay, onLeaveToSidebar, progressFor }: LibraryProps) {
  const [index, setIndex] = useState(0);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    setIndex((i) => (movies.length ? Math.min(i, movies.length - 1) : 0));
  }, [movies.length]);

  useEffect(() => {
    if (!active || !movies.length) return;
    itemRefs.current[index]?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  }, [index, active, movies.length]);

  useEffect(() => {
    if (!active) return;
    function onKeyDown(e: KeyboardEvent) {
      if (!movies.length) {
        if (e.keyCode === 37) onLeaveToSidebar();
        return;
      }
      const col = index % COLS;
      const row = Math.floor(index / COLS);
      const lastRow = Math.floor((movies.length - 1) / COLS);

      switch (e.keyCode) {
        case 37: // Left
          if (col === 0) onLeaveToSidebar();
          else setIndex((i) => Math.max(0, i - 1));
          break;
        case 39: // Right
          setIndex((i) => Math.min(movies.length - 1, i + 1));
          break;
        case 38: // Up
          if (row > 0) setIndex((i) => Math.max(0, i - COLS));
          break;
        case 40: // Down
          if (row < lastRow) setIndex((i) => Math.min(movies.length - 1, i + COLS));
          break;
        case 13: // Enter — detail (Play / Delete)
          onSelect(movies[index]);
          break;
        case 415: // MediaPlay
        case 19:
        case 10252:
          onPlay(movies[index]);
          break;
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active, movies, index, onSelect, onPlay, onLeaveToSidebar]);

  return (
    <div className="library-view">
      <h1 className="hero-title" style={{ fontSize: 32, marginBottom: 8 }}>
        Library
      </h1>
      <p className="library-hint">{movies.length ? `${movies.length} downloaded titles` : "No downloaded movies yet."}</p>
      {movies.length ? (
        <div className="library-grid">
          {movies.map((movie, i) => (
            <PosterCard
              key={movie.link}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              movie={movie}
              focused={active && i === index}
              downloaded
              progressPercent={progressFor?.(movie)}
              onClick={() => onSelect(movie)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
