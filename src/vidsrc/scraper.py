"""
VidSrc.to Scraper
Extracts m3u8 stream URLs for movies and TV shows using TMDB/IMDB IDs.

Chain:
  vidsrc.to/embed/{type}/{id}
    -> vsembed.ru/embed/{type}/{id}/       (extracts rcp hash + player host)
    -> {player_host}/rcp/{hash}            (extracts prorcp hash)
    -> {player_host}/prorcp/{hash}         (extracts m3u8 URLs)

Player host is discovered live from vsembed (currently cloudorchestranova.com).
The prorcp hop is protected by Cloudflare Turnstile; use --browser (SeleniumBase
UC / headed Chrome) for that step when requests alone are blocked.
"""

import re
import sys
import time
import random
import requests
from urllib.parse import urljoin, urlparse

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "DNT": "1",
}

# Last-known player host; overridden at runtime from vsembed iframe when present.
DEFAULT_PLAYER_HOST = "https://cloudorchestranova.com"

SESSION = requests.Session()
SESSION.headers.update(HEADERS)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _get(url: str, referer: str = None, **kwargs) -> requests.Response:
    headers = {}
    if referer:
        headers["Referer"] = referer
    time.sleep(random.uniform(0.3, 0.8))  # polite delay
    resp = SESSION.get(url, headers=headers, timeout=15, **kwargs)
    resp.raise_for_status()
    return resp


def _extract(pattern: str, text: str, group: int = 1) -> str | None:
    m = re.search(pattern, text)
    return m.group(group) if m else None

# ---------------------------------------------------------------------------
# Step 1: vidsrc.to -> vsembed.ru iframe src
# ---------------------------------------------------------------------------

def get_vsembed_url(media_type: str, media_id: str, season: int = None, episode: int = None) -> str:
    """
    media_type: 'movie' or 'tv'
    media_id:   TMDB or IMDB id (e.g. 'tt9263550' or '12345')
    """
    if media_type == "tv" and season and episode:
        url = f"https://vidsrc.to/embed/tv/{media_id}/{season}/{episode}"
    else:
        url = f"https://vidsrc.to/embed/movie/{media_id}"

    resp = _get(url)
    html = resp.text

    # The page embeds vsembed.ru in an iframe
    src = _extract(r'src=["\']([^"\']*vsembed\.ru[^"\']*)["\']', html)
    if not src:
        # Try relative or protocol-relative
        src = _extract(r'src=["\']([^"\']*embed[^"\']*)["\']', html)
    if not src:
        raise ValueError(f"Could not find vsembed iframe in vidsrc.to response for {url}")

    if src.startswith("//"):
        src = "https:" + src
    return src, url


# ---------------------------------------------------------------------------
# Step 2: vsembed.ru -> rcp hashes + player host
# ---------------------------------------------------------------------------

def _normalize_url(src: str, base: str = None) -> str:
    if src.startswith("//"):
        return "https:" + src
    if base and src.startswith("/"):
        return urljoin(base, src)
    return src


def get_rcp_sources(vsembed_url: str, referer: str):
    """
    Returns (primary_hash, all_hashes, player_base).
    player_base is taken from #player_iframe /rcp/ URL when present.
    """
    resp = _get(vsembed_url, referer=referer)
    html = resp.text

    hashes = re.findall(r'data-hash=["\']([A-Za-z0-9+/=_\-]+)["\']', html)
    if not hashes:
        raise ValueError("Could not find rcp hash in vsembed.ru response")

    player_base = DEFAULT_PLAYER_HOST
    iframe = (
        _extract(r'id=["\']player_iframe["\'][^>]*src=["\']([^"\']+)["\']', html)
        or _extract(r'src=["\']([^"\']*/rcp/[^"\']+)["\']', html)
    )
    if iframe:
        iframe = _normalize_url(iframe)
        parsed = urlparse(iframe)
        if parsed.scheme and parsed.netloc:
            player_base = f"{parsed.scheme}://{parsed.netloc}"
            # Prefer hash already embedded in the iframe when available
            path_hash = _extract(r"/rcp/([A-Za-z0-9+/=_\-]+)", iframe)
            if path_hash and path_hash not in hashes:
                hashes.insert(0, path_hash)

    return hashes[0], hashes, player_base


