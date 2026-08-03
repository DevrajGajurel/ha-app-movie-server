import { useEffect, useMemo, useState } from "react";
import {
  listStreams,
  refreshStreams,
  streamMovieAsMovie,
  type StreamMovie,
  type StreamQuality,
  type Movie,
} from "./api";
import { Row } from "./Row";

interface StreamsProps {
  onPlay: (item: StreamMovie, quality: StreamQuality) => void;
  active?: boolean;
  onRequestSidebar?: () => void;
}

export function Streams({ onPlay, active = true, onRequestSidebar }: StreamsProps) {
  const [items, setItems] = useState<StreamMovie[]>([]);
  const [status, setStatus] = useState("Loading streams…");
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [picker, setPicker] = useState<{ item: StreamMovie; qualities: StreamQuality[] } | null>(null);
  const [pickerIndex, setPickerIndex] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    async function load() {
      try {
        const catalog = await listStreams();
        if (cancelled) return;
        setItems(catalog.movies || []);
        if (catalog.refreshing && !(catalog.movies || []).length) {
          setStatus("Refreshing stream catalog…");
        } else if (!(catalog.movies || []).length) {
          setStatus(catalog.lastError || "No playable streams yet. Try Refresh.");
        } else {
          setStatus(catalog.refreshing ? "Updating catalog in background…" : "");
        }
        setFocusedIndex(0);
        if (catalog.refreshing) {
          pollTimer = setInterval(() => {
            listStreams()
              .then((next) => {
                if (cancelled) return;
                setItems(next.movies || []);
                if (!next.refreshing) {
                  setStatus(next.movies?.length ? "" : next.lastError || "No playable streams yet.");
                  if (pollTimer) clearInterval(pollTimer);
                }
              })
              .catch(() => {});
          }, 5000);
        }
      } catch (err) {
        if (!cancelled) setStatus("Failed to load streams: " + (err as Error).message);
      }
    }

    load();
    return () => {
      cancelled = true;
      if (pollTimer) clearInterval(pollTimer);
    };
  }, []);

  const movies = useMemo(() => items.map(streamMovieAsMovie), [items]);

  function openItem(item: StreamMovie) {
    const qualities = item.streams?.[0]?.qualities || [];
    if (!qualities.length) {
      setStatus("No playable qualities for " + item.title);
      return;
    }
    if (qualities.length === 1) {
      onPlay(item, qualities[0]);
      return;
    }
    setPicker({ item, qualities });
    setPickerIndex(0);
  }

  useEffect(() => {
    if (!active) return;
    function onKeyDown(e: KeyboardEvent) {
      if (picker) {
        if (e.keyCode === 40) setPickerIndex((i) => Math.min(picker.qualities.length - 1, i + 1));
        else if (e.keyCode === 38) setPickerIndex((i) => Math.max(0, i - 1));
        else if (e.keyCode === 13) onPlay(picker.item, picker.qualities[pickerIndex]);
        else if (e.keyCode === 10009 || e.keyCode === 27) setPicker(null);
        return;
      }
      if (!items.length) return;
      if (e.keyCode === 39) setFocusedIndex((i) => Math.min(items.length - 1, i + 1));
      else if (e.keyCode === 37) {
        setFocusedIndex((i) => {
          if (i <= 0) {
            onRequestSidebar?.();
            return 0;
          }
          return i - 1;
        });
      } else if (e.keyCode === 13) openItem(items[focusedIndex]);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [items, focusedIndex, onPlay, active, onRequestSidebar, picker, pickerIndex]);

  return (
    <div className="rows" style={{ marginTop: 0, paddingTop: 48 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, paddingLeft: 25, paddingRight: 25 }}>
        <h1 className="hero-title" style={{ fontSize: 32, margin: 0 }}>Streams</h1>
        <button
          type="button"
          className="hero-btn"
          style={{ fontSize: 14, padding: "8px 14px" }}
          onClick={() => {
            setStatus("Refreshing stream catalog…");
            refreshStreams()
              .then(() => listStreams())
              .then((catalog) => {
                setItems(catalog.movies || []);
                setStatus(catalog.refreshing ? "Refreshing stream catalog…" : catalog.movies?.length ? "" : "No playable streams yet.");
              })
              .catch((err) => setStatus("Refresh failed: " + err.message));
          }}
        >
          Refresh
        </button>
      </div>
      {status ? <p className="status">{status}</p> : null}
      {movies.length ? (
        <Row
          title="Trending"
          movies={movies}
          badge="LIVE"
          focusedIndex={active && !picker ? focusedIndex : null}
          onSelect={(_movie: Movie, index: number) => openItem(items[index])}
        />
      ) : null}

      {picker ? (
        <div className="modal-backdrop" style={{ display: "flex" }}>
          <div className="modal" role="dialog" aria-label="Choose quality">
            <h2 style={{ marginTop: 0 }}>{picker.item.title}</h2>
            <p className="status" style={{ paddingLeft: 0 }}>Choose quality</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {picker.qualities.map((q, i) => (
                <button
                  key={`${q.label}-${i}`}
                  type="button"
                  className={"hero-btn" + (i === pickerIndex ? " focused" : "")}
                  style={{
                    textAlign: "left",
                    outline: i === pickerIndex ? "2px solid var(--accent)" : "none",
                    background: i === pickerIndex ? "rgba(0,168,225,0.25)" : undefined,
                  }}
                  onClick={() => onPlay(picker.item, q)}
                >
                  {q.label}
                  {q.resolution ? ` · ${q.resolution}` : ""}
                </button>
              ))}
            </div>
            <button type="button" className="hero-play-btn secondary" style={{ marginTop: 16 }} onClick={() => setPicker(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
