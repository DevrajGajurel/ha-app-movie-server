function normalizeUrlForCompare(value) {
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    if (parsed.pathname === "/") {
      return `${parsed.protocol}//${parsed.host}`.toLowerCase();
    }
    return parsed.href.replace(/\/+$/, "").toLowerCase();
  } catch {
    return String(value || "").replace(/\/+$/, "").toLowerCase();
  }
}

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

async function fetchFollowingRedirects(start) {
  let res;
  try {
    res = await fetch(start, {
      method: "HEAD",
      redirect: "follow",
      headers: BROWSER_HEADERS,
    });
  } catch {
    res = null;
  }

  if (!res || res.status === 405 || res.status === 501) {
    res = await fetch(start, {
      method: "GET",
      redirect: "follow",
      headers: BROWSER_HEADERS,
    });
  }

  return res;
}

function hourlyAnalytisSeed(date = new Date()) {
  return (
    1e6 * date.getFullYear() +
    1e4 * (date.getMonth() + 1) +
    100 * date.getDate() +
    date.getHours() +
    1
  );
}

async function resolveJavascriptMirrorUrl(httpUrl, html) {
  // FilmyFly-style client redirect: /analytis.js fetches google.analytis.top
  // and sets window.location.href to a backup domain when hosts differ.
  const usesAnalytis =
    /analytis\.js/i.test(html) ||
    /google\.analytis\.top/i.test(html) ||
    /aHR0cHM6Ly9nb29nbGUuYW5hbHl0aXMudG9wL2FuYWx5dGlz/.test(html);

  if (!usesAnalytis) return null;

  const currentHost = new URL(httpUrl).host;
  const apiUrl = `https://google.analytis.top/analytis?v=3c${hourlyAnalytisSeed()}`;

  const apiRes = await fetch(apiUrl, {
    headers: {
      ...BROWSER_HEADERS,
      Accept: "application/json,text/plain,*/*",
      Referer: httpUrl,
    },
  });
  if (!apiRes.ok) return null;

  const data = await apiRes.json();
  if (!data?.c) return null;

  const decoded = Buffer.from(String(data.c), "base64").toString("utf8");
  const backupUrl = new URL(decoded).href;
  const backupHost = new URL(backupUrl).host;

  if (currentHost.toLowerCase() === backupHost.toLowerCase()) return null;
  return backupUrl;
}

async function resolveRedirectUrl(inputUrl) {
  const start = new URL(inputUrl).href;
  const res = await fetchFollowingRedirects(start);
  const httpUrl = res?.url || start;

  let javascriptUrl = null;

  // Client-side mirror redirects only run on the homepage in their script.
  const path = new URL(httpUrl).pathname || "/";
  if (path === "/" || path === "") {
    const pageRes = await fetch(httpUrl, {
      method: "GET",
      redirect: "follow",
      headers: BROWSER_HEADERS,
    });
    const html = await pageRes.text();
    try {
      javascriptUrl = await resolveJavascriptMirrorUrl(httpUrl, html);
    } catch (err) {
      console.warn("[redirect] JS mirror lookup failed:", err.message);
    }
  }

  // One URL only: redirected destination if any, otherwise the original/HTTP URL.
  return javascriptUrl || httpUrl || start;
}

module.exports = { resolveRedirectUrl, normalizeUrlForCompare };