# ---------------------------------------------------------------------------
# Step 3: {player}/rcp/{hash} -> prorcp hash
# ---------------------------------------------------------------------------

def get_prorcp_hash(rcp_hash: str, referer: str, player_base: str) -> str:
    url = f"{player_base}/rcp/{rcp_hash}"
    resp = _get(url, referer=referer)
    html = resp.text

    # The page has: src: '/prorcp/{hash}' inside loadIframe()
    prorcp = _extract(r"['\"]\/prorcp\/([A-Za-z0-9+/=_\-]+)['\"]", html)
    if not prorcp:
        raise ValueError(f"Could not find prorcp hash in {player_base} rcp response")
    return prorcp


# ---------------------------------------------------------------------------
# Step 4: {player}/prorcp/{hash} -> m3u8 URLs
# ---------------------------------------------------------------------------

def _parse_file_field(file_match: str, html: str, player_base: str, token: str | None = None) -> list[dict]:
    """Split Playerjs file: value, resolve {vN} placeholders and __TOKEN__."""
    raw_urls = [u.strip() for u in file_match.split(" or ") if u.strip()]
    cdn_vars = _resolve_cdn_vars(html, player_base)
    if token is None:
        token = _fetch_stream_token(html, player_base)

    results = []
    seen = set()
    for raw in raw_urls:
        resolved = raw
        for k, v in cdn_vars.items():
            resolved = resolved.replace("{" + k + "}", v)
        if token and "__TOKEN__" in resolved:
            resolved = resolved.replace("__TOKEN__", token)
        if "{v" in resolved or "__TOKEN__" in resolved:
            continue
        if resolved not in seen:
            seen.add(resolved)
            results.append({"url": resolved, "raw": raw})

    return results


def _fetch_stream_token(html: str, player_base: str, retries: int = 4) -> str | None:
    """
    Newer players serve master.m3u8?token=__TOKEN__ and fill the JWT via:
      $.get("https://cdn-host/generate.php", function(token) { ... })
    """
    if "__TOKEN__" not in html and "generate.php" not in html:
        return None

    gen_url = _extract(r"""\$\.get\(\s*["'](https?://[^"']+/generate\.php[^"']*)["']""", html)
    if not gen_url:
        host = _extract(r'https?://([a-zA-Z0-9.-]+)/pl/', html)
        if host:
            gen_url = f"https://{host}/generate.php"
    if not gen_url:
        return None

    last_err = None
    for attempt in range(retries):
        try:
            resp = SESSION.get(
                gen_url,
                headers={
                    "Referer": player_base + "/",
                    "Origin": player_base,
                },
                timeout=15,
            )
            if resp.status_code == 429:
                wait = 1.5 * (attempt + 1)
                print(f"[-] generate.php 429, retry in {wait:.1f}s...")
                time.sleep(wait)
                continue
            resp.raise_for_status()
            token = resp.text.strip()
            if token and token != "__TOKEN__":
                print(f"[+] Stream token from {gen_url}")
                return token
        except Exception as e:
            last_err = e
            time.sleep(1.0 * (attempt + 1))
    print(f"[-] generate.php token fetch failed: {last_err or 'unknown'}")
    return None


def _fetch_stream_token_in_browser(driver, html: str, player_base: str) -> str | None:
    """Fetch JWT via the live browser context (avoids datacenter 429s on bare requests)."""
    gen_url = _extract(r"""\$\.get\(\s*["'](https?://[^"']+/generate\.php[^"']*)["']""", html)
    if not gen_url:
        host = _extract(r'https?://([a-zA-Z0-9.-]+)/pl/', html)
        if host:
            gen_url = f"https://{host}/generate.php"
    if not gen_url:
        return None
    try:
        token = driver.execute_async_script(
            """
            const url = arguments[0];
            const done = arguments[arguments.length - 1];
            fetch(url, { credentials: 'include', headers: { 'Accept': '*/*' } })
              .then(r => r.text())
              .then(t => done(t))
              .catch(() => done(null));
            """,
            gen_url,
        )
        if token:
            token = str(token).strip()
        if token and token != "__TOKEN__" and len(token) > 20:
            print(f"[+] Stream token via browser from {gen_url}")
            return token
    except Exception as e:
        print(f"[-] browser token fetch failed: {e}")
    return _fetch_stream_token(html, player_base)


