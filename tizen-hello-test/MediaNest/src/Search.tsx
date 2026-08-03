import { useEffect, useRef, useState } from "react";
import type { Movie } from "./api";
import { Row } from "./Row";

interface SearchProps {
  movies: Movie[];
  onSelect: (movie: Movie) => void;
  progressFor?: (movie: Movie) => number | undefined;
  downloadedFor?: (movie: Movie) => boolean;
}

// Tizen brings up its own on-screen keyboard automatically when a real
// <input> receives focus - no custom virtual-keyboard UI needed, same
// approach HelloTV's search box already relies on.
export function Search({ movies, onSelect, progressFor, downloadedFor }: SearchProps) {
  const [query, setQuery] = useState("");
  const [focusedIndex, setFocusedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const normalized = query.trim().toLowerCase();
  const results = normalized
    ? movies.filter((m) => (m.tmdb?.tmdbTitle || m.title).toLowerCase().includes(normalized)).slice(0, 40)
    : [];

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (document.activeElement === inputRef.current) {
        if (e.keyCode === 40 && results.length) {
          e.preventDefault();
          setFocusedIndex(0);
          inputRef.current?.blur();
        }
        return;
      }
      if (!results.length) return;
      if (e.keyCode === 39) setFocusedIndex((i) => Math.min(results.length - 1, i + 1));
      else if (e.keyCode === 37) setFocusedIndex((i) => Math.max(0, i - 1));
      else if (e.keyCode === 38) inputRef.current?.focus();
      else if (e.keyCode === 13) onSelect(results[focusedIndex]);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [results, focusedIndex, onSelect]);

  return (
    <div className="rows" style={{ marginTop: 0, paddingTop: 48 }}>
      <input
        ref={inputRef}
        type="search"
        placeholder="Search titles…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={{
          width: 600,
          fontSize: 22,
          padding: "14px 20px",
          borderRadius: 8,
          border: "2px solid var(--muted)",
          background: "var(--bg-elevated)",
          color: "var(--text)",
          marginBottom: 30,
        }}
      />
      {normalized && !results.length ? <p className="status" style={{ paddingLeft: 0 }}>No matches for "{query}".</p> : null}
      {results.length ? (
        <Row
          title={`Results for "${query}"`}
          movies={results}
          focusedIndex={focusedIndex}
          progressFor={progressFor}
          downloadedFor={downloadedFor}
          onSelect={onSelect}
        />
      ) : null}
    </div>
  );
}
