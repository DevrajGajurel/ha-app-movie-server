import { useEffect, useMemo, useState } from "react";
import {
  getAllMovies,
  getDownloadedMovies,
  getContinueWatching,
  matchMovieForProgress,
  matchMovieForDownload,
  getLibraryMovies,
  getMoviePageLink,
  getTmdbById,
  isDownloaded,
  type Movie,
  type DownloadedMovie,
  type TmdbInfo,
} from "./api";
import { Sidebar, SIDEBAR_ITEMS, SIDEBAR_VIEWS, type SidebarView } from "./Sidebar";
import { Hero } from "./Hero";
import { Row } from "./Row";
import { Detail } from "./Detail";
import { DownloadModal } from "./DownloadModal";
import { Search } from "./Search";
import { Downloads } from "./Downloads";
import { Library } from "./Library";
import { ExitConfirm } from "./ExitConfirm";

type View = SidebarView;

interface HomeProps {
  onPlay: (movie: Movie) => void;
}

interface RowDef {
  title: string;
  movies: Movie[];
  ranked?: boolean;
  badge?: string;
}

const HERO_ROTATE_MS = 8000;

export function Home({ onPlay }: HomeProps) {
  const [movies, setMovies] = useState<Movie[]>([]);
  const [downloaded, setDownloaded] = useState<DownloadedMovie[]>([]);
  const [continueWatchingPercent, setContinueWatchingPercent] = useState<Map<string, number>>(new Map());
  const [status, setStatus] = useState("Loading your library…");
  const [heroIndex, setHeroIndex] = useState(0);

  const [view, setView] = useState<View>("browse");
  const [sidebarFocused, setSidebarFocused] = useState(false);
  const [sidebarIndex, setSidebarIndex] = useState(0);
  const [rowIndex, setRowIndex] = useState(-1); // -1 = hero
  const [itemIndex, setItemIndex] = useState(0);

  const [openDetail, setOpenDetail] = useState<Movie | null>(null);
  const [openDownload, setOpenDownload] = useState<Movie | null>(null);
  const [openDownloadEpisode, setOpenDownloadEpisode] = useState<{ seasonNumber: number; episodeNumber: number } | null>(
    null
  );
  const [showExitConfirm, setShowExitConfirm] = useState(false);

  useEffect(() => {
    Promise.all([getAllMovies(), getDownloadedMovies()])
      .then(([m, d]) => {
        setMovies(m);
        setDownloaded(d);
        setStatus(m.length ? "" : "No movies found.");
        return getContinueWatching().then((items) => {
          const percentByLink = new Map<string, number>();
          for (const item of items) {
            const match = matchMovieForProgress(item, m);
            if (match) percentByLink.set(match.link, item.percent);
          }
          setContinueWatchingPercent(percentByLink);
        });
      })
      .catch((err) => setStatus("Failed to load library: " + err.message));
  }, []);

  const heroMovies = useMemo(() => {
    return [...movies]
      .filter((m) => m.tmdb?.backdrop)
      .sort((a, b) => (b.tmdb?.rating || 0) - (a.tmdb?.rating || 0))
      .slice(0, 5);
  }, [movies]);

  // Cycles the hero spotlight automatically, same idea as HelloTV's hero
  // rotation - paused implicitly whenever a modal is open since those
  // unmount this timer's owner component's re-renders don't matter then.
  useEffect(() => {
    if (heroMovies.length <= 1 || openDetail || openDownload) return;
    const timer = window.setInterval(() => setHeroIndex((i) => (i + 1) % heroMovies.length), HERO_ROTATE_MS);
    return () => window.clearInterval(timer);
  }, [heroMovies.length, openDetail, openDownload]);

  // Scrolling back up to the hero has nothing to trigger it otherwise:
  // Row.tsx only scrolls the page when ITS OWN row becomes focused, and the
  // hero isn't a Row - so without this, moving Up from row 0 all the way
  // back to the hero (rowIndex -1) left the page still scrolled down at
  // whatever row you came from, with no way back to the top.
  useEffect(() => {
    if (rowIndex === -1) document.getElementById("root")?.scrollTo({ top: 0, behavior: "smooth" });
  }, [rowIndex]);

  const [tmdbById, setTmdbById] = useState<Map<string, TmdbInfo>>(new Map());
  const rawLibraryMovies = useMemo(() => getLibraryMovies(downloaded, movies), [downloaded, movies]);

  // rawLibraryMovies only has poster/backdrop art for downloads that also
  // matched something in the currently cached listing pages
  // (matchMovieForDownload) - anything downloaded a while ago and since
  // rotated off those pages comes back as a posterless stub instead. Fetch
  // those directly by tmdbId (a couple at a time, not all at once) and
  // splice the result back in once it lands.
  useEffect(() => {
    const missing = rawLibraryMovies.filter(
      (m) => m.tmdb?.tmdbId && !m.tmdb.poster && !tmdbById.has(String(m.tmdb.tmdbId))
    );
    if (!missing.length) return;

    let cancelled = false;
    const CONCURRENCY = 3;

    (async () => {
      for (let i = 0; i < missing.length; i += CONCURRENCY) {
        if (cancelled) return;
        const batch = missing.slice(i, i + CONCURRENCY);
        const results = await Promise.all(
          batch.map((m) =>
            getTmdbById(String(m.tmdb!.tmdbId), m.tmdb!.type).then((info) => [String(m.tmdb!.tmdbId), info] as const)
          )
        );
        if (cancelled) return;
        setTmdbById((prev) => {
          const next = new Map(prev);
          for (const [id, info] of results) {
            if (info) next.set(id, info);
          }
          return next;
        });
      }
    })();

    return () => {
      cancelled = true;
    };
    // Only re-run when the missing set actually changes shape, not on every
    // tmdbById update this effect itself causes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawLibraryMovies]);

  const libraryMovies = useMemo(() => {
    if (!tmdbById.size) return rawLibraryMovies;
    return rawLibraryMovies.map((m) => {
      const id = m.tmdb?.tmdbId ? String(m.tmdb.tmdbId) : null;
      const fetched = id ? tmdbById.get(id) : undefined;
      return fetched ? { ...m, tmdb: fetched } : m;
    });
  }, [rawLibraryMovies, tmdbById]);

  const rows: RowDef[] = useMemo(() => {
    if (!movies.length) return [];
    const byRating = [...movies]
      .filter((m) => m.tmdb?.type !== "tv")
      .sort((a, b) => (b.tmdb?.rating || 0) - (a.tmdb?.rating || 0));
    const recentlyAdded = [...movies].sort((a, b) => (b.sourceOrder ?? 0) - (a.sourceOrder ?? 0)).slice(0, 20);

    const tvSeriesRow: RowDef[] = (() => {
      const tvShows = movies
        .filter((m) => m.tmdb?.type === "tv")
        .sort((a, b) => (b.tmdb?.rating || 0) - (a.tmdb?.rating || 0))
        .slice(0, 20);
      return tvShows.length ? [{ title: "TV Series", movies: tvShows }] : [];
    })();

    const genreCounts = new Map<string, number>();
    for (const m of movies) {
      for (const g of m.tmdb?.genres || []) genreCounts.set(g, (genreCounts.get(g) || 0) + 1);
    }
    const topGenres = [...genreCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([g]) => g);

    const genreRows: RowDef[] = topGenres.map((genre) => ({
      title: genre,
      movies: movies.filter((m) => m.tmdb?.genres?.includes(genre)).slice(0, 20),
    }));

    const continueWatchingMovies = movies.filter((m) => continueWatchingPercent.has(m.link));
    const continueWatchingRow: RowDef[] = continueWatchingMovies.length
      ? [{ title: "Continue Watching", movies: continueWatchingMovies }]
      : [];

    // Downloaded-library entries only carry tmdbId/title, not full
    // metadata - match each back to its catalog Movie, then sort by the
    // backend's downloadedAt (the video file's own creation date, falling
    // back to folder mtime only if that's unreadable) descending. Every
    // downloaded title belongs here, not just the most recent N.
    const recentlyDownloaded = [...downloaded]
      .sort((a, b) => new Date(b.downloadedAt || 0).getTime() - new Date(a.downloadedAt || 0).getTime())
      .map((item) => matchMovieForDownload(item, movies))
      .filter((m): m is Movie => !!m)
      .filter((m, i, arr) => arr.findIndex((other) => other.link === m.link) === i);
    const recentlyDownloadedRow: RowDef[] = recentlyDownloaded.length
      ? [{ title: "Recently Downloaded", movies: recentlyDownloaded }]
      : [];

    return [
      ...continueWatchingRow,
      { title: "Top 10 Movies", movies: byRating.slice(0, 10), ranked: true },
      ...tvSeriesRow,
      ...recentlyDownloadedRow,
      { title: "Recently Added", movies: recentlyAdded, badge: "NEW" },
      ...genreRows,
    ];
  }, [movies, downloaded, continueWatchingPercent]);

  const currentHeroMovie = heroMovies[heroIndex] || null;

  function moveRow(delta: number) {
    const newRowIndex = Math.max(-1, Math.min(rows.length - 1, rowIndex + delta));
    setRowIndex(newRowIndex);
    setItemIndex((prev) => {
      if (newRowIndex === -1) return 0;
      const len = rows[newRowIndex]?.movies.length || 1;
      return Math.min(prev, len - 1);
    });
  }

  function moveItem(delta: number) {
    if (rowIndex === -1) return; // hero has no left/right item navigation
    const len = rows[rowIndex]?.movies.length || 0;
    setItemIndex((prev) => Math.max(0, Math.min(len - 1, prev + delta)));
  }

  function openMovie(movie: Movie) {
    setOpenDetail(movie);
  }

  function handlePlayFromDetail(movie: Movie) {
    setOpenDetail(null);
    onPlay(movie);
  }

  function handleDownloadFromDetail(movie: Movie, episode?: { seasonNumber: number; episodeNumber: number }) {
    setOpenDetail(null);
    setOpenDownload(movie);
    setOpenDownloadEpisode(episode || null);
  }

  useEffect(() => {
    if (openDetail || openDownload || showExitConfirm) return; // those handle their own keys
    function onKeyDown(e: KeyboardEvent) {
      if (e.keyCode === 10009 || e.keyCode === 27) {
        // Back: leave search/library/downloads back to the browse screen. On the
        // browse screen itself there's nothing left to "close" at this
        // level, so ask before quitting instead - an accidental extra Back
        // press shouldn't kick the user out of the app.
        if (view !== "browse") {
          setView("browse");
        } else {
          setShowExitConfirm(true);
        }
        return;
      }

      if (sidebarFocused) {
        switch (e.keyCode) {
          case 39: // Right - leave the sidebar back into whatever's on screen
            setSidebarFocused(false);
            break;
          case 38:
            setSidebarIndex((i) => Math.max(0, i - 1));
            break;
          case 40:
            setSidebarIndex((i) => Math.min(SIDEBAR_ITEMS.length - 1, i + 1));
            break;
          case 13:
            {
              const next = SIDEBAR_VIEWS[sidebarIndex] || "browse";
              setView(next);
              setSidebarFocused(false);
            }
            break;
        }
        return;
      }

      if (view !== "browse") return;

      switch (e.keyCode) {
        case 37: // Left
          if (itemIndex === 0) setSidebarFocused(true);
          else moveItem(-1);
          break;
        case 39: // Right
          moveItem(1);
          break;
        case 38: // Up
          moveRow(-1);
          break;
        case 40: // Down
          moveRow(1);
          break;
        case 13: // Enter
          if (rowIndex === -1) {
            if (currentHeroMovie) onPlay(currentHeroMovie);
          } else {
            const movie = rows[rowIndex]?.movies[itemIndex];
            if (movie) openMovie(movie);
          }
          break;
        // Dedicated remote Play/Pause buttons: jump straight into playback
        // from whichever poster is focused, skipping the Detail screen -
        // but only when the title is actually downloaded, since there's
        // nothing to play otherwise.
        case 415: // MediaPlay
        case 19: // MediaPause
        case 10252: // MediaPlayPause
          {
            const focusedMovie = rowIndex === -1 ? currentHeroMovie : rows[rowIndex]?.movies[itemIndex];
            if (focusedMovie && isDownloaded(focusedMovie, downloaded)) onPlay(focusedMovie);
          }
          break;
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, sidebarFocused, sidebarIndex, rowIndex, itemIndex, rows, currentHeroMovie, downloaded, openDetail, openDownload, showExitConfirm]);

  function selectSidebar(index: number) {
    setSidebarIndex(index);
    setSidebarFocused(false);
    setView(SIDEBAR_VIEWS[index] || "browse");
  }

  return (
    <div>
      <Sidebar activeIndex={sidebarIndex} focusedIndex={sidebarFocused ? sidebarIndex : null} onSelect={selectSidebar} />
      {view === "browse" && (
        <>
          <Hero
            movie={currentHeroMovie}
            focused={!sidebarFocused && rowIndex === -1}
            dotsCount={heroMovies.length}
            activeDot={heroIndex}
            onPlay={() => currentHeroMovie && onPlay(currentHeroMovie)}
          />
          {status && <p className="status">{status}</p>}
          <div className="rows">
            {rows.map((row, ri) => (
              <Row
                key={row.title}
                title={row.title}
                movies={row.movies}
                ranked={row.ranked}
                badge={row.badge}
                progressFor={(movie) => continueWatchingPercent.get(movie.link)}
                downloadedFor={(movie) => isDownloaded(movie, downloaded)}
                focusedIndex={!sidebarFocused && rowIndex === ri ? itemIndex : null}
                onSelect={(movie) => openMovie(movie)}
              />
            ))}
          </div>
        </>
      )}
      {view === "search" && (
        <Search
          movies={movies}
          onSelect={openMovie}
          progressFor={(movie) => continueWatchingPercent.get(movie.link)}
          downloadedFor={(movie) => isDownloaded(movie, downloaded)}
        />
      )}
      {view === "library" && (
        <Library
          movies={libraryMovies}
          active={!sidebarFocused && !openDetail && !openDownload && !showExitConfirm}
          onSelect={openMovie}
          onPlay={onPlay}
          onLeaveToSidebar={() => setSidebarFocused(true)}
          progressFor={(movie) => continueWatchingPercent.get(movie.link)}
        />
      )}
      {view === "downloads" && (
        <Downloads
          active={!sidebarFocused && !openDetail && !openDownload && !showExitConfirm}
          onLeaveToSidebar={() => setSidebarFocused(true)}
        />
      )}
      {openDetail && (
        <Detail
          key={openDetail.link}
          movie={openDetail}
          downloaded={isDownloaded(openDetail, downloaded)}
          onPlay={() => handlePlayFromDetail(openDetail)}
          onDownload={(episode) => handleDownloadFromDetail(openDetail, episode)}
          onDeleted={() => {
            setOpenDetail(null);
            getDownloadedMovies().then(setDownloaded);
          }}
          onClose={() => setOpenDetail(null)}
        />
      )}
      {openDownload && (
        <DownloadModal
          pageUrl={getMoviePageLink(openDownload)}
          movieTitle={openDownload.tmdb?.tmdbTitle || openDownload.title}
          tmdbId={openDownload.tmdb?.tmdbId ? String(openDownload.tmdb.tmdbId) : null}
          mediaType={openDownload.tmdb?.type === "tv" ? "tv" : "movie"}
          seasons={openDownload.tmdb?.seasons}
          initialEpisode={openDownloadEpisode}
          onClose={() => {
            setOpenDownload(null);
            setOpenDownloadEpisode(null);
          }}
          onDownloadStarted={() => getDownloadedMovies().then(setDownloaded)}
        />
      )}
      {showExitConfirm && <ExitConfirm onCancel={() => setShowExitConfirm(false)} />}
    </div>
  );
}