def get_m3u8_urls(prorcp_hash: str, rcp_url: str, player_base: str) -> list[dict]:
    url = f"{player_base}/prorcp/{prorcp_hash}"
    resp = _get(url, referer=rcp_url)
    html = resp.text

    if "cf-turnstile" in html or "challenges.cloudflare.com" in html:
        raise ValueError(
            f"Cloudflare Turnstile is blocking {player_base}/prorcp — "
            "use --browser to open headed Chrome and pass the challenge"
        )

    file_match = (
        _extract(r'file:\s*["\']([^"\']+\.m3u8[^"\']*)["\']', html)
        or _extract(r'"file"\s*:\s*"([^"]+\.m3u8[^"]*)"', html)
        or _extract(r'master_urls\s*=\s*"([^"]+\.m3u8[^"]*)"', html)
    )
    if not file_match:
        raise ValueError("Could not find m3u8 file URLs in prorcp response")

    return _parse_file_field(file_match, html, player_base)


def get_m3u8_urls_browser(rcp_url: str, player_base: str, timeout_s: int = 60) -> list[dict]:
    """
    Open the RCP page in headed undetected Chrome (SeleniumBase UC),
    trigger the player iframe, wait for Turnstile to clear, then collect m3u8 URLs.
    """
    try:
        from seleniumbase import Driver
    except ImportError as e:
        raise RuntimeError(
            "SeleniumBase is required for --browser. Install with:\n"
            "  py -3.13 -m pip install seleniumbase"
        ) from e

    player_html = ""

    def consider_from_text(text: str) -> bool:
        nonlocal player_html
        if not text:
            return False
        # Wait for the real player payload (not just any m3u8 mention)
        if "master_urls" in text or ("generate.php" in text and ".m3u8" in text):
            player_html = text
            return True
        if "Playerjs" in text and ".m3u8" in text:
            player_html = text
            return True
        return False

    print(f"[*] Opening headed Chrome (UC) for Turnstile: {rcp_url[:80]}...")
    # --no-sandbox / disable-dev-shm-usage needed inside Docker
    driver = Driver(
        uc=True,
        headless=False,
        chromium_arg="--no-sandbox,--disable-dev-shm-usage,--disable-gpu",
    )
    try:
        driver.set_script_timeout(30)
    except Exception:
        pass
    try:
        driver.get(rcp_url)
        time.sleep(1.5)
        try:
            driver.execute_script("typeof loadIframe === 'function' && loadIframe()")
        except Exception:
            pass
        try:
            driver.execute_script(
                "var el=document.querySelector('#pl_but,#pl_but_background');"
                "if(el) el.click();"
            )
        except Exception:
            pass

        deadline = time.time() + timeout_s
        while time.time() < deadline:
            time.sleep(1)
            try:
                if consider_from_text(driver.page_source):
                    break
            except Exception:
                pass
            try:
                frames_html = driver.execute_script(
                    """
                    const out = [];
                    for (const f of document.querySelectorAll('iframe')) {
                      try { out.push(f.contentDocument.documentElement.outerHTML); }
                      catch (e) { out.push(''); }
                    }
                    return out;
                    """
                ) or []
                if any(consider_from_text(html) for html in frames_html):
                    break
            except Exception:
                pass

        if not player_html:
            raise ValueError(
                f"Browser timed out after {timeout_s}s waiting for player HTML "
                "(Turnstile did not clear — try again, or click the checkbox if shown)"
            )

        # Prefer waiting until generate.php / master_urls is present
        if "generate.php" not in player_html and "__TOKEN__" not in player_html:
            time.sleep(2)
            try:
                frames_html = driver.execute_script(
                    """
                    const out = [];
                    for (const f of document.querySelectorAll('iframe')) {
                      try { out.push(f.contentDocument.documentElement.outerHTML); }
                      catch (e) { out.push(''); }
                    }
                    return out;
                    """
                ) or []
                for html in frames_html:
                    consider_from_text(html)
            except Exception:
                pass

        file_match = (
            _extract(r'master_urls\s*=\s*"([^"]+\.m3u8[^"]*)"', player_html)
            or _extract(r'file:\s*["\']([^"\']+\.m3u8[^"\']*)["\']', player_html)
            or _extract(r'"file"\s*:\s*"([^"]+\.m3u8[^"]*)"', player_html)
        )
        if not file_match:
            urls = re.findall(r'https?://[^\s"\'<>]+\.m3u8[^\s"\'<>]*', player_html)
            if not urls:
                raise ValueError("Player loaded but no m3u8 URLs found in HTML")
            file_match = " or ".join(dict.fromkeys(urls))

        token = None
        if "__TOKEN__" in file_match or "__TOKEN__" in player_html:
            # Give the page a moment to call generate.php itself, then fetch JWT in-browser
            time.sleep(2)
            token = _fetch_stream_token_in_browser(driver, player_html, player_base)
            if not token:
                # Last resort: any resolved m3u8 already requested by the player
                try:
                    net_urls = driver.execute_script(
                        """
                        return performance.getEntriesByType('resource')
                          .map(e => e.name)
                          .filter(n => n.includes('.m3u8') && !n.includes('__TOKEN__'));
                        """
                    ) or []
                    if net_urls:
                        results = [{"url": u, "raw": u} for u in dict.fromkeys(net_urls)]
                        for entry in results:
                            print(f"    [browser] m3u8: {entry['url']}")
                        return results
                except Exception:
                    pass

        results = _parse_file_field(file_match, player_html, player_base, token=token)
        for entry in results:
            print(f"    [browser] m3u8: {entry['url']}")
        if not results:
            raise ValueError("Parsed player HTML but could not resolve stream URLs (token?)")
        return results
    finally:
        try:
            driver.quit()
        except Exception:
            pass


