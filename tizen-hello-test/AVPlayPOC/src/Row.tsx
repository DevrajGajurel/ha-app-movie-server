import { useEffect, useRef } from "react";
import type { Movie } from "./api";
import { PosterCard } from "./PosterCard";

interface RowProps {
  title: string;
  movies: Movie[];
  ranked?: boolean;
  badge?: string;
  focusedIndex: number | null;
  onSelect: (movie: Movie, index: number) => void;
}

export function Row({ title, movies, ranked, badge, focusedIndex, onSelect }: RowProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    if (focusedIndex == null) return;
    itemRefs.current[focusedIndex]?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
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
            focused={focusedIndex === i}
            onClick={() => onSelect(movie, i)}
          />
        ))}
      </div>
    </div>
  );
}
