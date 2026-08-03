const { URL } = require("url");

const PROXY_PREFIX = "/api/cineby-proxy";

// Injected into proxied HTML so the parent MediaNest/HelloTV app can drive
// Cineby with the TV remote (via postMessage) and so Cineby cannot navigate
// the top-level widget away from our app.
const TV_CURSOR_SCRIPT = `<script data-medianest-tv-cursor="1">(function(){
  if (window.__medianestTvCursor) return;
  window.__medianestTvCursor = true;

  // Soft anti-frame-bust: rewrite _top/_parent links; best-effort block
  // top/parent navigations. Hard lock is the iframe sandbox (no allow-top-navigation).
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("a") : null;
    if (!a) return;
    if (a.target === "_top" || a.target === "_parent") a.target = "_self";
  }, true);

  var cursor = document.createElement("div");
  cursor.id = "medianest-tv-cursor";
  cursor.style.cssText = "position:fixed;z-index:2147483647;width:28px;height:28px;margin:-14px 0 0 -14px;border:3px solid #00a8e1;border-radius:50%;background:rgba(0,168,225,.35);pointer-events:none;left:50%;top:50%;box-shadow:0 0 12px rgba(0,168,225,.8);transition:left .05s linear,top .05s linear;";
  var x = Math.round((window.innerWidth || 1920) / 2);
  var y = Math.round((window.innerHeight || 1080) / 2);
  var step = 56;

  function ensure() {
    if (!document.body) return;
    if (!cursor.parentNode) document.body.appendChild(cursor);
  }

  function place() {
    ensure();
    var w = window.innerWidth || 1920;
    var h = window.innerHeight || 1080;
    x = Math.max(0, Math.min(w - 1, x));
    y = Math.max(0, Math.min(h - 1, y));
    cursor.style.left = x + "px";
    cursor.style.top = y + "px";
    if (y > h - 90) window.scrollBy(0, step);
    if (y < 90) window.scrollBy(0, -step);
    if (x > w - 90) window.scrollBy(step, 0);
    if (x < 90) window.scrollBy(-step, 0);
  }

  function deepElementFromPoint(px, py) {
    var el = document.elementFromPoint(px, py);
    var guard = 0;
    while (el && el.tagName === "IFRAME" && guard++ < 5) {
      try {
        var rect = el.getBoundingClientRect();
        var doc = el.contentDocument;
        if (!doc) break;
        var inner = doc.elementFromPoint(px - rect.left, py - rect.top);
        if (!inner || inner === el) break;
        el = inner;
      } catch (err) {
        break;
      }
    }
    return el;
  }

  function fire(el, type, ctor, extra) {
    try {
      var opts = Object.assign({ bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }, extra || {});
      el.dispatchEvent(new ctor(type, opts));
    } catch (err) {}
  }

  function clickAt() {
    var el = deepElementFromPoint(x, y);
    if (!el) return;
    var target = el.closest("a,button,input,textarea,select,[role='button'],[tabindex],video,summary,[onclick]") || el;
    try { if (target.focus) target.focus(); } catch (e) {}
    fire(target, "pointerover", window.PointerEvent || MouseEvent, { pointerType: "mouse", isPrimary: true });
    fire(target, "pointerenter", window.PointerEvent || MouseEvent, { pointerType: "mouse", isPrimary: true });
    fire(target, "mouseover", MouseEvent);
    fire(target, "mouseenter", MouseEvent);
    fire(target, "pointerdown", window.PointerEvent || MouseEvent, { pointerType: "mouse", isPrimary: true, button: 0 });
    fire(target, "mousedown", MouseEvent, { button: 0 });
    fire(target, "pointerup", window.PointerEvent || MouseEvent, { pointerType: "mouse", isPrimary: true, button: 0 });
    fire(target, "mouseup", MouseEvent, { button: 0 });
    fire(target, "click", MouseEvent, { button: 0 });
    try { if (typeof target.click === "function") target.click(); } catch (e) {}
  }

  function handleKey(code) {
    var moved = false;
    if (code === 37) { x -= step; moved = true; }
    else if (code === 39) { x += step; moved = true; }
    else if (code === 38) { y -= step; moved = true; }
    else if (code === 40) { y += step; moved = true; }
    else if (code === 13) { clickAt(); return true; }
    else if (code === 10009 || code === 27) {
      try { window.parent.postMessage({ type: "medianest-cineby-back" }, "*"); } catch (err) {}
      return true;
    }
    if (moved) { place(); return true; }
    return false;
  }

  document.addEventListener("keydown", function (e) {
    if (handleKey(e.keyCode)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  // Parent app forwards remote keys here — Tizen delivers them to the
  // outer MediaNest document, not the iframe.
  window.addEventListener("message", function (ev) {
    if (!ev.data || ev.data.type !== "medianest-tv-key") return;
    handleKey(Number(ev.data.keyCode) || 0);
  });

  window.addEventListener("resize", place);
  if (document.body) place();
  else document.addEventListener("DOMContentLoaded", place);
})();</script>`;

