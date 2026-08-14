// Same backend HelloTV already talks to - see
// tizen-hello-test/HelloTV/js/tv-config.js. No new backend needed for this
// app; it's the identical movie-server instance.
const API_BASE = "http://192.168.1.88:3001/";

function apiUrl(path: string): string {
  return `${API_BASE}api/${path.replace(/^\//, "")}`;
}

export interface DownloadLibraryItem {
  folder: string;
  tmdbId: string | null;
  title: string;
  downloadedAt: string | null;
  // Backend infers this from a season subfolder (S01, S02, ...) on disk -
  // TMDB movie and TV ids aren't in the same namespace, so a bare tmdbId
  // alone can't tell a downloaded movie apart from an unrelated TV show
  // that happens to share the same numeric id.
  type: "movie" | "tv";
}

export interface DownloadLibrary {
  downloadDir: string;
  tmdbIds: string[];
  titles: string[];
  items: DownloadLibraryItem[];
}

export interface DownloadedMovie {
  tmdbId: string | null;
  title: string;
  downloadedAt: string | null;
  type: "movie" | "tv";
}

// scanLibrary() on the backend reports one entry per downloaded folder,
// each with its own tmdbId/title/downloadedAt - kept around for
// isDownloaded() checks (a movie in the full catalog isn't necessarily
// downloaded yet) and for sorting the Recently Downloaded row.
export async function getDownloadedMovies(): Promise<DownloadedMovie[]> {
  const res = await fetch(apiUrl("downloads/library"));
  if (!res.ok) throw new Error(`Failed to load library: ${res.status}`);
  const data: DownloadLibrary = await res.json();
  return (data.items || []).map((item) => ({
    tmdbId: item.tmdbId,
    title: item.title,
    downloadedAt: item.downloadedAt,
    type: item.type,
  }));
}

// Matches a downloaded-library entry back to its full catalog Movie (same
// tmdbId-first-then-normalized-title rule as isDownloaded()), for rows that
// need the actual metadata (poster/backdrop) of what's been downloaded.
export function matchMovieForDownload(item: DownloadedMovie, movies: Movie[]): Movie | undefined {
  if (item.tmdbId) {
    const byId = movies.find((m) => m.tmdb?.tmdbId != null && String(m.tmdb.tmdbId) === item.tmdbId);
    if (byId) return byId;
  }
  const normalized = normalizeTitle(item.title);
  return movies.find((m) => normalizeTitle(m.tmdb?.tmdbTitle || m.title) === normalized);
}

// Builds a playable Movie for every downloaded folder: catalog match first
// (so TMDB posters/backdrops come through), otherwise a library-only stub
// keyed by tmdbId/title so playback still works.
export function libraryItemToMovie(item: DownloadedMovie, movies: Movie[]): Movie {
  const existing = matchMovieForDownload(item, movies);
  const key = item.tmdbId || normalizeTitle(item.title) || item.title;
  if (existing) {
    return existing;
  }
  const title = item.title || "Downloaded movie";
  const tmdbId = item.tmdbId ? Number(item.tmdbId) : null;
  return {
    title,
    link: `library:${key}`,
    tmdb: tmdbId
      ? {
          tmdbId,
          tmdbTitle: title,
          type: item.type,
          poster: null,
          backdrop: null,
          rating: null,
          year: null,
          genres: [],
          overview: null,
          tagline: null,
          runtimeMinutes: null,
          certification: null,
          director: null,
          trailerKey: null,
        }
      : undefined,
  };
}

export function getLibraryMovies(downloaded: DownloadedMovie[], movies: Movie[]): Movie[] {
  const seen = new Set<string>();
  const result: Movie[] = [];
  const sorted = [...downloaded].sort((a, b) => (a.title || "").localeCompare(b.title || ""));
  for (const item of sorted) {
    const movie = libraryItemToMovie(item, movies);
    const id = movie.tmdb?.tmdbId ? `tmdb:${movie.tmdb.tmdbId}` : movie.link;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(movie);
  }
  return result;
}

