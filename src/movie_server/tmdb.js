const TMDB_BASE = "https://api.themoviedb.org/3";
const POSTER_BASE = "https://image.tmdb.org/t/p/w342";
const MIN_MATCH_SCORE = 0.48;
const cache = new Map();
let genreMap = null;

const METADATA_PAREN =
  /\b(hindi|english|tamil|telugu|malayalam|kannada|bengali|punjabi|panjabi|marathi|gujarati|urdu|dual|audio|hq|esub|hevc|org|uncut|dubbed|dub|part|add|episode|ep)\b/i;

const JUNK_TITLE =
  /\b(audio launch|launch event|trailer|teaser|short film|interview|promo|promotional|behind the scenes|making of|concert|spot|fan made|unofficial)\b/i;

function looksLikeTv(title) {
  return /\b(season|s\d{1,2}\s*e\d{1,2}|series|episodes?|web\s*series|completed\s+web\s+series)\b/i.test(title);
}

function looksLikeMetadataParen(value) {
  return METADATA_PAREN.test(value) || /^\d{1,2}$/.test(value.trim());
}

function stripTvMarkers(title) {
  return String(title || "")
    .replace(/\bseason\s*\d+.*$/i, "")
    .replace(/\bs\d{1,2}(\s*e\d{1,2})?.*$/i, "")
    .replace(/\b(s\d{1,2}\s*e\d{1,2}|season\s*\d+|episode\s*\d+)\b/gi, " ")
    .replace(/\s+S\d{1,2}\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractYear(title) {
  const match = title.match(/\((19|20)\d{2}\)/);
  return match ? Number.parseInt(match[0].slice(1, -1), 10) : null;
}

function stripReleaseTail(title) {
  return String(title || "")
    .replace(/\{[^}]*\}/g, " ")
    .replace(
      /\s+(?:\(|(?:\b(?:dual[\s-]?audio|multi[\s-]?audio|south\s+movie|south\s+hindi|bollywood|hollywood|tollywood|kollywood|mollywood|animated\s+movie|animation\s+movie|hindi\s+movie|panjabi\s+movie|punjabi\s+movie|full\s+movie|web\s+series|completed\s+web\s+series|predvd|hqcam|hdrip|brrip|dvdrip|web-?dl|bluray|blu-?ray|hevc|esub|uncut|hdr|hd)\b)).*/i,
      ""
    )
    .replace(/\s+/g, " ")
    .trim();
}

function splitAlternateTitle(title) {
  let query = title;
  let altQuery = null;

  const altMatch = query.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (altMatch && !looksLikeMetadataParen(altMatch[2])) {
    query = altMatch[1].trim();
    altQuery = altMatch[2].trim();
  }

  return { query, altQuery };
}

function parseSourceTitle(title) {
  const raw = String(title || "").trim();
  let work = stripTvMarkers(raw);
  const year = extractYear(work);

  let query = work;
  if (year) {
    const yearIndex = work.search(/\((19|20)\d{2}\)/);
    if (yearIndex >= 0) {
      query = work.slice(0, yearIndex).trim();
    }
  } else {
    query = stripReleaseTail(work);
  }

  const alternate = splitAlternateTitle(query);
  query = alternate.query;
  const altQuery = alternate.altQuery;

  return { query, altQuery, year, raw };
}

function cleanTitle(title) {
  return parseSourceTitle(title).query;
}

function expandQueryVariants(query) {
  const variants = [query];
  const nahin = query.replace(/\bnahi\b/gi, "nahin");
  if (nahin !== query) variants.push(nahin);
  const nahi = query.replace(/\bnahin\b/gi, "nahi");
  if (nahi !== query) variants.push(nahi);
  return [...new Set(variants.filter(Boolean))];
}

function compactSimilarity(a, b) {
  const left = normalizeForMatch(a).replace(/\s/g, "");
  const right = normalizeForMatch(b).replace(/\s/g, "");
  if (!left || !right) return 0;
  if (left === right) return 0.96;
  if (left.length >= 4 && right.includes(left)) return 0.9;
  if (right.length >= 4 && left.includes(right)) return 0.88;
  return 0;
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

  const tokenScore = matched / tokensA.length;
  return Math.max(tokenScore, compactSimilarity(query, candidateTitle));
}

function isJunkCandidate(candidate) {
  const displayTitle = getCandidateTitle(candidate);
  const originalTitle = getCandidateOriginalTitle(candidate);
  return JUNK_TITLE.test(displayTitle) || JUNK_TITLE.test(originalTitle);
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

function scoreCandidate(candidate, parsed, context = {}) {
  const displayTitle = getCandidateTitle(candidate);
  const originalTitle = getCandidateOriginalTitle(candidate);
  const queries = [parsed.query, parsed.altQuery].filter(Boolean);

  let score = 0;
  for (const query of queries) {
    score = Math.max(
      score,
      titleSimilarity(query, displayTitle),
      titleSimilarity(query, originalTitle),
      compactSimilarity(query, displayTitle),
      compactSimilarity(query, originalTitle)
    );
  }

  for (const query of queries) {
    if (normalizeForMatch(query) === normalizeForMatch(displayTitle)) {
      score += 0.2;
    }
  }

  const candidateYear = getCandidateYear(candidate);
  if (parsed.year && candidateYear) {
    const yearDiff = Math.abs(parsed.year - candidateYear);
    if (yearDiff === 0) score += 0.16;
    else if (yearDiff === 1) score += 0.06;
    else if (yearDiff === 2) score += 0.02;
    else if (parsed.year >= 2025 && yearDiff <= 4) score += 0;
    else if (yearDiff > 2) score -= 0.12;
  }

  if (looksLikeTv(parsed.raw)) {
    if (candidate.media_type === "tv") score += 0.12;
    else if (candidate.media_type === "movie") score -= 0.15;
  } else if (candidate.media_type === "movie") {
    score += 0.04;
  }

  if (isJunkCandidate(candidate)) {
    score -= 0.35;
  }

  const searchRank = context.searchRanks?.get(candidate.id);
  if (searchRank === 0) {
    score = Math.max(score, 0.56);
  }

  score += Math.min(candidate.popularity || 0, 40) / 1000;
  return score;
}

function pickBestMatch(candidates, parsed, context = {}) {
  if (!candidates.length) return null;

  const scored = candidates
    .map((candidate) => ({
      candidate,
      score: scoreCandidate(candidate, parsed, context),
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

function normalizeCandidates(data) {
  const candidates = [];

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

  return candidates;
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

async function gatherCandidates(apiKey, parsed, { useYear = true } = {}) {
  const { query, altQuery, year } = parsed;
  const wantTv = looksLikeTv(parsed.raw);
  const queries = [...new Set([query, altQuery].filter(Boolean))];
  const searches = [];
  const searchRanks = new Map();

  const trackResults = (results) => {
    results.forEach((result, index) => {
      if (!result?.id) return;
      const current = searchRanks.get(result.id);
      if (current === undefined || index < current) {
        searchRanks.set(result.id, index);
      }
    });
  };

  for (const searchQuery of queries) {
    for (const variant of expandQueryVariants(searchQuery)) {
      searches.push(
        fetchSearch(apiKey, "multi", variant).then((data) => {
          trackResults(normalizeCandidates(data));
          return data;
        })
      );

      if (useYear && year) {
        searches.push(
          fetchSearch(apiKey, "movie", variant, year).then((data) => {
            trackResults(normalizeCandidates(data));
            return data;
          })
        );
        searches.push(
          fetchSearch(apiKey, "tv", variant, year).then((data) => {
            trackResults(normalizeCandidates(data));
            return data;
          })
        );
      } else if (wantTv) {
        searches.push(
          fetchSearch(apiKey, "tv", variant).then((data) => {
            trackResults(normalizeCandidates(data));
            return data;
          })
        );
      } else {
        searches.push(
          fetchSearch(apiKey, "movie", variant).then((data) => {
            trackResults(normalizeCandidates(data));
            return data;
          })
        );
      }
    }
  }

  const responses = await Promise.all(searches);
  return {
    candidates: dedupeCandidates(responses.flatMap(normalizeCandidates)),
    searchRanks,
  };
}

async function searchMedia(apiKey, title, genres) {
  const parsed = parseSourceTitle(title);
  const { query, altQuery } = parsed;
  if (!query && !altQuery) return null;

  const cacheKey = `${query}|${altQuery || ""}|${parsed.year || ""}|${looksLikeTv(parsed.raw) ? "tv" : "movie"}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  let { candidates, searchRanks } = await gatherCandidates(apiKey, parsed, { useYear: true });
  let match = pickBestMatch(candidates, parsed, { searchRanks });

  if (!match) {
    ({ candidates, searchRanks } = await gatherCandidates(apiKey, parsed, { useYear: false }));
    match = pickBestMatch(candidates, parsed, { searchRanks });
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

module.exports = {
  cleanTitle,
  parseSourceTitle,
  titleSimilarity,
  searchMedia,
  enrichMovies,
};
