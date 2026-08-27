import { useEffect, useRef, useState } from "react";
import type { Movie } from "./api";
import { getTmdbSuggestions, type TmdbSuggestion } from "./api";
import { Row } from "./Row";

interface SearchProps {
  movies: Movie[];
  active: boolean;
  onSelect: (movie: Movie) => void;
  progressFor?: (movie: Movie) => number | undefined;
  downloadedFor?: (movie: Movie) => boolean;
}

const SUGGEST_MIN_LENGTH = 2;
const SUGGEST_DEBOUNCE_MS = 300;

type FocusRegion = "input" | "suggestions" | "results";

// Tizen brings up its own on-screen keyboard automatically when a real
// <input> receives focus - no custom virtual-keyboard UI needed, same
// approach HelloTV's search box already relies on.
export function Search({ movies, active, onSelect, progressFor, downloadedFor }: SearchProps) {
  const [query, setQuery] = useState("");
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [focusRegion, setFocusRegion] = useState<FocusRegion>("input");
  // Live TMDB suggestions as the user types - same /api/tmdb/suggest
  // endpoint the dashboard's search box already uses, so a query that
  // doesn't exactly match the scraped catalog's own title formatting (a
  // misspelling, different punctuation) can still be corrected against a
  // real title instead of only ever showing "No matches". Selecting a
  // suggestion fills in its title rather than jumping straight to a
  // TMDB-only result - a title only found via TMDB has no scraped source
  // page to download from, so there's nothing to open yet.
  const [suggestions, setSuggestions] = useState<TmdbSuggestion[]>([]);
  const [suggestFocusIndex, setSuggestFocusIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<number | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const normalized = query.trim().toLowerCase();
  const results = normalized
    ? movies.filter((m) => (m.tmdb?.tmdbTitle || m.title).toLowerCase().includes(normalized)).slice(0, 40)
    : [];

  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    const q = query.trim();
    if (q.length < SUGGEST_MIN_LENGTH) {
      setSuggestions([]);
      return;
    }
    debounceRef.current = window.setTimeout(() => {
      getTmdbSuggestions(q).then((results) => {
        setSuggestions(results);
        setSuggestFocusIndex(0);
      });
    }, SUGGEST_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [query]);

  function selectSuggestion(s: TmdbSuggestion) {
    setQuery(s.title);
    setSuggestions([]);
    setFocusRegion("input");
    inputRef.current?.focus();
  }

  useEffect(() => {
    if (!active) return;
    function onKeyDown(e: KeyboardEvent) {
      if (focusRegion === "input") {
        if (e.keyCode === 40) {
          if (suggestions.length) {
            e.preventDefault();
            setFocusRegion("suggestions");
            setSuggestFocusIndex(0);
            inputRef.current?.blur();
          } else if (results.length) {
            e.preventDefault();
            setFocusRegion("results");
            setFocusedIndex(0);
            inputRef.current?.blur();
          }
        }
        return;
      }

      if (focusRegion === "suggestions") {
        if (e.keyCode === 38) {
          if (suggestFocusIndex === 0) {
            setFocusRegion("input");
            inputRef.current?.focus();
          } else {
            setSuggestFocusIndex((i) => Math.max(0, i - 1));
          }
        } else if (e.keyCode === 40) {
          setSuggestFocusIndex((i) => Math.min(suggestions.length - 1, i + 1));
        } else if (e.keyCode === 13) {
          selectSuggestion(suggestions[suggestFocusIndex]);
        } else if (e.keyCode === 10009 || e.keyCode === 27) {
          setFocusRegion("input");
          inputRef.current?.focus();
        }
        return;
      }

      // focusRegion === "results"
      if (!results.length) return;
      if (e.keyCode === 39) setFocusedIndex((i) => Math.min(results.length - 1, i + 1));
      else if (e.keyCode === 37) setFocusedIndex((i) => Math.max(0, i - 1));
      else if (e.keyCode === 38) {
        setFocusRegion("input");
        inputRef.current?.focus();
      } else if (e.keyCode === 13) onSelect(results[focusedIndex]);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active, results, focusedIndex, onSelect, suggestions, suggestFocusIndex, focusRegion]);

  return (
    <div className="rows" style={{ marginTop: 0, paddingTop: 48 }}>
      <input
        ref={inputRef}
        type="search"
        placeholder="Search titles…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => setFocusRegion("input")}
        style={{
          width: 600,
          fontSize: 22,
          padding: "14px 20px",
          borderRadius: 8,
          border: "2px solid var(--muted)",
          background: "var(--bg-elevated)",
          color: "var(--text)",
          marginBottom: suggestions.length ? 0 : 30,
        }}
      />
      {suggestions.length > 0 && (
        <div className="search-suggestions">
          {suggestions.map((s, i) => (
            <div
              key={s.tmdbId}
              className={"search-suggestion" + (focusRegion === "suggestions" && i === suggestFocusIndex ? " focused" : "")}
              onClick={() => selectSuggestion(s)}
            >
              {s.poster ? (
                <img src={s.poster} alt="" className="search-suggestion-poster" />
              ) : (
                <div className="search-suggestion-poster" />
              )}
              <div className="search-suggestion-info">
                <div className="search-suggestion-title">{s.title}</div>
                <div className="search-suggestion-meta">{s.year || ""}</div>
              </div>
              <span className="search-suggestion-type">{s.type === "tv" ? "TV" : "Movie"}</span>
            </div>
          ))}
        </div>
      )}
      {normalized && !results.length ? <p className="status" style={{ paddingLeft: 0 }}>No matches for "{query}".</p> : null}
      {results.length ? (
        <Row
          title={`Results for "${query}"`}
          movies={results}
          focusedIndex={focusRegion === "results" ? focusedIndex : null}
          progressFor={progressFor}
          downloadedFor={downloadedFor}
          onSelect={onSelect}
        />
      ) : null}
    </div>
  );
}
