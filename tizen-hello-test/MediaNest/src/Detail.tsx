import { useEffect, useMemo, useState } from "react";
import type { Movie } from "./api";
import { deleteMedia } from "./api";
import { DeleteConfirm } from "./DeleteConfirm";
import { Trailer } from "./Trailer";

interface DetailProps {
  movie: Movie;
  downloaded: boolean;
  onPlay: () => void;
  onDownload: () => void;
  onDeleted: () => void;
  onClose: () => void;
}

type ActionKind = "primary" | "trailer" | "delete";

export function Detail({ movie, downloaded, onPlay, onDownload, onDeleted, onClose }: DetailProps) {
  const t = movie.tmdb;
  const title = t?.tmdbTitle || movie.title;
  const backdrop = t?.backdrop || t?.poster;

  const [focusedIndex, setFocusedIndex] = useState(0);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showTrailer, setShowTrailer] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const actions = useMemo(() => {
    const list: { kind: ActionKind; label: string }[] = [
      { kind: "primary", label: downloaded ? "▶ Play" : "⬇ Download" },
    ];
    if (t?.trailerKey) list.push({ kind: "trailer", label: "▶ Trailer" });
    if (downloaded) list.push({ kind: "delete", label: "🗑 Delete" });
    return list;
  }, [downloaded, t?.trailerKey]);

  function runAction(kind: ActionKind) {
    if (kind === "primary") (downloaded ? onPlay : onDownload)();
    else if (kind === "trailer") setShowTrailer(true);
    else if (kind === "delete") setShowDeleteConfirm(true);
  }

  async function confirmDelete() {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteMedia(t?.tmdbId ? String(t.tmdbId) : null, title);
      onDeleted();
    } catch (err) {
      setDeleting(false);
      setDeleteError(err instanceof Error ? err.message : "Failed to delete");
    }
  }

  useEffect(() => {
    if (showDeleteConfirm || showTrailer) return; // those handle their own keys
    function onKeyDown(e: KeyboardEvent) {
      if (e.keyCode === 13) {
        runAction(actions[focusedIndex]?.kind ?? "primary");
      } else if (e.keyCode === 37) {
        setFocusedIndex((i) => Math.max(0, i - 1));
      } else if (e.keyCode === 39) {
        setFocusedIndex((i) => Math.min(actions.length - 1, i + 1));
      } else if (e.keyCode === 10009 || e.keyCode === 27) {
        onClose();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDeleteConfirm, showTrailer, focusedIndex, actions, onClose]);

  // The action list can shrink (e.g. Delete disappears once deleted) -
  // keep focus in range rather than pointing past the end.
  useEffect(() => {
    setFocusedIndex((i) => Math.min(i, actions.length - 1));
  }, [actions.length]);

  return (
    <div className="detail-overlay">
      <div className="hero">
        {backdrop ? <div className="hero-backdrop" style={{ backgroundImage: `url("${backdrop}")` }} /> : null}
        <div className="hero-scrim" />
        {t?.certification ? <div className="hero-badge">{t.certification}</div> : null}
        <div className="hero-content">
          <div className="hero-meta">
            {t?.rating ? <span className="rating">★ {t.rating}</span> : null}
            {t?.year ? <span>{t.year}</span> : null}
            {t?.runtimeMinutes ? <span>{Math.floor(t.runtimeMinutes / 60)}h {t.runtimeMinutes % 60}m</span> : null}
            {t?.genres?.length ? <span>{t.genres.slice(0, 3).join(" · ")}</span> : null}
          </div>
          <h1 className="hero-title">{title}</h1>
          {t?.tagline ? <p style={{ fontStyle: "italic", color: "var(--muted)", margin: "0 0 8px" }}>{t.tagline}</p> : null}
          {t?.overview ? <p className="hero-overview">{t.overview}</p> : null}
          {t?.director ? <p style={{ color: "var(--muted)", marginBottom: 24 }}>Director: {t.director}</p> : null}
          <div className="hero-actions">
            {actions.map((action, i) => (
              <button
                key={action.kind}
                className={
                  "hero-play-btn" +
                  (action.kind === "trailer" ? " secondary" : "") +
                  (action.kind === "delete" ? " secondary danger" : "") +
                  (focusedIndex === i ? " focused" : "")
                }
                onClick={() => runAction(action.kind)}
              >
                {action.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      {showDeleteConfirm && (
        <DeleteConfirm
          title={title}
          deleting={deleting}
          error={deleteError}
          onCancel={() => {
            setShowDeleteConfirm(false);
            setDeleteError(null);
          }}
          onConfirm={confirmDelete}
        />
      )}
      {showTrailer && t?.trailerKey && <Trailer trailerKey={t.trailerKey} onClose={() => setShowTrailer(false)} />}
    </div>
  );
}
