import type { Movie } from "./api";

interface HeroProps {
  movie: Movie | null;
  focused: boolean;
  dotsCount: number;
  activeDot: number;
  onPlay: () => void;
}

export function Hero({ movie, focused, dotsCount, activeDot, onPlay }: HeroProps) {
  if (!movie) return <div className="hero" />;

  const t = movie.tmdb;
  const title = t?.tmdbTitle || movie.title;
  const backdrop = t?.backdrop || t?.poster;

  return (
    <div className="hero">
      {backdrop ? <div className="hero-backdrop" style={{ backgroundImage: `url("${backdrop}")` }} /> : null}
      <div className="hero-scrim" />
      {t?.certification ? <div className="hero-badge">{t.certification}</div> : null}
      <div className="hero-content">
        <div className="hero-meta">
          {t?.rating ? <span className="rating">★ {t.rating}</span> : null}
          {t?.year ? <span>{t.year}</span> : null}
          {t?.genres?.length ? <span>{t.genres.slice(0, 3).join(" · ")}</span> : null}
        </div>
        <h1 className="hero-title">{title}</h1>
        {t?.overview ? <p className="hero-overview">{t.overview}</p> : null}
        <button className={"hero-play-btn" + (focused ? " focused" : "")} onClick={onPlay}>
          ▶ Play Now
        </button>
      </div>
      {dotsCount > 1 ? (
        <div className="hero-dots">
          {Array.from({ length: dotsCount }).map((_, i) => (
            <span key={i} className={"hero-dot" + (i === activeDot ? " active" : "")} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
