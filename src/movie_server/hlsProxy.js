const { URL } = require("url");

const REFERER_DEFAULT = "https://cloudorchestranova.com/";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const PROXY_PREFIX = "/api/hls-proxy";

function safeRemoteUrl(raw) {
  let parsed;
  try {
    parsed = new URL(String(raw || ""));
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!parsed.host) return null;
  return parsed.href;
}

function buildProxyUrl(req, target, referer) {
  const host = req.headers.host || "127.0.0.1:3001";
  const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim() || "http";
  const base = `${proto}://${host}${PROXY_PREFIX}`;
  const params = new URLSearchParams({
    url: target,
    referer: referer || REFERER_DEFAULT,
  });
  return `${base}?${params.toString()}`;
}

function rewriteM3u8(body, baseUrl, referer, req) {
  const lines = String(body || "").split(/\r?\n/);
  const out = [];
  for (let line of lines) {
    const stripped = line.trim();
    if (!stripped) {
      out.push(line);
      continue;
    }
    if (stripped.startsWith("#")) {
      if (stripped.includes("URI=")) {
        line = line.replace(/URI="([^"]+)"/g, (_, inner) => {
          const abs = new URL(inner, baseUrl).href;
          return `URI="${buildProxyUrl(req, abs, referer)}"`;
        });
      }
      out.push(line);
      continue;
    }
    const abs = new URL(stripped, baseUrl).href;
    out.push(buildProxyUrl(req, abs, referer));
  }
  return `${out.join("\n")}\n`;
}

function isPlaylistResponse(contentType, url) {
  const ct = String(contentType || "").toLowerCase();
  if (ct.includes("mpegurl") || ct.includes("m3u8")) return true;
  try {
    return new URL(url).pathname.toLowerCase().endsWith(".m3u8");
  } catch {
    return false;
  }
}

async function handleHlsProxy(req, res) {
  const incoming = new URL(req.url || "/", "http://localhost");
  const target = safeRemoteUrl(incoming.searchParams.get("url"));
  const referer = incoming.searchParams.get("referer") || REFERER_DEFAULT;

  if (!target) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "url must be http(s)" }));
    return;
  }

  let upstream;
  try {
    upstream = await fetch(target, {
      headers: {
        "User-Agent": UA,
        Referer: referer,
        Origin: referer.replace(/\/$/, ""),
        Accept: "*/*",
      },
      redirect: "follow",
    });
  } catch (err) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `HLS proxy fetch failed: ${err.message}` }));
    return;
  }

  if (upstream.status >= 400) {
    res.writeHead(upstream.status, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify({ error: "upstream error", status: upstream.status }));
    return;
  }

  const contentType = upstream.headers.get("content-type") || "application/octet-stream";
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "*",
    "Cache-Control": "no-store",
  };

  if (isPlaylistResponse(contentType, target)) {
    const text = await upstream.text();
    const rewritten = rewriteM3u8(text, target, referer, req);
    res.writeHead(200, {
      ...cors,
      "Content-Type": "application/vnd.apple.mpegurl",
      "Content-Length": Buffer.byteLength(rewritten),
    });
    res.end(rewritten);
    return;
  }

  const buf = Buffer.from(await upstream.arrayBuffer());
  res.writeHead(200, {
    ...cors,
    "Content-Type": contentType,
    "Content-Length": buf.length,
  });
  res.end(buf);
}

function buildClientProxyPath(streamUrl, referer) {
  const params = new URLSearchParams({
    url: streamUrl,
    referer: referer || REFERER_DEFAULT,
  });
  return `${PROXY_PREFIX}?${params.toString()}`;
}

module.exports = {
  PROXY_PREFIX,
  REFERER_DEFAULT,
  handleHlsProxy,
  buildClientProxyPath,
  safeRemoteUrl,
};
