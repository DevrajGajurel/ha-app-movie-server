import { useEffect, useMemo, useState } from "react";
import {
  getAllMovies,
  getDownloadedMovies,
  getContinueWatching,
  matchMovieForProgress,
  getMoviePageLink,
  isDownloaded,
  type Movie,
  type DownloadedMovie,
} from "./api";
import { Sidebar, SIDEBAR_ITEMS } from "./Sidebar";
import { Hero } from "./Hero";
import { Row } from "./Row";
import { Detail } from "./Detail";
import { DownloadModal } from "./DownloadModal";
import { Search } from "./Search";
import { Downloads } from "./Downloads";

type View = "browse" | "search" | "downloads";

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

  const rows: RowDef[] = useMemo(() => {
    if (!movies.length) return [];
    const byRating = [...movies].sort((a, b) => (b.tmdb?.rating || 0) - (a.tmdb?.rating || 0));
    const recentlyAdded = [...movies].sort((a, b) => (b.sourceOrder ?? 0) - (a.sourceOrder ?? 0)).slice(0, 20);

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

    return [
      ...continueWatchingRow,
      { title: "Top 10 Movies", movies: byRating.slice(0, 10), ranked: true },
      { title: "Recently Added", movies: recentlyAdded, badge: "NEW" },
      ...genreRows,
    ];
  }, [movies, continueWatchingPercent]);

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

  function handleDownloadFromDetail(movie: Movie) {
    setOpenDetail(null);
    setOpenDownload(movie);
  }

  useEffect(() => {
    if (openDetail || openDownload) return; // those handle their own keys
    function onKeyDown(e: KeyboardEvent) {
      if (e.keyCode === 10009 || e.keyCode === 27) {
        // Back: leave search/downloads back to the browse screen. In the
        // browse screen itself there's nothing to "close" at this level.
        if (view !== "browse") {
          setView("browse");
          e.stopPropagation();
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
            setView(sidebarIndex === 0 ? "browse" : sidebarIndex === 1 ? "search" : "downloads");
            setSidebarFocused(false);
            break;
        }
        return;
      }

      // Search/Downloads own their own key handling once focus has left
      // the sidebar (see Search.tsx) - this listener only drives the
      // browse screen's hero/row navigation below.
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
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, sidebarFocused, sidebarIndex, rowIndex, itemIndex, rows, currentHeroMovie, openDetail, openDownload]);

  return (
    <div>
      <Sidebar activeIndex={sidebarIndex} focusedIndex={sidebarFocused ? sidebarIndex : null} onSelect={setSidebarIndex} />
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
                focusedIndex={!sidebarFocused && rowIndex === ri ? itemIndex : null}
                onSelect={(movie) => openMovie(movie)}
              />
            ))}
          </div>
        </>
      )}
      {view === "search" && (
        <Search movies={movies} onSelect={openMovie} progressFor={(movie) => continueWatchingPercent.get(movie.link)} />
      )}
      {view === "downloads" && <Downloads />}
      {openDetail && (
        <Detail
          movie={openDetail}
          downloaded={isDownloaded(openDetail, downloaded)}
          onPlay={() => handlePlayFromDetail(openDetail)}
          onDownload={() => handleDownloadFromDetail(openDetail)}
          onClose={() => setOpenDetail(null)}
        />
      )}
      {openDownload && (
        <DownloadModal
          pageUrl={getMoviePageLink(openDownload)}
          movieTitle={openDownload.tmdb?.tmdbTitle || openDownload.title}
          tmdbId={openDownload.tmdb?.tmdbId ? String(openDownload.tmdb.tmdbId) : null}
          onClose={() => setOpenDownload(null)}
          onDownloadStarted={() => getDownloadedMovies().then(setDownloaded)}
        />
      )}
    </div>
  );
}