def _resolve_cdn_vars(html: str, player_base: str) -> dict:
    """
    Resolve {v1}..{v5} CDN hostname placeholders dynamically.

    The prorcp page loads an obfuscated JS file (filename changes per deploy)
    that contains the CDN hostnames. We:
      1. Extract the JS filename from the prorcp HTML (document.write pattern)
      2. Run it through Node.js in a sandboxed VM to extract the hostnames
      3. Fall back to last-known-good hostnames if Node fails
    """
    import subprocess, json, os

    vars_map = {}

    # Step 1: find the CDN vars JS filename - it's injected via document.write
    # Pattern: document.write("<script ... src='/HASH.js?_=TIMESTAMP'...")
    js_path = _extract(r"document\.write\([^)]*src='(/[a-f0-9]+\.js\?[^']+)'", html)
    if not js_path:
        # Fallback pattern
        js_path = _extract(r'src=["\']/(([a-f0-9]{32})\.js\?[^"\']+)["\']', html)

    if js_path:
        cdn_js_url = f"{player_base}{js_path}"
        print(f"[*] CDN vars JS: {cdn_js_url}")

        # Step 2: run through Node.js extractor
        node_script = os.path.join(os.path.dirname(__file__), "extract_cdn_vars.js")
        try:
            result = subprocess.run(
                ["node", node_script, cdn_js_url],
                capture_output=True, text=True, timeout=10
            )
            if result.stdout.strip():
                parsed = json.loads(result.stdout.strip())
                if parsed:
                    vars_map = parsed
                    print(f"[+] CDN vars resolved via Node: {vars_map}")
        except Exception as e:
            print(f"[-] Node extraction failed: {e}")

    # Step 3: fallback hostnames (rotated often; Node path is preferred)
    host = urlparse(player_base).netloc or "cloudorchestranova.com"
    FALLBACK = {
        "v1": host,
        "v2": host,
        "v3": host,
        "v4": host,
        "v5": host,
    }
    for k, v in FALLBACK.items():
        if k not in vars_map:
            vars_map[k] = v

    return vars_map


