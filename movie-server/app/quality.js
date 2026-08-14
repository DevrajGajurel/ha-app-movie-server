function parseKeywordList(value) {
  return (value || "")
    .split(",")
    .map((keyword) => keyword.trim())
    .filter(Boolean);
}

function matchesKeywords(title, keywords) {
  if (!title || !keywords.length) return false;

  const lowerTitle = title.toLowerCase();
  return keywords.some((keyword) => lowerTitle.includes(keyword.toLowerCase()));
}

function tagQuality(movie, hdKeywords, k4Keywords) {
  return {
    ...movie,
    quality: {
      hd: matchesKeywords(movie.title, hdKeywords),
      k4: matchesKeywords(movie.title, k4Keywords),
    },
  };
}

module.exports = { parseKeywordList, matchesKeywords, tagQuality };
