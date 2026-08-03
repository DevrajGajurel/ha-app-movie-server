import { useEffect, useState } from "react";
import { listM3u8Playlists, type M3u8Playlist } from "./api";

interface StreamsProps {
  onPlay: (item: M3u8Playlist) => void;
  active?: boolean;
}

export function Streams({ onPlay, active = true }: StreamsProps) {
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

  useEffect(() => {
    if (!active) return;
    function onKeyDown(e: KeyboardEvent) {
      if (!items.length) return;
      if (e.keyCode === 40) setFocusedIndex((i) => Math.min(items.length - 1, i + 1));
      else if (e.keyCode === 38) setFocusedIndex((i) => Math.max(0, i - 1));
      else if (e.keyCode === 13) onPlay(items[focusedIndex]);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [items, focusedIndex, onPlay, active]);

  return (
    <div className="rows" style={{ marginTop: 0, paddingTop: 48 }}>
      <h1 className="hero-title" style={{ fontSize: 32 }}>Streams</h1>
      {status ? <p className="status" style={{ paddingLeft: 0 }}>{status}</p> : null}
      {items.map((item, i) => (
        <div
          key={item.token}
          className={"stream-item" + (active && i === focusedIndex ? " focused" : "")}
          onClick={() => onPlay(item)}
        >
          <div style={{ fontWeight: 600 }}>{item.name}</div>
          <div style={{ color: "var(--muted)", fontSize: 15 }}>{item.fileName}</div>
        </div>
      ))}
    </div>
  );
}
