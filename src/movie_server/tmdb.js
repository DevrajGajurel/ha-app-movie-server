const TMDB_BASE = "https://api.themoviedb.org/3";
const POSTER_BASE = "https://image.tmdb.org/t/p/w342";
const cache = new Map();
let genreMap = null;

function looksLikeTv(title) {
  return /\b(season|s\d{1,2}\s*e\d{1,2}|series|episodes?|web\s*series|complete)\b/i.test(title);
}

function cleanTitle(title) {
  return title
    .replace(/\bseason\s*\d+.*$/i, "")
    .replace(/\bs\d{1,2}(\s*e\d{1,2})?.*$/i, "")
    .replace(/\b(s\d{1,2}\s*e\d{1,2}|season\s*\d+|episode\s*\d+|all\s*episodes?|complete|web\s*series)\b/gi, "")
    .replace(/\(\d{4}\).*$/, "")
    .replace(/\[.*?\]/g, "")
    .replace(/\b(720p|1080p|480p|4k|hd|hdr|web-?dl|bluray|cam|ts|hindi|english|dual audio|dubbed)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .split(/[|\-–]/)[0]
    .trim();
}

async function loadGenreMap(apiKey) {
  if (genreMap) return genreMap;

  const [movies, tv] = await Promise.all([
    fetch(`${TMDB_BASE}/genre/movie/list?api_key=${apiKey}`).then((r) => r.json()),
    fetch(`${TMDB_BASE}/genre/tv/list?api_key=${apiKey}`).then((r) => r.json()),
  ]);

  genreMap = new Map();
  for (const genre of [...(movies.genres || []), ...(tv.genres || [])]) {
    genreMap.set(genre.id, genre.name);
  }

  return genreMap;
}

function mapGenres(match, genres) {
  return (match.genre_ids || [])
    .map((id) => genres.get(id))
    .filter(Boolean);
}

function mapResult(match, genres) {
  if (match.media_type === "tv") {
    return {
      type: "tv",
      tmdbId: match.id,
      tmdbTitle: match.name,
      year: match.first_air_date?.slice(0, 4) || null,
      releaseDate: match.first_air_date || null,
      rating: match.vote_average ? Number(match.vote_average.toFixed(1)) : null,
      overview: match.overview || null,
      genres: mapGenres(match, genres),
      poster: match.poster_path ? `${POSTER_BASE}${match.poster_path}` : null,
      tmdbUrl: `https://www.themoviedb.org/tv/${match.id}`,
    };
  }

  return {
    type: "movie",
    tmdbId: match.id,
    tmdbTitle: match.title,
    year: match.release_date?.slice(0, 4) || null,
    releaseDate: match.release_date || null,
    rating: match.vote_average ? Number(match.vote_average.toFixed(1)) : null,
    overview: match.overview || null,
    genres: mapGenres(match, genres),
    poster: match.poster_path ? `${POSTER_BASE}${match.poster_path}` : null,
    tmdbUrl: `https://www.themoviedb.org/movie/${match.id}`,
  };
}

function pickBestMatch(candidates, originalTitle) {
  if (!candidates.length) return null;

  if (looksLikeTv(originalTitle)) {
    const tv = candidates.find((r) => r.media_type === "tv");
    if (tv) return tv;
  }

  return candidates.sort((a, b) => b.popularity - a.popularity)[0];
}

async function fetchSearch(apiKey, endpoint, query) {
  const url = new URL(`${TMDB_BASE}/search/${endpoint}`);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("query", query);
  url.searchParams.set("include_adult", "false");

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`TMDB search failed: ${res.status}`);
  }

  return res.json();
}

async function searchMedia(apiKey, title, genres) {
  const query = cleanTitle(title);
  if (!query) return null;

  const cacheKey = query;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const data = await fetchSearch(apiKey, "multi", query);
  const candidates = (data.results || []).filter(
    (r) => r.media_type === "movie" || r.media_type === "tv"
  );
  let match = pickBestMatch(candidates, title);

  if (looksLikeTv(title) && (!match || match.media_type === "movie")) {
    const tvData = await fetchSearch(apiKey, "tv", query);
    if (tvData.results?.[0]) {
      match = { ...tvData.results[0], media_type: "tv" };
    }
  } else if (!match) {
    const movieData = await fetchSearch(apiKey, "movie", query);
    if (movieData.results?.[0]) {
      match = { ...movieData.results[0], media_type: "movie" };
    }
  }

  const meta = match ? mapResult(match, genres) : null;
  cache.set(cacheKey, meta);
  return meta;
}

async function enrichMovies(movies, apiKey, concurrency = 5) {
  const genres = await loadGenreMap(apiKey);
  const enriched = [...movies];

  for (let i = 0; i < enriched.length; i += concurrency) {
    const batch = enriched.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map((movie) => searchMedia(apiKey, movie.title, genres).catch(() => null))
    );

    results.forEach((meta, j) => {
      enriched[i + j] = { ...enriched[i + j], tmdb: meta };
    });
  }

  return enriched;
}

module.exports = { cleanTitle, searchMedia, enrichMovies };
