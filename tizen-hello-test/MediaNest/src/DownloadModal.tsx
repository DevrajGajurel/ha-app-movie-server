import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  getDownloadOptions,
  getEpisodeDownloadOptions,
  getEpisodeFileToken,
  startDownload,
  startSeasonDownload,
  getJobs,
  type DownloadOption,
  type DownloadJob,
  type SeasonInfo,
} from "./api";

// Mirrors the dashboard's own parseSeasonHint (public/index.html) - a
// season range like "S1-S3" covering one file has no single correct
// season folder, so only an unambiguous single-season match is used.
function parseSeasonHint(text: string): { from: number; to: number } | null {
  const range = text.match(/S(\d{1,2})\s*-\s*S(\d{1,2})/i);
  if (range) return { from: Number.parseInt(range[1], 10), to: Number.parseInt(range[2], 10) };
  const single = text.match(/S(\d{1,2})/i);
  if (single) {
    const n = Number.parseInt(single[1], 10);
    return { from: n, to: n };
  }
  return null;
}

interface DownloadModalProps {
  pageUrl: string;
  movieTitle: string;
  // The raw scraped listing title (e.g. "Breaking Bad S05 (2012)..."),
  // distinct from movieTitle which prefers TMDB's clean title - only used
  // to guess a main-source TV listing's season when nothing more precise
  // (initialEpisode, from Detail's own episode grid) is available.
  scrapedTitle?: string;
  // Which listing site this came from - shegu's per-episode resolution
  // only applies to "secondary"; everything else (including undefined,
  // i.e. the main source) downloads a TV show the same way as a movie.
  source?: string;
  tmdbId: string | null;
  mediaType: "movie" | "tv";
  seasons?: SeasonInfo[];
  // Opens straight to this episode's quality options (e.g. from the Detail
  // page's episode grid) instead of starting at the season/episode picker.
  initialEpisode?: { seasonNumber: number; episodeNumber: number } | null;
  // Present only when initialEpisode is already downloaded - lets this
  // popup offer "Play" instead of only "Download" for it.
  onPlayExisting?: (fileToken: string) => void;
  onClose: () => void;
  onDownloadStarted: () => void;
}

type Stage =
  | { kind: "loading" }
  | { kind: "quality"; options: DownloadOption[] }
  | { kind: "direct"; options: DownloadOption[]; parentLabel: string }
  | { kind: "error"; message: string };

