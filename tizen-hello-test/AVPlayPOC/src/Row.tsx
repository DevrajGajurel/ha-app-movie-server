import { useEffect, useRef } from "react";
import type { Movie } from "./api";
import { PosterCard } from "./PosterCard";

interface RowProps {
  title: string;
  movies: Movie[];
  ranked?: boolean;
  badge?: string;
  progressFor?: (movie: Movie) => number | undefined;
  focusedIndex: number | null;
  onSelect: (movie: Movie, index: number) => void;
}

export function Row({ title, movies, ranked, badge, progressFor, focusedIndex, onSelect }: RowProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    if (focusedIndex == null) return;
    // "nearest", not "center": center forces every row to re-scroll and
    // snap to the focused column each time you move between rows, even
    // when that item is already fully visible - jarring when the whole
    // point of moving Up/Down is to stay on roughly the same column.
    // "nearest" only scrolls the minimum amount actually needed.
    itemRefs.current[focusedIndex]?.scrollIntoView({ behavior: "smooth", inline: "nearest", block: "nearest" });
  }, [focusedIndex]);

  if (!movies.length) return null;

  return (
    <div className="row">
      <div className="row-title">{title}</div>
      <div className={"row-track" + (ranked ? " ranked" : "")} ref={trackRef}>
        {movies.map((movie, i) => (
          <PosterCard
            key={movie.link}
            ref={(el) => {
              itemRefs.current[i] = el;
            }}
            movie={movie}
            rank={ranked ? i + 1 : undefined}
            badge={badge}
            progressPercent={progressFor?.(movie)}
            focused={focusedIndex === i}
            onClick={() => onSelect(movie, i)}
          />
        ))}
      </div>
    </div>
  );
}