export interface ProgressItem {
  folder: string;
  tmdbId: string | null;
  title: string;
  positionSeconds: number;
  durationSeconds: number;
  percent: number;
  updatedAt: string | null;
}

// No tmdbId/title/file params -> the backend's Continue Watching list
// (already sorted most-recent-first, already excludes finished/near-
// finished titles - see fileDownloads.js's listProgress).
export async function getContinueWatching(): Promise<ProgressItem[]> {
  const res = await fetch(apiUrl("downloads/progress"));
  if (!res.ok) return [];
  const data = await res.json();
  return data.items || [];
}

// A progress item only carries tmdbId/title (whatever the download folder
// itself was keyed by) - this recovers the full catalog Movie (poster,
// backdrop, etc.) it corresponds to, same matching rule as isDownloaded().
export function matchMovieForProgress(item: ProgressItem, movies: Movie[]): Movie | undefined {
  if (item.tmdbId) {
    const byId = movies.find((m) => m.tmdb?.tmdbId != null && String(m.tmdb.tmdbId) === item.tmdbId);
    if (byId) return byId;
  }
  const normalized = normalizeTitle(item.title);
  return movies.find((m) => normalizeTitle(m.tmdb?.tmdbTitle || m.title) === normalized);
}

// Direct-by-id TMDB lookup for a downloaded library item whose match against
// the currently loaded catalog (matchMovieForDownload) failed - typically an
// older download that's since rotated off the scraped listing's cached
// pages, so it never got a poster/backdrop any other way. Returns null on
// any failure (not configured, not found, offline) so callers can just fall
// back to the posterless stub they already had.
export async function getTmdbById(tmdbId: string, type?: "movie" | "tv"): Promise<TmdbInfo | null> {
  try {
    const params = new URLSearchParams({ id: tmdbId });
    if (type) params.set("type", type);
    const res = await fetch(apiUrl(`tmdb?${params.toString()}`));
    if (!res.ok) return null;
    return (await res.json()) as TmdbInfo;
  } catch {
    return null;
  }
}

export interface SeasonInfo {
  seasonNumber: number;
  episodeCount: number;
  name: string;
}

export interface TmdbInfo {
  tmdbId: number;
  tmdbTitle: string;
  type: "movie" | "tv";
  poster: string | null;
  backdrop: string | null;
  rating: number | null;
  year: string | null;
  genres: string[];
  overview: string | null;
  tagline: string | null;
  runtimeMinutes: number | null;
  certification: string | null;
  director: string | null;
  trailerKey: string | null;
  numberOfSeasons?: number | null;
  seasons?: SeasonInfo[];
}

export interface Movie {
  title: string;
  link: string;
  sourceOrder?: number;
  tmdb?: TmdbInfo;
}

function normalizeTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/\(tmdb-\d+\)/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Mirrors HelloTV's isAlreadyDownloaded(): match by tmdbId first (more
// reliable), falling back to a normalized-title comparison for titles that
// never got a TMDB match.
export function isDownloaded(movie: Movie, downloadedList: DownloadedMovie[]): boolean {
  const tmdbId = movie.tmdb?.tmdbId ? String(movie.tmdb.tmdbId) : null;
  if (tmdbId && downloadedList.some((d) => d.tmdbId === tmdbId)) return true;
  const title = normalizeTitle(movie.tmdb?.tmdbTitle || movie.title);
  return downloadedList.some((d) => !d.tmdbId && normalizeTitle(d.title) === title);
}

// Mirrors HelloTV's getMoviePageLink(): the scraper's own "link" field is
// the source page to fetch download options from - except for
// library-only entries (no such page, they're already downloaded), which
// use a "library:" pseudo-link that must never be treated as a real URL.
export function getMoviePageLink(movie: Movie): string {
  return movie.link && !movie.link.startsWith("library:") ? movie.link : "";
}

