function normalizeUrlForCompare(value) {
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    // Ignore trailing slash differences on the path root.
    if (parsed.pathname === "/") {
      return `${parsed.protocol}//${parsed.host}`.toLowerCase();
    }
    return parsed.href.replace(/\/+$/, "").toLowerCase();
  } catch {
    return String(value || "").replace(/\/+$/, "").toLowerCase();
  }
}

async function resolveRedirectUrl(inputUrl) {
  const start = new URL(inputUrl).href;

  let res;
  try {
    res = await fetch(start, {
      method: "HEAD",
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
    });
  } catch {
    res = null;
  }

  if (!res || res.status === 405 || res.status === 501) {
    res = await fetch(start, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
    });
  }

  const finalUrl = res.url || start;
  return {
    originalUrl: start,
    url: finalUrl,
    redirected: normalizeUrlForCompare(start) !== normalizeUrlForCompare(finalUrl),
  };
}

module.exports = { resolveRedirectUrl, normalizeUrlForCompare };
