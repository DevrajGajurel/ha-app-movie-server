import { useEffect } from "react";
import type { Movie } from "./api";

interface DetailProps {
  movie: Movie;
  downloaded: boolean;
  onPlay: () => void;
  onDownload: () => void;
  onClose: () => void;
}

export function Detail({ movie, downloaded, onPlay, onDownload, onClose }: DetailProps) {
  const t = movie.tmdb;
  const title = t?.tmdbTitle || movie.title;
  const backdrop = t?.backdrop || t?.poster;

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.keyCode === 13) {
        if (downloaded) onPlay();
        else onDownload();
      } else if (e.keyCode === 10009 || e.keyCode === 27) {
        onClose();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [downloaded, onPlay, onDownload, onClose]);

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
          <button className="hero-play-btn focused" onClick={downloaded ? onPlay : onDownload}>
            {downloaded ? "▶ Play" : "⬇ Download"}
          </button>
        </div>
      </div>
    </div>
  );
}
