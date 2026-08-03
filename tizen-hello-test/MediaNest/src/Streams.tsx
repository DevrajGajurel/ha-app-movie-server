import { useEffect, useMemo, useState } from "react";
import { listM3u8Playlists, type M3u8Playlist, type Movie } from "./api";
import { Row } from "./Row";

interface StreamsProps {
  onPlay: (item: M3u8Playlist) => void;
  active?: boolean;
  onRequestSidebar?: () => void;
}

function playlistAsMovie(item: M3u8Playlist): Movie {
  return {
    title: item.tmdb?.tmdbTitle || item.name,
    link: `m3u8:${item.token}`,
    tmdb: item.tmdb || undefined,
  };
}

export function Streams({ onPlay, active = true, onRequestSidebar }: StreamsProps) {
  const [items, setItems] = useState<M3u8Playlist[]>([]);
  const [status, setStatus] = useState("Loading playlists…");
  const [focusedIndex, setFocusedIndex] = useState(0);

  useEffect(() => {
    let cancelled = false;
    listM3u8Playlists()
      .then((list) => {
        if (cancelled) return;
        setItems(list);
        setStatus(list.length ? "" : "No .m3u8 files in PlexMedia/M3U8.");
        setFocusedIndex(0);
      })
      .catch((err) => {
        if (!cancelled) setStatus("Failed to load playlists: " + err.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const movies = useMemo(() => items.map(playlistAsMovie), [items]);

  useEffect(() => {
    if (!active) return;
    function onKeyDown(e: KeyboardEvent) {
      if (!items.length) return;
      if (e.keyCode === 39) {
        setFocusedIndex((i) => Math.min(items.length - 1, i + 1));
      } else if (e.keyCode === 37) {
        setFocusedIndex((i) => {
          if (i <= 0) {
            onRequestSidebar?.();
            return 0;
          }
          return i - 1;
        });
      } else if (e.keyCode === 13) {
        onPlay(items[focusedIndex]);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [items, focusedIndex, onPlay, active, onRequestSidebar]);

  return (
    <div className="rows" style={{ marginTop: 0, paddingTop: 48 }}>
      <h1 className="hero-title" style={{ fontSize: 32, paddingLeft: 25 }}>Streams</h1>
      {status ? <p className="status">{status}</p> : null}
      {movies.length ? (
        <Row
          title="Playlists"
          movies={movies}
          badge="LIVE"
          focusedIndex={active ? focusedIndex : null}
          onSelect={(_movie, index) => onPlay(items[index])}
        />
      ) : null}
    </div>
  );
}
