import { useEffect, useMemo, useRef, useState } from "react";
import type { Movie } from "./api";
import { deleteMedia, getSeasonEpisodeDetails, getEpisodeFileToken, type EpisodeDetail } from "./api";
import { DeleteConfirm } from "./DeleteConfirm";
import { Trailer } from "./Trailer";

interface DetailProps {
  movie: Movie;
  downloaded: boolean;
  onPlay: (fileToken?: string) => void;
  onDownload: (episode?: { seasonNumber: number; episodeNumber: number }) => void;
  onDeleted: () => void;
  onClose: () => void;
}

type ActionKind = "primary" | "trailer" | "delete";
type FocusRegion = "actions" | "seasons" | "episodes";

const EPISODE_GRID_COLUMNS = 6;

function formatEpisodeYear(airDate: string | null): string {
  return airDate ? airDate.slice(0, 4) : "";
}

export function Detail({ movie, downloaded, onPlay, onDownload, onDeleted, onClose }: DetailProps) {
  const t = movie.tmdb;
  const title = t?.tmdbTitle || movie.title;
  const backdrop = t?.backdrop || t?.poster;
  const seasons = t?.seasons || [];
  const isTv = t?.type === "tv" && seasons.length > 0;

  const [actionIndex, setActionIndex] = useState(0);
  const [focusRegion, setFocusRegion] = useState<FocusRegion>("actions");
  const [seasonIdx, setSeasonIdx] = useState(0);
  const [episodeFocusIdx, setEpisodeFocusIdx] = useState(0);
  const [episodes, setEpisodes] = useState<EpisodeDetail[]>([]);
  const [episodesLoading, setEpisodesLoading] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showTrailer, setShowTrailer] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const episodeRefs = useRef<(HTMLDivElement | null)[]>([]);

  const currentSeason = seasons[seasonIdx];

  const actions = useMemo(() => {
    const list: { kind: ActionKind; label: string }[] = [
      { kind: "primary", label: downloaded ? "▶ Play" : "⬇ Download" },
    ];
    if (t?.trailerKey) list.push({ kind: "trailer", label: "▶ Trailer" });
    if (downloaded) list.push({ kind: "delete", label: "🗑 Delete" });
    return list;
  }, [downloaded, t?.trailerKey]);

  function runAction(kind: ActionKind) {
    if (kind === "primary") (downloaded ? onPlay : () => onDownload())();
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

  // Fetching episode details is genuinely fast: seasons[] (names/episode
  // counts) is already part of the loaded movie, only the per-episode
  // name/overview/still needs its own TMDB call, one per season shown.
  useEffect(() => {
    if (!isTv || !t?.tmdbId || !currentSeason) return;
    let cancelled = false;
    setEpisodesLoading(true);
    getSeasonEpisodeDetails(String(t.tmdbId), currentSeason.seasonNumber).then((eps) => {
      if (cancelled) return;
      setEpisodes(eps);
      setEpisodesLoading(false);
      setEpisodeFocusIdx(0);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTv, t?.tmdbId, seasonIdx]);

  useEffect(() => {
    if (focusRegion !== "episodes") return;
    episodeRefs.current[episodeFocusIdx]?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [focusRegion, episodeFocusIdx]);

  // Plays this exact episode if it's already downloaded, otherwise opens
  // the download popup straight at its quality options - a plain
  // tmdbId/title match would just return the largest file this whole
  // series has anywhere, which means nothing once more than one episode
  // is on disk.
  async function selectEpisode(ep: EpisodeDetail) {
    if (!currentSeason) return;
    const tmdbId = t?.tmdbId ? String(t.tmdbId) : null;
    const token = await getEpisodeFileToken(tmdbId, title, currentSeason.seasonNumber, ep.episodeNumber);
    if (token) {
      onPlay(token);
    } else {
      onDownload({ seasonNumber: currentSeason.seasonNumber, episodeNumber: ep.episodeNumber });
    }
  }

  useEffect(() => {
    if (showDeleteConfirm || showTrailer) return; // those handle their own keys

    function onKeyDown(e: KeyboardEvent) {
      if (e.keyCode === 10009 || e.keyCode === 27) {
        onClose();
        return;
      }

      if (focusRegion === "actions") {
        if (e.keyCode === 13) runAction(actions[actionIndex]?.kind ?? "primary");
        else if (e.keyCode === 37) setActionIndex((i) => Math.max(0, i - 1));
        else if (e.keyCode === 39) setActionIndex((i) => Math.min(actions.length - 1, i + 1));
        else if (e.keyCode === 40 && isTv) setFocusRegion("seasons");
        return;
      }

      if (focusRegion === "seasons") {
        if (e.keyCode === 38) setFocusRegion("actions");
        else if (e.keyCode === 40 && episodes.length) setFocusRegion("episodes");
        else if (e.keyCode === 37) setSeasonIdx((i) => Math.max(0, i - 1));
        else if (e.keyCode === 39) setSeasonIdx((i) => Math.min(seasons.length - 1, i + 1));
        return;
      }

      // focusRegion === "episodes"
      if (e.keyCode === 38) {
        const row = Math.floor(episodeFocusIdx / EPISODE_GRID_COLUMNS);
        if (row === 0) setFocusRegion("seasons");
        else setEpisodeFocusIdx((i) => Math.max(0, i - EPISODE_GRID_COLUMNS));
      } else if (e.keyCode === 40) {
        setEpisodeFocusIdx((i) => Math.min(episodes.length - 1, i + EPISODE_GRID_COLUMNS));
      } else if (e.keyCode === 37) {
        setEpisodeFocusIdx((i) => Math.max(0, i - 1));
      } else if (e.keyCode === 39) {
        setEpisodeFocusIdx((i) => Math.min(episodes.length - 1, i + 1));
      } else if (e.keyCode === 13) {
        const ep = episodes[episodeFocusIdx];
        if (ep) selectEpisode(ep);
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    showDeleteConfirm,
    showTrailer,
    focusRegion,
    actionIndex,
    actions,
    seasonIdx,
    seasons.length,
    episodeFocusIdx,
    episodes,
    currentSeason,
    isTv,
    onClose,
  ]);

  // The action list can shrink (e.g. Delete disappears once deleted) -
  // keep focus in range rather than pointing past the end.
  useEffect(() => {
    setActionIndex((i) => Math.min(i, actions.length - 1));
  }, [actions.length]);

  return (
    <div className={"detail-overlay" + (isTv ? " has-episodes" : "")}>
      <div className="hero">
        {backdrop ? <div className="hero-backdrop" style={{ backgroundImage: `url("${backdrop}")` }} /> : null}
        <div className="hero-scrim" />
        {t?.certification ? <div className="hero-badge">{t.certification}</div> : null}
        <div className="hero-content" style={isTv ? { display: "flex", gap: 32, alignItems: "flex-start", maxWidth: "none" } : undefined}>
          {isTv && t?.poster ? (
            <img src={t.poster} alt="" className="detail-poster" />
          ) : null}
          <div style={isTv ? { maxWidth: 780 } : undefined}>
            {isTv ? <div className="detail-kicker">Series</div> : null}
            <h1 className="hero-title">{title}</h1>
            {t?.genres?.length ? (
              <div className="detail-genre-tags">
                {t.genres.slice(0, 4).map((g) => (
                  <span key={g} className="detail-genre-tag">{g}</span>
                ))}
              </div>
            ) : null}
            <div className="hero-meta">
              {t?.rating ? <span className="rating">★ {t.rating}</span> : null}
              {t?.year ? <span>{t.year}</span> : null}
              {isTv && t?.numberOfSeasons ? <span>{t.numberOfSeasons} Season{t.numberOfSeasons !== 1 ? "s" : ""}</span> : null}
              {isTv && currentSeason ? <span>{currentSeason.episodeCount} Episodes</span> : null}
              {!isTv && t?.runtimeMinutes ? <span>{Math.floor(t.runtimeMinutes / 60)}h {t.runtimeMinutes % 60}m</span> : null}
              {!isTv && t?.genres?.length ? <span>{t.genres.slice(0, 3).join(" · ")}</span> : null}
            </div>
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
                    (focusRegion === "actions" && actionIndex === i ? " focused" : "")
                  }
                  onClick={() => runAction(action.kind)}
                >
                  {action.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {isTv && (
        <div className="detail-episodes">
          <h2 className="detail-episodes-header">Episodes</h2>
          {seasons.length > 1 && (
            <div className="season-pills">
              {seasons.map((s, i) => (
                <div
                  key={s.seasonNumber}
                  className={
                    "season-pill" +
                    (i === seasonIdx ? " active" : "") +
                    (focusRegion === "seasons" && i === seasonIdx ? " focused" : "")
                  }
                  onClick={() => setSeasonIdx(i)}
                >
                  {s.name}
                </div>
              ))}
            </div>
          )}
          {episodesLoading ? (
            <p className="status" style={{ paddingLeft: 0 }}>Loading episodes…</p>
          ) : (
            <div className="episode-grid">
              {episodes.map((ep, i) => (
                <div
                  key={ep.episodeNumber}
                  ref={(el) => {
                    episodeRefs.current[i] = el;
                  }}
                  className={"episode-card" + (focusRegion === "episodes" && i === episodeFocusIdx ? " focused" : "")}
                  onClick={() => selectEpisode(ep)}
                >
                  {ep.still ? (
                    <img src={ep.still} alt="" className="episode-card-thumb" />
                  ) : (
                    <div className="episode-card-thumb" />
                  )}
                  <div className="episode-card-body">
                    <div className="episode-card-num">E{ep.episodeNumber}</div>
                    <div className="episode-card-title">{ep.name}</div>
                    {ep.overview ? <div className="episode-card-overview">{ep.overview}</div> : null}
                    {formatEpisodeYear(ep.airDate) ? (
                      <div className="episode-card-overview">{formatEpisodeYear(ep.airDate)}</div>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

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