// Removes every downloaded folder matching this movie (all quality/language
// versions at once, same granularity the backend's isDownloaded/library
// checks already use) - not a per-file operation.
export async function deleteMedia(tmdbId: string | null, title: string): Promise<{ deletedDirs: number }> {
  const params = new URLSearchParams();
  if (tmdbId) params.set("tmdbId", tmdbId);
  params.set("title", title);
  const res = await fetch(apiUrl(`downloads/media?${params.toString()}`), { method: "DELETE" });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// The trailer stream is a live YouTube-resolve-and-remux passthrough (see
// main.js's /api/trailer), not a YouTube iframe embed - playable through a
// plain <video> the same way a downloaded movie plays through one.
export function buildTrailerUrl(trailerKey: string): string {
  return apiUrl(`trailer?key=${encodeURIComponent(trailerKey)}`);
}

export interface Config {
  maxPages: number;
  initialPages: number;
  tmdbEnabled?: boolean;
}

export async function getConfig(): Promise<Config> {
  const res = await fetch(apiUrl("config"));
  if (!res.ok) throw new Error(`Failed to load config: ${res.status}`);
  return res.json();
}

async function getMoviesPage(from: number, to: number): Promise<{ movies: Movie[]; tmdbEnabled: boolean }> {
  const res = await fetch(apiUrl(`movies?from=${from}&to=${to}`));
  if (!res.ok) throw new Error(`Failed to load movies: ${res.status}`);
  return res.json();
}

// Same pagination pattern as HelloTV's fetchPageRange/mergeMovies: the
// scraper only exposes a page range, not a single "give me everything"
// endpoint, so this walks pages 1..maxPages and flattens them, deduping by
// link (a title can legitimately repeat across pages during a rescrape).
export async function getAllMovies(): Promise<Movie[]> {
  const config = await getConfig();
  const { movies: firstPage } = await getMoviesPage(1, config.maxPages);
  const seen = new Set<string>();
  const result: Movie[] = [];
  for (const movie of firstPage) {
    if (seen.has(movie.link)) continue;
    seen.add(movie.link);
    result.push(movie);
  }
  return result;
}

export interface AudioTrack {
  index: number;
  language: string | null;
  title: string | null;
  codec: string | null;
  channels: number | null;
}

export interface SubtitleTrack {
  index: number;
  codec: string | null;
  language: string | null;
  title: string | null;
}

export interface MediaVersion {
  token: string;
  filename: string;
  size: number;
  duration: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioTracks: AudioTrack[];
  subtitleTracks: SubtitleTrack[];
}

export async function getVersions(tmdbId: string | null, title: string): Promise<MediaVersion[]> {
  const params = new URLSearchParams();
  if (tmdbId) params.set("tmdbId", tmdbId);
  params.set("title", title);
  const res = await fetch(apiUrl(`downloads/versions?${params.toString()}`));
  if (!res.ok) throw new Error(`Failed to load versions: ${res.status}`);
  const data = await res.json();
  return data.versions || [];
}

// raw=1 is load-bearing here, not optional: it bypasses the server's
// eac3->AAC auto-transcode (added for the <video>-element app, which can't
// decode Dolby Digital/Plus at all) and the track-switch remux path, both
// unnecessary once AVPlay is reading the container natively - and both
// would otherwise strip down to a single audio track, breaking
// selectAudioTrack()'s ability to switch between embedded tracks.
export function buildPlayUrl(tmdbId: string | null, title: string, fileToken?: string | null): string {
  const params = new URLSearchParams();
  if (tmdbId) params.set("tmdbId", tmdbId);
  params.set("title", title);
  if (fileToken) params.set("file", fileToken);
  params.set("raw", "1");
  return apiUrl(`downloads/play?${params.toString()}`);
}

export interface SavedProgress {
  positionSeconds: number;
  durationSeconds: number;
  audioTrack: number;
  subtitleTrack: number | null;
}

export async function getProgress(tmdbId: string | null, title: string, fileToken?: string | null): Promise<SavedProgress | null> {
  const params = new URLSearchParams();
  if (tmdbId) params.set("tmdbId", tmdbId);
  params.set("title", title);
  if (fileToken) params.set("file", fileToken);
  const res = await fetch(apiUrl(`downloads/progress?${params.toString()}`));
  if (!res.ok) return null;
  const data = await res.json();
  return data.progress ?? null;
}

export function saveProgress(args: {
  tmdbId: string | null;
  title: string;
  fileToken?: string | null;
  positionSeconds: number;
  durationSeconds: number;
  audioTrack: number;
  subtitleTrack: number | null;
}): void {
  fetch(apiUrl("downloads/progress"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tmdbId: args.tmdbId,
      title: args.title,
      file: args.fileToken,
      positionSeconds: args.positionSeconds,
      durationSeconds: args.durationSeconds,
      audioTrack: args.audioTrack,
      subtitleTrack: args.subtitleTrack,
    }),
  }).catch(() => {
    /* best-effort */
  });
}

