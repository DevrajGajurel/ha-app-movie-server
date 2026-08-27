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
  // Most recently downloaded first, matching Home's own "Recently
  // Downloaded" row - previously sorted alphabetically, which buried a
  // just-downloaded title wherever its letter happened to fall instead of
  // showing it up front. Falls back to title for items missing a
  // downloadedAt (shouldn't normally happen - scanLibrary always sets it -
  // but keeps the order stable rather than clustering unknowns randomly).
  const sorted = [...downloaded].sort((a, b) => {
    const timeA = a.downloadedAt ? Date.parse(a.downloadedAt) : 0;
    const timeB = b.downloadedAt ? Date.parse(b.downloadedAt) : 0;
    if (timeB !== timeA) return timeB - timeA;
    return (a.title || "").localeCompare(b.title || "");
  });
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
  type: "movie" | "tv";
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

// Same "catalog match, else posterless stub" fallback as libraryItemToMovie
// - a title that's rotated off the scraped listing's currently-loaded pages
// (common for anything watched over more than a few days, e.g. a season
// binged episode by episode) previously vanished from Continue Watching
// entirely instead of showing up without art.
export function progressItemToMovie(item: ProgressItem, movies: Movie[]): Movie {
  const existing = matchMovieForProgress(item, movies);
  if (existing) return existing;
  const key = item.tmdbId || normalizeTitle(item.title) || item.title;
  const title = item.title || "In progress";
  const tmdbId = item.tmdbId ? Number(item.tmdbId) : null;
  return {
    title,
    link: `progress:${key}`,
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

export interface TmdbSuggestion {
  tmdbId: number;
  type: "movie" | "tv";
  title: string;
  year: string | null;
  poster: string | null;
}

// Live type-ahead suggestions for the search box - same TMDB-backed
// endpoint the dashboard's search box already uses (/api/tmdb/suggest),
// so MediaNest's search can help correct/refine a query the same way
// instead of only ever matching the locally scraped catalog's own titles
// verbatim. Selecting a suggestion fills in its title rather than jumping
// straight to a TMDB-only result - a title only found via TMDB has no
// scraped source page to download from, so there's nothing to open yet.
export async function getTmdbSuggestions(query: string): Promise<TmdbSuggestion[]> {
  try {
    const res = await fetch(apiUrl(`tmdb/suggest?q=${encodeURIComponent(query)}`));
    if (!res.ok) return [];
    const data = await res.json();
    return data.results || [];
  } catch {
    return [];
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
  // Which listing site this was scraped from - undefined/absent means the
  // main source, "secondary" means the 4khdhub/shegu-backed one. TV
  // downloads only use shegu's per-episode resolution for secondary-
  // sourced shows; main-source TV downloads the same way a movie does.
  source?: string;
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
    // Keyed by TMDB identity when there is one, not just the scraped page
    // URL - the same title is often re-listed multiple times at different
    // quality tiers (confirmed real bug: "The Last Sunrise" appearing
    // twice in Top 10 Movies), each with its own distinct .link but
    // matching the same TMDB entry, so deduping by .link alone let both
    // through. Falls back to .link for anything without a TMDB match,
    // since there's no better identity signal for those.
    const key = movie.tmdb?.tmdbId ? `tmdb:${movie.tmdb.tmdbId}` : movie.link;
    if (seen.has(key)) continue;
    seen.add(key);
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
  // Set when a season is split into "Part-01 (Ep.01-06)"/"Part-02"/... batches
  // rather than one file per quality tier - see findPartLabel in main.js.
  part?: string | null;
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
  part?: string | null;
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
  // Minutes, from TMDB - null when TMDB has no runtime for this episode.
  // Used to estimate where this episode starts inside a season-pack part
  // (see estimateEpisodeOffsets in Detail.tsx).
  runtimeMinutes: number | null;
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

// Looks up a specific episode's file token (if downloaded) - unlike a plain
// tmdbId/title match (which just returns the largest file the whole series
// has anywhere), this can tell "this exact episode is downloaded" from
// "it isn't", so the episode grid can play instead of opening the download
// flow.
export async function getEpisodeFileToken(
  tmdbId: string | null,
  title: string,
  season: number,
  episode: number
): Promise<string | null> {
  try {
    const params = new URLSearchParams({ title, season: String(season), episode: String(episode) });
    if (tmdbId) params.set("tmdbId", tmdbId);
    const res = await fetch(apiUrl(`downloads/episode-file?${params.toString()}`));
    if (!res.ok) return null;
    const data = await res.json();
    return data.token || null;
  } catch {
    return null;
  }
}

// Which episode numbers of a season are already downloaded - one call per
// season shown, for a "downloaded" badge on each episode card (mirrors
// PosterCard's own downloaded/play-icon indicator).
export async function getDownloadedEpisodes(tmdbId: string | null, title: string, season: number): Promise<Set<number>> {
  try {
    const params = new URLSearchParams({ title, season: String(season) });
    if (tmdbId) params.set("tmdbId", tmdbId);
    const res = await fetch(apiUrl(`downloads/season-status?${params.toString()}`));
    if (!res.ok) return new Set();
    const data = await res.json();
    return new Set((data.episodes || []) as number[]);
  } catch {
    return new Set();
  }
}

export interface SeasonPackPart {
  token: string;
  // null when the season was downloaded as one single whole-season file
  // rather than split into "Part-01"/"Part-02"/... batches.
  part: string | null;
  // The episode range this part covers (e.g. 1-6), when the source listed
  // one at download time - null if unknown, in which case per-episode
  // seeking within this part isn't possible (only "Play <part>" as a whole).
  episodeFrom: number | null;
  episodeTo: number | null;
  // The part file's actual runtime, probed once server-side - used with
  // each covered episode's TMDB runtime to estimate where it starts.
  durationSeconds: number | null;
}

// Whether this season has one or more whole-season files on disk (main-
// source TV downloads publish exactly this - one file per season, no per-
// episode links, possibly split into parts - see v1.7.23/v1.7.24) - lets the
// season view offer a "Play all episodes" (or one "Play Part-NN" per part)
// option only when those files actually exist, rather than assuming every
// season works like a shegu-downloaded one where the episodes are separate
// files.
export async function getSeasonPackParts(tmdbId: string | null, title: string, season: number): Promise<SeasonPackPart[]> {
  try {
    const params = new URLSearchParams({ title, season: String(season) });
    if (tmdbId) params.set("tmdbId", tmdbId);
    const res = await fetch(apiUrl(`downloads/season-pack?${params.toString()}`));
    if (!res.ok) return [];
    const data = await res.json();
    return data.parts || [];
  } catch {
    return [];
  }
}

export interface SeriesResumePoint {
  fileToken: string;
  positionSeconds: number;
  durationSeconds: number;
}

// The one "continue watching" point for a whole series, however many
// seasons/episodes it has - used to decide whether the Detail page's
// primary action should say "Play" (start at S1E1) or "Continue Watching"
// (resume this exact file/position).
export async function getSeriesResume(tmdbId: string | null, title: string): Promise<SeriesResumePoint | null> {
  try {
    const params = new URLSearchParams({ title });
    if (tmdbId) params.set("tmdbId", tmdbId);
    const res = await fetch(apiUrl(`downloads/series-resume?${params.toString()}`));
    if (!res.ok) return null;
    const data = await res.json();
    return data.fileToken ? data : null;
  } catch {
    return null;
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
