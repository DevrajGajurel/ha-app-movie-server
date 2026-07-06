const TMDB_BASE = "https://api.themoviedb.org/3";
const POSTER_BASE = "https://image.tmdb.org/t/p/w342";
const MIN_MATCH_SCORE = 0.52;
const cache = new Map();
let genreMap = null;

const NOISE_PATTERN =
  /\b(720p|1080p|480p|2160p|4k|uhd|hd|hdr|web-?dl|bluray|blu-?ray|cam|ts|tc|dvdrip|brrip|hdcam|hdrip|x264|x265|hevc|aac|dd5\.1|dts)\b/gi;

const LANGUAGE_PATTERN =
  /\b(hindi|english|tamil|telugu|malayalam|kannada|bengali|punjabi|marathi|gujarati|urdu|dual[\s-]?audio|multi[\s-]?audio|dubbed|dub|org(?:inal)?|uncut|extended|unrated|proper|repack|esub|subs?)\b/gi;

const REGION_PATTERN =
  /\b(bollywood|hollywood|tollywood|kollywood|south[\s-]?indian|hindi[\s-]?movie|hindi[\s-]?dubbed|movie|movies|film|cinema|web[\s-]?series|complete|all[\s-]?episodes?)\b/gi;

function looksLikeTv(title) {
  return /\b(season|s\d{1,2}\s*e\d{1,2}|series|episodes?|web\s*series|complete)\b/i.test(title);
}

function parseSourceTitle(title) {
  const raw = String(title || "").trim();
  const yearMatch = raw.match(/\((19|20)\d{2}\)/);
  const year = yearMatch ? Number.parseInt(yearMatch[0].slice(1, -1), 10) : null;

  let query = raw
    .replace(/\bseason\s*\d+.*$/i, "")
    .replace(/\bs\d{1,2}(\s*e\d{1,2})?.*$/i, "")
    .replace(/\b(s\d{1,2}\s*e\d{1,2}|season\s*\d+|episode\s*\d+)\b/gi, "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(NOISE_PATTERN, " ")
    .replace(LANGUAGE_PATTERN, " ")
    .replace(REGION_PATTERN, " ")
    .replace(/\bmov(?:ie)?\.{0,3}\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(/[|\-–:]/)[0]
    .trim();

  return { query, year, raw };
}

function cleanTitle(title) {
  return parseSourceTitle(title).query;
}

function normalizeForMatch(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripArticles(text) {
  return normalizeForMatch(text)
    .replace(/\b(the|a|an)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleSimilarity(query, candidateTitle) {
  const a = normalizeForMatch(query);
  const b = normalizeForMatch(candidateTitle);
  if (!a || !b) return 0;
  if (a === b) return 1;

  const articleA = stripArticles(a);
  const articleB = stripArticles(b);
  if (articleA && articleB && articleA === articleB) return 0.98;

  if (a.length >= 4 && b.includes(a)) return 0.92;
  if (b.length >= 4 && a.includes(b)) return 0.88;

  const tokensA = a.split(" ").filter((token) => token.length > 1);
  const tokensB = new Set(b.split(" ").filter((token) => token.length > 1));
  if (!tokensA.length) return 0;

  let matched = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) matched += 1;
  }

  return matched / tokensA.length;
}

function getCandidateTitle(candidate) {
  return candidate.title || candidate.name || "";
}

function getCandidateOriginalTitle(candidate) {
  return candidate.original_title || candidate.original_name || getCandidateTitle(candidate);
}

function getCandidateYear(candidate) {
  const date = candidate.release_date || candidate.first_air_date || "";
  return date ? Number.parseInt(date.slice(0, 4), 10) : null;
}

function scoreCandidate(candidate, parsed) {
  const displayTitle = getCandidateTitle(candidate);
  const originalTitle = getCandidateOriginalTitle(candidate);

  let score = Math.max(
    titleSimilarity(parsed.query, displayTitle),
    titleSimilarity(parsed.query, originalTitle)
  );

  const candidateYear = getCandidateYear(candidate);
  if (parsed.year && candidateYear) {
    const yearDiff = Math.abs(parsed.year - candidateYear);
    if (yearDiff === 0) score += 0.18;
    else if (yearDiff === 1) score += 0.06;
    else if (yearDiff > 2) score -= 0.25;
  }

  if (looksLikeTv(parsed.raw)) {
    if (candidate.media_type === "tv") score += 0.12;
    else if (candidate.media_type === "movie") score -= 0.2;
  } else if (candidate.media_type === "movie") {
    score += 0.04;
  }

  score += Math.min(candidate.popularity || 0, 40) / 1000;
  return score;
}

function pickBestMatch(candidates, parsed) {
  if (!candidates.length) return null;

  const scored = candidates
    .map((candidate) => ({
      candidate,
      score: scoreCandidate(candidate, parsed),
    }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best || best.score < MIN_MATCH_SCORE) return null;

  return best.candidate;
}

async function fetchSearch(apiKey, endpoint, query, year) {
  const url = new URL(`${TMDB_BASE}/search/${endpoint}`);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("query", query);
  url.searchParams.set("include_adult", "false");

  if (year) {
    if (endpoint === "movie") {
      url.searchParams.set("primary_release_year", String(year));
    } else if (endpoint === "tv") {
      url.searchParams.set("first_air_date_year", String(year));
    }
  }

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`TMDB search failed: ${res.status}`);
  }

  return res.json();
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  const unique = [];

  for (const candidate of candidates) {
    const key = `${candidate.media_type || "unknown"}:${candidate.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }

  return unique;
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

async function gatherCandidates(apiKey, parsed) {
  const { query, year } = parsed;
  const wantTv = looksLikeTv(parsed.raw);
  const searches = [];

  searches.push(fetchSearch(apiKey, "multi", query));

  if (year) {
    searches.push(fetchSearch(apiKey, "movie", query, year));
    searches.push(fetchSearch(apiKey, "tv", query, year));
  } else if (wantTv) {
    searches.push(fetchSearch(apiKey, "tv", query));
  } else {
    searches.push(fetchSearch(apiKey, "movie", query));
  }

  const responses = await Promise.all(searches);
  const candidates = [];

  for (const data of responses) {
    for (const result of data.results || []) {
      if (result.media_type === "movie" || result.media_type === "tv") {
        candidates.push(result);
        continue;
      }

      if (result.title) {
        candidates.push({ ...result, media_type: "movie" });
      } else if (result.name) {
        candidates.push({ ...result, media_type: "tv" });
      }
    }
  }

  return dedupeCandidates(candidates);
}

async function searchMedia(apiKey, title, genres) {
  const parsed = parseSourceTitle(title);
  const { query, year } = parsed;
  if (!query) return null;

  const cacheKey = `${query}|${year || ""}|${looksLikeTv(parsed.raw) ? "tv" : "movie"}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const candidates = await gatherCandidates(apiKey, parsed);
  const match = pickBestMatch(candidates, parsed);
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

module.exports = {
  cleanTitle,
  parseSourceTitle,
  titleSimilarity,
  searchMedia,
  enrichMovies,
};