export interface DownloadOption {
  label: string;
  href: string;
}

export interface SelectorDebug {
  selector: string;
  matches: number;
}

export async function getDownloadOptions(pageUrl: string, type?: "direct"): Promise<{ options: DownloadOption[]; selectors: SelectorDebug[] }> {
  const params = new URLSearchParams({ url: pageUrl });
  if (type) params.set("type", type);
  const res = await fetch(apiUrl(`downloads?${params.toString()}`));
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

export interface DownloadJob {
  id: number;
  url: string;
  label: string;
  movieTitle: string;
  tmdbId: string | null;
  status: "queued" | "downloading" | "completed" | "failed";
  receivedBytes: number;
  totalBytes: number;
  filePath: string | null;
  error: string | null;
}

export async function startDownload(args: {
  url: string;
  label: string;
  movieTitle: string;
  tmdbId: string | null;
  season?: number;
  episode?: number;
}): Promise<DownloadJob> {
  const res = await fetch(apiUrl("downloads/save"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data.job;
}

// Single-episode direct links, resolved via shegu.st by tmdbId - same
// backend path the dashboard's episode picker uses (source=secondary).
export async function getEpisodeDownloadOptions(
  tmdbId: string,
  season: number,
  episode: number
): Promise<{ options: DownloadOption[] }> {
  const params = new URLSearchParams({
    source: "secondary",
    tmdbId,
    mediaType: "tv",
    season: String(season),
    episode: String(episode),
  });
  const res = await fetch(apiUrl(`downloads?${params.toString()}`));
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

export interface EpisodeDetail {
  episodeNumber: number;
  name: string;
  overview: string | null;
  still: string | null;
  airDate: string | null;
  rating: number | null;
}

// Per-episode name/overview/still for the Detail page's episode grid -
// separate from TmdbInfo.seasons (which only has seasonNumber/episodeCount/
// name), since TMDB only returns this via a dedicated per-season call.
export async function getSeasonEpisodeDetails(tmdbId: string, season: number): Promise<EpisodeDetail[]> {
  const params = new URLSearchParams({ id: tmdbId, season: String(season) });
  const res = await fetch(apiUrl(`tmdb/season?${params.toString()}`));
  if (!res.ok) return [];
  const data = await res.json();
  return data.episodes || [];
}

// Queues every episode of a season (server downloads up to 5 in parallel) -
// each episode's own quality/fallback links are resolved server-side.
export async function startSeasonDownload(args: {
  tmdbId: string;
  season: number;
  episodeCount: number;
  movieTitle: string;
}): Promise<DownloadJob> {
  const res = await fetch(apiUrl("downloads/season"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data.job;
}

export async function getJobs(): Promise<DownloadJob[]> {
  const res = await fetch(apiUrl("downloads/jobs"));
  if (!res.ok) return [];
  const data = await res.json();
  return data.jobs || [];
}

// Re-runs a completed/failed job (same URL/candidates, or same
// tmdbId/season/episodeCount for a season job) - works even across a
// restart since job history now survives in Redis.
export async function redownloadJob(jobId: number): Promise<DownloadJob> {
  const res = await fetch(apiUrl("downloads/redownload"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data.job;
}

export async function cancelJob(jobId: number): Promise<void> {
  const res = await fetch(apiUrl("downloads/cancel"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || res.statusText);
  }
}

export function reportClientError(source: string, message: string, context?: Record<string, unknown>): void {
  fetch(apiUrl("client-log"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source, message, context: context || null }),
  }).catch(() => {
    /* best-effort */
  });
}