function stripFramingHeaders(headers) {
  const skip = new Set([
    "content-security-policy",
    "content-security-policy-report-only",
    "x-frame-options",
    "content-encoding",
    "content-length",
    "transfer-encoding",
    "cross-origin-opener-policy",
    "cross-origin-embedder-policy",
    "cross-origin-resource-policy",
    "strict-transport-security",
  ]);
  const out = {};
  for (const [key, value] of headers) {
    if (skip.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

function rewriteHtml(html, cinebyOrigin, proxyAbsoluteBase) {
  let out = html.replace(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/gi, "");
  out = out.split(cinebyOrigin).join(proxyAbsoluteBase);
  out = out.replace(/(\s)(href|src|action|poster)=(["'])\/(?!\/)/gi, `$1$2=$3${PROXY_PREFIX}/`);
  out = out.replace(/(\s)(href|src|action|poster)=(["'])\.\//gi, `$1$2=$3${PROXY_PREFIX}/`);
  // Keep navigations inside the iframe — never replace MediaNest/HelloTV.
  out = out.replace(/target=(["'])_top\1/gi, "target=$1_self$1");
  out = out.replace(/target=(["'])_parent\1/gi, "target=$1_self$1");
  if (out.includes("</head>")) out = out.replace("</head>", `${TV_CURSOR_SCRIPT}</head>`);
  else if (out.includes("</body>")) out = out.replace("</body>", `${TV_CURSOR_SCRIPT}</body>`);
  else out += TV_CURSOR_SCRIPT;
  return out;
}

function rewriteCss(css, cinebyOrigin) {
  let out = css.split(cinebyOrigin).join(PROXY_PREFIX);
  out = out.replace(/url\(\//g, `url(${PROXY_PREFIX}/`);
  out = out.replace(/url\("\//g, `url("${PROXY_PREFIX}/`);
  out = out.replace(/url\('\//g, `url('${PROXY_PREFIX}/`);
  return out;
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function handleCinebyProxy(req, res, cinebyUrl) {
  if (!cinebyUrl) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "cinebyUrl is not configured" }));
    return;
  }

  let base;
  try {
    base = new URL(cinebyUrl);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "cinebyUrl is invalid" }));
    return;
  }

  const incoming = new URL(req.url || "/", "http://localhost");
  const suffix = incoming.pathname.slice(PROXY_PREFIX.length) || "/";
  const target = new URL(suffix + incoming.search, base.href.endsWith("/") ? base.href : `${base.href}/`);

  if (target.origin !== base.origin) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Proxy target escaped cineby origin" }));
    return;
  }

  const forwardHeaders = {
    accept: req.headers.accept || "*/*",
    "accept-language": req.headers["accept-language"] || "en",
    "user-agent": req.headers["user-agent"] || "MovieServer-CinebyProxy/1.0",
  };
  if (req.headers["content-type"]) forwardHeaders["content-type"] = req.headers["content-type"];

  const init = {
    method: req.method,
    headers: forwardHeaders,
    redirect: "manual",
  };
  if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
    init.body = await readRequestBody(req);
  }

  let upstream;
  try {
    upstream = await fetch(target.href, init);
  } catch (err) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Cineby proxy fetch failed: ${err.message}` }));
    return;
  }

  if (upstream.status >= 300 && upstream.status < 400) {
    const location = upstream.headers.get("location");
    if (location) {
      const next = new URL(location, target);
      const headers = stripFramingHeaders(upstream.headers);
      if (next.origin === base.origin) {
        headers.Location = `${PROXY_PREFIX}${next.pathname}${next.search}`;
      } else {
        // Refuse off-origin redirects that would break out of the proxied
        // iframe experience (and often the whole TV app via target=_top).
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Blocked off-origin redirect to ${next.origin}` }));
        return;
      }
      res.writeHead(upstream.status, headers);
      res.end();
      return;
    }
  }

  const contentType = upstream.headers.get("content-type") || "application/octet-stream";
  const headers = stripFramingHeaders(upstream.headers);
  delete headers["content-type"];
  delete headers["Content-Type"];

  const raw = Buffer.from(await upstream.arrayBuffer());
  let body = raw;

  if (/text\/html/i.test(contentType)) {
    const host = req.headers.host || "127.0.0.1:3001";
    const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim() || "http";
    const proxyAbsoluteBase = `${proto}://${host}${PROXY_PREFIX}`;
    body = Buffer.from(rewriteHtml(raw.toString("utf8"), base.origin, proxyAbsoluteBase), "utf8");
  } else if (/text\/css/i.test(contentType)) {
    body = Buffer.from(rewriteCss(raw.toString("utf8"), base.origin), "utf8");
  }

  headers["Content-Type"] = contentType;
  headers["Content-Length"] = String(body.length);
  headers["Cache-Control"] = "no-store";
  res.writeHead(upstream.status, headers);
  res.end(body);
}

module.exports = {
  PROXY_PREFIX,
  handleCinebyProxy,
};
