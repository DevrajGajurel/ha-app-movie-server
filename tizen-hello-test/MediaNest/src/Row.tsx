import { useEffect, useRef } from "react";
import type { Movie } from "./api";
import { PosterCard } from "./PosterCard";

interface RowProps {
  title: string;
  movies: Movie[];
  ranked?: boolean;
  badge?: string;
  progressFor?: (movie: Movie) => number | undefined;
  downloadedFor?: (movie: Movie) => boolean;
  focusedIndex: number | null;
  onSelect: (movie: Movie, index: number) => void;
}

export function Row({ title, movies, ranked, badge, progressFor, downloadedFor, focusedIndex, onSelect }: RowProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    if (focusedIndex == null) return;

    // Horizontal: scroll the TRACK only, manually - never the page. Using
    // scrollIntoView here (even with inline:"nearest") also drags in a
    // "nearest" vertical decision based on the focused CARD's own position,
    // which knows nothing about the row-title sitting above the track (a
    // sibling, not an ancestor, of the card) - that's what was leaving the
    // title clipped after scrolling back up, and what made switching rows
    // feel like it was "snapping to a column" instead of just moving.
    const track = trackRef.current;
    const item = itemRefs.current[focusedIndex];
    if (track && item) {
      // offsetLeft/offsetWidth, not getBoundingClientRect: those reflect
      // the item's plain LAYOUT position, untouched by the focus scale
      // transform and by the track's OWN current (possibly still-animating)
      // scroll position - getBoundingClientRect reports whatever is
      // currently on screen, so repeated key presses (a held remote button
      // auto-repeats faster than the smooth-scroll animation settles) kept
      // recalculating against a moving target and never quite converged
      // back to a true 0. .row-track has position:relative specifically so
      // offsetLeft is measured from IT, not from .rows further up.
      // FOCUS_OVERSCAN reserves room for the focused card's own scale-up
      // (1.08x, ~8px per side) - scrolling to exactly the item's edge
      // scrolls the track's own left padding out of view too (padding only
      // shows as breathing room while scrollLeft is still 0; past that it's
      // just more scrolled-away content), leaving nothing for the enlarged
      // focus border to render into and clipping it clean off - which is
      // exactly why the border vanished on the leftmost item after
      // scrolling right and back.
      const FOCUS_OVERSCAN = 20;
      const itemLeft = item.offsetLeft;
      const itemRight = itemLeft + item.offsetWidth;
      if (itemLeft - FOCUS_OVERSCAN < track.scrollLeft) {
        track.scrollTo({ left: Math.max(0, itemLeft - FOCUS_OVERSCAN), behavior: "smooth" });
      } else if (itemRight + FOCUS_OVERSCAN > track.scrollLeft + track.clientWidth) {
        track.scrollTo({ left: itemRight + FOCUS_OVERSCAN - track.clientWidth, behavior: "smooth" });
      }
    }

    // Vertical: scroll the WHOLE row (title + track) into view instead of
    // just the focused card, so the title is guaranteed visible too.
    rowRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  }, [focusedIndex]);

  if (!movies.length) return null;

  return (
    <div className="row" ref={rowRef}>
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
            downloaded={downloadedFor?.(movie)}
            focused={focusedIndex === i}
            onClick={() => onSelect(movie, i)}
          />
        ))}
      </div>
    </div>
  );
}