def probe_hls_qualities(master_url: str, referer: str) -> list[dict]:
    """
    Fetch a master.m3u8 and parse variant quality info.

    Returns list of:
      {resolution, width, height, bandwidth, frame_rate, codecs, label, url}
    """
    try:
        resp = SESSION.get(
            master_url,
            headers={
                "Referer": referer,
                "Origin": referer.rstrip("/"),
                "User-Agent": HEADERS["User-Agent"],
                "Accept": "*/*",
            },
            timeout=15,
        )
        resp.raise_for_status()
    except Exception as e:
        print(f"[-] quality probe failed: {e}")
        return []

    text = resp.text
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    qualities = []

    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("#EXT-X-STREAM-INF:"):
            attrs = line.split(":", 1)[1]
            meta = _parse_m3u8_attributes(attrs)
            uri = None
            if i + 1 < len(lines) and not lines[i + 1].startswith("#"):
                uri = urljoin(master_url, lines[i + 1])
                i += 1

            resolution = meta.get("RESOLUTION")
            width = height = None
            if resolution and "x" in resolution.lower():
                try:
                    w, h = resolution.lower().split("x", 1)
                    width, height = int(w), int(h)
                except ValueError:
                    pass

            bandwidth = meta.get("BANDWIDTH")
            try:
                bandwidth = int(bandwidth) if bandwidth else None
            except ValueError:
                bandwidth = None

            frame_rate = meta.get("FRAME-RATE")
            try:
                frame_rate = float(frame_rate) if frame_rate else None
            except ValueError:
                frame_rate = None

            label = meta.get("NAME") or meta.get("VIDEO")
            if not label and height:
                label = f"{height}p"
            elif not label and bandwidth:
                label = f"{bandwidth // 1000}kbps"

            qualities.append({
                "label": label,
                "resolution": resolution,
                "width": width,
                "height": height,
                "bandwidth": bandwidth,
                "frame_rate": frame_rate,
                "codecs": meta.get("CODECS"),
                "url": uri,
            })
        i += 1

    # Sort highest resolution / bandwidth first
    qualities.sort(
        key=lambda q: (q.get("height") or 0, q.get("bandwidth") or 0),
        reverse=True,
    )
    return qualities


def _parse_m3u8_attributes(attr_str: str) -> dict:
    """Parse KEY=VALUE,KEY="quoted" pairs from an EXT-X-STREAM-INF line."""
    out = {}
    for m in re.finditer(r'([A-Z0-9-]+)=("([^"]*)"|[^,]*)', attr_str):
        key = m.group(1)
        raw = m.group(2)
        out[key] = raw[1:-1] if raw.startswith('"') else raw
    return out


# ---------------------------------------------------------------------------
# Main scraper entry point
# ---------------------------------------------------------------------------