export function DownloadModal({
  pageUrl,
  movieTitle,
  scrapedTitle,
  source,
  tmdbId,
  mediaType,
  seasons,
  initialEpisode = null,
  onPlayExisting,
  onClose,
  onDownloadStarted,
}: DownloadModalProps) {
  const isTv = mediaType === "tv" && Boolean(seasons && seasons.length);
  const isSecondary = source === "secondary";
  // Only secondary-sourced TV gets shegu's per-episode picker - main-source
  // TV downloads the same whole-season file a movie's own page would give
  // it, just tagged with a season number (see mainSourceSeason below).
  const useShegu = isTv && isSecondary;

  // initialEpisode (set when opened from Detail's episode grid) reflects
  // the season the user actually navigated to there via TMDB-driven season
  // pills, which is authoritative over whatever season a scraped listing's
  // own title happens to mention - falls back to guessing from the raw
  // scraped title only when opened via the plain "Download" action
  // instead. A range like "S1-S3" covering one file has no single correct
  // season folder, so it's left untagged rather than guessed at.
  const mainSourceSeason = useMemo(() => {
    if (isTv && !isSecondary) {
      if (initialEpisode) return initialEpisode.seasonNumber;
      const hint = parseSeasonHint(scrapedTitle || "");
      if (hint && hint.from === hint.to) return hint.from;
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Movie flow state (unused when isTv) ----
  const [stage, setStage] = useState<Stage>({ kind: "loading" });
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [jobStatus, setJobStatus] = useState<Record<string, string>>({});
  const pollTimer = useRef<number | null>(null);

  // ---- TV flow state (unused when !isTv) ----
  const [seasonIdx, setSeasonIdx] = useState(() => {
    if (!initialEpisode) return 0;
    const idx = (seasons || []).findIndex((s) => s.seasonNumber === initialEpisode.seasonNumber);
    return idx >= 0 ? idx : 0;
  });
  const [episodeNum, setEpisodeNum] = useState(initialEpisode?.episodeNumber || 1);
  const [tvRow, setTvRow] = useState(0);
  // Tracks the seasonIdx this effect has already reacted to - starting it
  // at the initial seasonIdx (not a boolean "have we run yet" flag) makes
  // the skip-on-first-run check idempotent under React StrictMode's
  // dev-only double effect invocation, which would otherwise flip a plain
  // boolean guard on the first (discarded) pass and let the second pass
  // wipe out an initialEpisode's episode number before render.
  const lastSeasonIdxRef = useRef(seasonIdx);
  const [episodeOptions, setEpisodeOptions] = useState<DownloadOption[] | null>(null);
  const [episodeOptionsLoading, setEpisodeOptionsLoading] = useState(false);
  const [episodeOptionsError, setEpisodeOptionsError] = useState<string | null>(null);
  const [episodeJobStatus, setEpisodeJobStatus] = useState<Record<string, string>>({});
  const [seasonJobStatus, setSeasonJobStatus] = useState<string | null>(null);
  // Whether initialEpisode is already downloaded - if so, a "Play" row
  // appears above the season/episode picker instead of jumping straight to
  // quality options for something that's already here.
  const [existingToken, setExistingToken] = useState<string | null>(null);
  const [checkingExisting, setCheckingExisting] = useState(Boolean(useShegu && initialEpisode));

  const seasonList = seasons || [];
  const currentSeason = seasonList[seasonIdx];

  // TV rows, in focus order. A "Play" row only exists (and only shifts
  // everything else down by one) once we know initialEpisode is already
  // downloaded - computed here rather than as module constants so they stay
  // correct whether or not that row is present.
  const rowOffset = existingToken ? 1 : 0;
  const ROW_PLAY = 0;
  const ROW_SEASON = rowOffset;
  const ROW_DOWNLOAD_SEASON = rowOffset + 1;
  const ROW_EPISODE = rowOffset + 2;
  const ROW_LOAD_EPISODE = rowOffset + 3;

  useEffect(() => {
    if (useShegu) return; // shegu resolves by tmdbId/season/episode, not a scraped page
    getDownloadOptions(pageUrl)
      .then((data) => setStage(data.options.length ? { kind: "quality", options: data.options } : { kind: "error", message: "No download links found on this page." }))
      .catch((err) => setStage({ kind: "error", message: err.message }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageUrl, useShegu]);

  useEffect(() => {
    return () => {
      if (pollTimer.current) window.clearInterval(pollTimer.current);
    };
  }, []);

  // Changing season resets any loaded episode options and clamps the
  // episode number to the new season's episode count - but not on the very
  // first render, which would otherwise immediately wipe out an
  // initialEpisode's episode number before the user ever touched anything.
  useEffect(() => {
    if (!useShegu || lastSeasonIdxRef.current === seasonIdx) return;
    lastSeasonIdxRef.current = seasonIdx;
    setEpisodeNum(1);
    setEpisodeOptions(null);
  }, [useShegu, seasonIdx]);

  // Opened from the Detail page's episode grid: check whether this exact
  // episode is already downloaded first. If so, show the "Play" row instead
  // of jumping straight to quality options for something that's already
  // here; if not, jump straight to quality options as before.
  useEffect(() => {
    if (!useShegu || !initialEpisode || !tmdbId) {
      setCheckingExisting(false);
      return;
    }
    let cancelled = false;
    getEpisodeFileToken(tmdbId, movieTitle, initialEpisode.seasonNumber, initialEpisode.episodeNumber).then((token) => {
      if (cancelled) return;
      setCheckingExisting(false);
      if (token) {
        setExistingToken(token);
      } else {
        loadEpisodeOptions();
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pickQuality(option: DownloadOption) {
    setStage({ kind: "loading" });
    getDownloadOptions(option.href, "direct")
      .then((data) =>
        setStage(
          data.options.length
            ? { kind: "direct", options: data.options, parentLabel: option.label }
            : { kind: "error", message: "No direct download links found." }
        )
      )
      .catch((err) => setStage({ kind: "error", message: err.message }));
    setFocusedIndex(0);
  }

  function pickDirect(option: DownloadOption) {
    setJobStatus((prev) => ({ ...prev, [option.href]: "Starting…" }));
    startDownload({
      url: option.href,
      label: option.label,
      movieTitle,
      tmdbId,
      season: mainSourceSeason ?? undefined,
    })
      .then((job) => {
        setJobStatus((prev) => ({ ...prev, [option.href]: "Queued…" }));
        pollJob(job.id, (status) => setJobStatus((prev) => ({ ...prev, [option.href]: status })));
        onDownloadStarted();
      })
      .catch((err) => setJobStatus((prev) => ({ ...prev, [option.href]: "Failed: " + err.message })));
  }

  function pollJob(jobId: number, onUpdate: (status: string) => void) {
    if (pollTimer.current) window.clearInterval(pollTimer.current);
    pollTimer.current = window.setInterval(async () => {
      const jobs = await getJobs();
      const job = jobs.find((j: DownloadJob) => j.id === jobId);
      if (!job) return;
      if (job.status === "completed") {
        onUpdate("Saved");
        if (pollTimer.current) window.clearInterval(pollTimer.current);
      } else if (job.status === "failed") {
        onUpdate("Failed: " + (job.error || "unknown error"));
        if (pollTimer.current) window.clearInterval(pollTimer.current);
      } else if (job.totalBytes > 0) {
        onUpdate(`Downloading… ${Math.round((job.receivedBytes / job.totalBytes) * 100)}%`);
      } else {
        onUpdate("Downloading…");
      }
    }, 1500);
  }

  function downloadEntireSeason() {
    if (!tmdbId || !currentSeason) return;
    setSeasonJobStatus("Starting…");
    startSeasonDownload({
      tmdbId,
      season: currentSeason.seasonNumber,
      episodeCount: currentSeason.episodeCount,
      movieTitle,
    })
      .then((job) => {
        setSeasonJobStatus("Queued…");
        pollJob(job.id, setSeasonJobStatus);
        onDownloadStarted();
      })
      .catch((err) => setSeasonJobStatus("Failed: " + err.message));
  }

  function loadEpisodeOptions() {
    if (!tmdbId || !currentSeason) return;
    setEpisodeOptionsLoading(true);
    setEpisodeOptions(null);
    setEpisodeOptionsError(null);
    getEpisodeDownloadOptions(tmdbId, currentSeason.seasonNumber, episodeNum)
      .then((data) => {
        setEpisodeOptions(data.options);
        setEpisodeOptionsLoading(false);
        setTvRow(ROW_LOAD_EPISODE + 1);
      })
      .catch((err) => {
        setEpisodeOptionsLoading(false);
        setEpisodeOptions([]);
        setEpisodeOptionsError(err.message);
      });
  }

  function pickEpisodeDirect(option: DownloadOption) {
    if (!currentSeason) return;
    setEpisodeJobStatus((prev) => ({ ...prev, [option.href]: "Starting…" }));
    // movieTitle stays the plain series title (not "+SxxEyy") so this nests
    // under Series (tmdb-id)/S0X/ like the season-batch downloader, instead
    // of creating its own separate flat folder per episode.
    startDownload({
      url: option.href,
      label: option.label,
      movieTitle,
      tmdbId,
      season: currentSeason.seasonNumber,
      episode: episodeNum,
    })
      .then((job) => {
        setEpisodeJobStatus((prev) => ({ ...prev, [option.href]: "Queued…" }));
        pollJob(job.id, (status) => setEpisodeJobStatus((prev) => ({ ...prev, [option.href]: status })));
        onDownloadStarted();
      })
      .catch((err) => setEpisodeJobStatus((prev) => ({ ...prev, [option.href]: "Failed: " + err.message })));
  }

  const options = stage.kind === "quality" ? stage.options : stage.kind === "direct" ? stage.options : [];

  // ---- Movie-flow keyboard nav (also main-source TV) ----
  useEffect(() => {
    if (useShegu) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.keyCode === 10009 || e.keyCode === 27) {
        if (stage.kind === "direct") {
          setStage({ kind: "loading" });
          getDownloadOptions(pageUrl).then((data) => setStage({ kind: "quality", options: data.options }));
          setFocusedIndex(0);
        } else {
          onClose();
        }
        return;
      }
      if (!options.length) return;
      if (e.keyCode === 40) setFocusedIndex((i) => Math.min(options.length - 1, i + 1));
      else if (e.keyCode === 38) setFocusedIndex((i) => Math.max(0, i - 1));
      else if (e.keyCode === 13) {
        const option = options[focusedIndex];
        if (!option) return;
        if (stage.kind === "quality") pickQuality(option);
        else pickDirect(option);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useShegu, stage, focusedIndex, options.length, pageUrl]);

  // ---- TV-flow keyboard nav (shegu only) ----
  useEffect(() => {
    if (!useShegu) return;
    const episodeRowCount = episodeOptions ? episodeOptions.length : 0;
    const maxRow = ROW_LOAD_EPISODE + episodeRowCount;

    function onKeyDown(e: KeyboardEvent) {
      if (e.keyCode === 10009 || e.keyCode === 27) {
        onClose();
        return;
      }
      if (e.keyCode === 40) {
        setTvRow((r) => Math.min(maxRow, r + 1));
        return;
      }
      if (e.keyCode === 38) {
        setTvRow((r) => Math.max(0, r - 1));
        return;
      }
      if (e.keyCode === 37 || e.keyCode === 39) {
        const dir = e.keyCode === 39 ? 1 : -1;
        if (tvRow === ROW_SEASON) {
          setSeasonIdx((i) => Math.min(seasonList.length - 1, Math.max(0, i + dir)));
        } else if (tvRow === ROW_EPISODE && currentSeason) {
          setEpisodeNum((n) => Math.min(currentSeason.episodeCount, Math.max(1, n + dir)));
        }
        return;
      }
      if (e.keyCode === 13) {
        if (existingToken && tvRow === ROW_PLAY) onPlayExisting?.(existingToken);
        else if (tvRow === ROW_DOWNLOAD_SEASON) downloadEntireSeason();
        else if (tvRow === ROW_LOAD_EPISODE) loadEpisodeOptions();
        else if (episodeOptions && tvRow >= ROW_LOAD_EPISODE + 1) {
          const option = episodeOptions[tvRow - ROW_LOAD_EPISODE - 1];
          if (option) pickEpisodeDirect(option);
        }
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useShegu, tvRow, seasonIdx, episodeNum, currentSeason, episodeOptions, seasonList.length, existingToken]);

  if (useShegu) {
    return (
      <div className="download-popup-backdrop">
        <div className="download-popup" role="dialog" aria-labelledby="download-popup-title">
          <h2 id="download-popup-title" className="download-popup-title">{movieTitle}</h2>

          {checkingExisting ? <p className="download-popup-hint">Checking…</p> : null}

          {existingToken ? (
            <button
              type="button"
              className={"tv-picker-btn" + (tvRow === ROW_PLAY ? " focused" : "")}
              onClick={() => onPlayExisting?.(existingToken)}
            >
              ▶ Play S{String(initialEpisode?.seasonNumber).padStart(2, "0")}E
              {String(initialEpisode?.episodeNumber).padStart(2, "0")}
            </button>
          ) : null}

          <div className={"tv-picker-row" + (tvRow === ROW_SEASON ? " focused" : "")}>
            <span className="tv-picker-label">Season</span>
            <span className="tv-picker-value">◀ {currentSeason?.name || `Season ${seasonIdx + 1}`} ▶</span>
          </div>

          <button
            type="button"
            className={"tv-picker-btn" + (tvRow === ROW_DOWNLOAD_SEASON ? " focused" : "")}
            onClick={downloadEntireSeason}
          >
            Download entire season ({currentSeason?.episodeCount ?? 0} episodes)
          </button>
          {seasonJobStatus && <p className="download-popup-hint">{seasonJobStatus}</p>}

          <div className={"tv-picker-row" + (tvRow === ROW_EPISODE ? " focused" : "")}>
            <span className="tv-picker-label">Episode</span>
            <span className="tv-picker-value">◀ Episode {episodeNum} ▶</span>
          </div>

          <button
            type="button"
            className={"tv-picker-btn" + (tvRow === ROW_LOAD_EPISODE ? " focused" : "")}
            onClick={loadEpisodeOptions}
          >
            {episodeOptionsLoading ? "Loading…" : "Find this episode's downloads"}
          </button>

          {episodeOptionsError && (
            <p className="download-popup-hint">{episodeOptionsError}</p>
          )}
          {episodeOptions && episodeOptions.length === 0 && !episodeOptionsLoading && !episodeOptionsError && (
            <p className="download-popup-hint">No download links found for this episode.</p>
          )}

          {episodeOptions && episodeOptions.length > 0 && (
            <ul className="download-popup-list">
              {episodeOptions.map((option, i) => (
                <li
                  key={option.href}
                  className={"download-popup-option" + (tvRow === ROW_LOAD_EPISODE + 1 + i ? " focused" : "")}
                >
                  {option.label}
                  {episodeJobStatus[option.href] ? <span className="download-popup-status"> — {episodeJobStatus[option.href]}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    );
  }

  // Some seasons are split into "Part-01 (Ep.01-06)"/"Part-02"/... batches
  // rather than one file per quality tier (see findPartLabel in main.js) -
  // the backend already groups options by part in page order, so this just
  // watches for the part value changing between consecutive options to
  // know where to insert a header.
  let lastPart: string | null | undefined;

  return (
    <div className="download-popup-backdrop">
      <div className="download-popup" role="dialog" aria-labelledby="download-popup-title">
        <h2 id="download-popup-title" className="download-popup-title">{movieTitle}</h2>
        {stage.kind === "loading" && <p className="download-popup-hint">Loading…</p>}
        {stage.kind === "error" && <p className="download-popup-hint">{stage.message}</p>}
        {(stage.kind === "quality" || stage.kind === "direct") && (
          <ul className="download-popup-list">
            {stage.kind === "direct" && <p className="download-popup-hint">{stage.parentLabel}</p>}
            {options.flatMap((option, i) => {
              const nodes: ReactNode[] = [];
              if (option.part && option.part !== lastPart) {
                nodes.push(
                  <li key={`part-${option.part}`} className="download-popup-part-header">
                    {option.part}
                  </li>
                );
              }
              lastPart = option.part ?? null;
              nodes.push(
                <li key={option.href} className={"download-popup-option" + (i === focusedIndex ? " focused" : "")}>
                  {option.label}
                  {jobStatus[option.href] ? <span className="download-popup-status"> — {jobStatus[option.href]}</span> : null}
                </li>
              );
              return nodes;
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
