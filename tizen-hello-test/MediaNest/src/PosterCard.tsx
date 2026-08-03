import { forwardRef } from "react";
import type { Movie } from "./api";

interface PosterCardProps {
  movie: Movie;
  focused: boolean;
  rank?: number;
  badge?: string;
  progressPercent?: number;
  downloaded?: boolean;
  onClick: () => void;
}

export const PosterCard = forwardRef<HTMLDivElement, PosterCardProps>(function PosterCard(
  { movie, focused, rank, badge, progressPercent, downloaded, onClick },
  ref
) {
  const title = movie.tmdb?.tmdbTitle || movie.title;
  const poster = movie.tmdb?.poster;

  return (
    <div ref={ref} className={"poster-card" + (rank ? " ranked" : "") + (focused ? " focused" : "")} onClick={onClick}>
      {rank ? <span className="rank-number">{rank}</span> : null}
      <div>
        <div className="poster-img-wrap">
          {badge ? <span className="poster-badge">{badge}</span> : null}
          {poster ? <img src={poster} alt={title} loading="lazy" /> : null}
          {downloaded ? <div className="poster-play-icon">▶</div> : null}
          {progressPercent != null ? (
            <div className="poster-progress-track">
              <div className="poster-progress-fill" style={{ width: `${progressPercent}%` }} />
            </div>
          ) : null}
        </div>
        <div className="poster-title">{title}</div>
      </div>
    </div>
  );
});