def scrape(
    media_type: str,
    media_id: str,
    season: int = None,
    episode: int = None,
    use_browser: bool = False,
    browser_timeout: int = 60,
    probe_qualities: bool = True,
) -> dict:
    """
    Scrape stream URLs from vidsrc.to.

    Args:
        media_type: 'movie' or 'tv'
        media_id:   IMDB id (tt...) or TMDB numeric id
        season:     Season number (TV only)
        episode:    Episode number (TV only)
        use_browser: Use headed Chrome for the prorcp/Turnstile hop
        browser_timeout: Seconds to wait for Turnstile + m3u8
        probe_qualities: Fetch each master.m3u8 and attach variant quality info

    Returns:
        dict with 'streams' list and metadata
    """
    print(f"[*] Fetching: {media_type}/{media_id}" + (f" S{season:02d}E{episode:02d}" if season else ""))

    # Step 1
    vsembed_url, vidsrc_url = get_vsembed_url(media_type, media_id, season, episode)
    print(f"[+] vsembed URL: {vsembed_url}")

    # Step 2
    rcp_hash, all_hashes, player_base = get_rcp_sources(vsembed_url, referer=vidsrc_url)
    print(f"[+] Player host: {player_base}")
    print(f"[+] RCP hash(es): {len(all_hashes)} source(s) found")

    streams = []
    errors = []
    referer = player_base + "/"

    for i, h in enumerate(all_hashes):
        try:
            print(f"[*] Processing source {i+1}/{len(all_hashes)}: {h[:40]}...")
            rcp_url = f"{player_base}/rcp/{h}"

            if use_browser:
                m3u8_list = get_m3u8_urls_browser(
                    rcp_url, player_base=player_base, timeout_s=browser_timeout
                )
            else:
                # Step 3 + 4 via requests; on Turnstile, optionally fall through
                prorcp_hash = get_prorcp_hash(h, referer=vsembed_url, player_base=player_base)
                print(f"[+] prorcp hash: {prorcp_hash[:40]}...")
                try:
                    m3u8_list = get_m3u8_urls(prorcp_hash, rcp_url=rcp_url, player_base=player_base)
                except ValueError as e:
                    if "Turnstile" in str(e):
                        print(f"[!] {e}")
                        print("[*] Falling back to headed Chrome...")
                        m3u8_list = get_m3u8_urls_browser(
                            rcp_url, player_base=player_base, timeout_s=browser_timeout
                        )
                    else:
                        raise

            print(f"[+] Found {len(m3u8_list)} m3u8 URL(s)")

            # Qualities are usually identical across CDN mirrors — probe once per source
            qualities = []
            if probe_qualities and m3u8_list:
                qualities = probe_hls_qualities(m3u8_list[0]["url"], referer)
                if qualities:
                    labels = ", ".join(
                        q.get("label") or q.get("resolution") or "?" for q in qualities
                    )
                    print(f"[+] Qualities: {labels}")

            for entry in m3u8_list:
                item = {
                    "source_index": i,
                    "url": entry["url"],
                    "type": "hls",
                    "referer": referer,
                }
                if qualities:
                    item["qualities"] = qualities
                    best = qualities[0]
                    item["best_quality"] = best.get("label") or best.get("resolution")
                streams.append(item)
                print(f"    -> {entry['url']}")

        except Exception as e:
            errors.append({"source_index": i, "error": str(e)})
            print(f"[-] Source {i+1} failed: {e}")

    return {
        "media_type": media_type,
        "media_id": media_id,
        "season": season,
        "episode": episode,
        "player_host": player_base,
        "streams": streams,
        "errors": errors,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    import argparse, json

    parser = argparse.ArgumentParser(description="VidSrc.to stream scraper")
    parser.add_argument("id", help="IMDB (tt...) or TMDB numeric ID")
    parser.add_argument("--type", choices=["movie", "tv"], default="movie", help="Media type (default: movie)")
    parser.add_argument("--season", type=int, help="Season number (TV only)")
    parser.add_argument("--episode", type=int, help="Episode number (TV only)")
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    parser.add_argument(
        "--browser",
        action="store_true",
        help="Use headed Chrome for the Turnstile-protected player hop",
    )
    parser.add_argument(
        "--browser-timeout",
        type=int,
        default=60,
        help="Seconds to wait for Turnstile + m3u8 (default: 60)",
    )
    parser.add_argument(
        "--out-dir",
        help="Write a local .m3u8 playlist file into this folder (e.g. D:\\HA\\PlexMedia\\M3U8)",
    )
    parser.add_argument(
        "--out-name",
        help="Filename stem for --out-dir (default: movie title / id). Example: Spiderman",
    )
    args = parser.parse_args()

    result = scrape(
        args.type,
        args.id,
        args.season,
        args.episode,
        use_browser=args.browser,
        browser_timeout=args.browser_timeout,
    )

    if args.out_dir and result.get("streams"):
        from m3u8_export import write_m3u8_file

        stream = result["streams"][0]
        title = args.out_name or f"{args.type}-{args.id}"
        path = write_m3u8_file(
            args.out_dir,
            title=title,
            stream_url=stream["url"],
            referer=stream.get("referer") or "https://cloudorchestranova.com/",
            filename=args.out_name or title,
        )
        print(f"[+] Wrote local playlist: {path}")

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print("\n=== STREAMS ===")
        if result["streams"]:
            for s in result["streams"]:
                print(s["url"])
        else:
            print("No streams found.")
        if result["errors"]:
            print("\n=== ERRORS ===")
            for e in result["errors"]:
                print(f"Source {e['source_index']}: {e['error']}")


if __name__ == "__main__":
    main()
