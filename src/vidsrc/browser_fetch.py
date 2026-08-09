"""
Generic Cloudflare-Turnstile-clearing page fetch.

Node's outbound scrapes (movie_server/main.js) send real browser headers,
which is enough for most of the hops the download flow crosses (filmyfly ->
linkmake.in etc.) - but some final hosts (e.g. new6.filesdl.top) put a real
Cloudflare Turnstile challenge in front, which no request header can pass.
This mirrors scraper.py's get_m3u8_urls_browser Turnstile-clearing loop
(same SeleniumBase UC driver, same Xvfb :99 the Docker image already runs
for vidsrc), generalized to "open this URL, wait for the challenge to
clear, hand back the resulting HTML" instead of vidsrc-specific m3u8
extraction - main.js's own selector logic (.dlbtn a, a[class*="button"])
runs against the HTML this returns.

Usage: python browser_fetch.py <url> [--referer URL] [--timeout SECONDS]
Emits exactly one JSON object on the LAST line of stdout:
  {"ok": true, "url": "<final url after redirects>", "html": "<page source>"}
  {"ok": false, "error": "..."}
Everything else (driver startup banners, progress prints) goes to stderr so
Node can safely take "the last stdout line" as the result.
"""

from __future__ import annotations

import contextlib
import json
import os
import sys
import time


def _is_challenge(html: str) -> bool:
    return bool(html) and (
        "Just a moment" in html
        or "challenges.cloudflare.com" in html
        or "cf-turnstile" in html
    )


@contextlib.contextmanager
def _stdout_to_stderr():
    """SeleniumBase/uc_driver banners go to stdout by default — park them on stderr
    so our final JSON line is the only thing Node sees on stdout."""
    real_stdout = sys.stdout
    try:
        sys.stdout = sys.stderr
        yield
    finally:
        sys.stdout = real_stdout


def _try_click_captcha(driver) -> None:
    # Prefer CDP/JS click (no tkinter). Fall back to OS-level pyautogui click
    # when available — that's what clears stubborn Turnstile widgets.
    for method_name in ("uc_click_captcha", "uc_gui_click_captcha"):
        method = getattr(driver, method_name, None)
        if not callable(method):
            continue
        try:
            method()
            print(f"[*] {method_name}() ok", file=sys.stderr)
            return
        except Exception as e:
            print(f"[!] {method_name} failed: {e}", file=sys.stderr)


def fetch_past_challenge(url: str, referer: str | None, timeout_s: int) -> dict:
    try:
        from seleniumbase import Driver
    except ImportError as e:
        return {"ok": False, "error": f"SeleniumBase is not installed: {e}"}

    # Ensure Xvfb display is set inside Docker even if the parent env dropped it.
    os.environ.setdefault("DISPLAY", ":99")

    print(f"[*] Opening headed Chrome (UC) for: {url[:100]}", file=sys.stderr)
    driver = None
    try:
        with _stdout_to_stderr():
            driver = Driver(
                uc=True,
                headless=False,
                chromium_arg="--no-sandbox,--disable-dev-shm-usage,--disable-gpu",
            )
            try:
                driver.set_script_timeout(30)
            except Exception:
                pass

            if referer:
                # Best-effort: land on the referer first so the target's own
                # Cloudflare rules see an in-context navigation rather than a
                # driver hitting the URL cold - matches how a real click arrives.
                try:
                    driver.get(referer)
                    time.sleep(0.5)
                except Exception as e:
                    print(f"[!] referer navigation failed: {e}", file=sys.stderr)

            # uc_open_with_reconnect() disconnects/reconnects chromedriver
            # around the navigation (standard UC-mode anti-detection technique).
            try:
                driver.uc_open_with_reconnect(url, 4)
            except Exception as e:
                print(f"[!] uc_open_with_reconnect failed, falling back to get(): {e}", file=sys.stderr)
                driver.get(url)

            time.sleep(1)
            _try_click_captcha(driver)

            deadline = time.time() + timeout_s
            html = ""
            clicked_again = False
            while time.time() < deadline:
                try:
                    html = driver.page_source or ""
                except Exception as e:
                    print(f"[!] page_source failed: {e}", file=sys.stderr)
                    html = ""
                if html and not _is_challenge(html):
                    break
                # One retry click partway through, in case the first click
                # landed before the widget had fully rendered.
                if not clicked_again and time.time() > deadline - timeout_s / 2:
                    clicked_again = True
                    _try_click_captcha(driver)
                time.sleep(1)

            if _is_challenge(html):
                return {
                    "ok": False,
                    "error": f"Turnstile did not clear within {timeout_s}s",
                }
            if not html:
                return {"ok": False, "error": "Browser returned no page content"}

            try:
                final_url = driver.current_url
            except Exception:
                final_url = url

            print(f"[+] Challenge cleared: {final_url}", file=sys.stderr)
            return {"ok": True, "url": final_url, "html": html}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
    finally:
        if driver is not None:
            try:
                with _stdout_to_stderr():
                    driver.quit()
            except Exception:
                pass


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Fetch a page past a Cloudflare Turnstile challenge")
    parser.add_argument("url")
    parser.add_argument("--referer", default=None)
    parser.add_argument("--timeout", type=int, default=45)
    args = parser.parse_args()

    try:
        result = fetch_past_challenge(args.url, args.referer, args.timeout)
    except Exception as e:
        result = {"ok": False, "error": f"Unhandled {type(e).__name__}: {e}"}

    # Always emit one JSON object on real stdout — last line Node parses.
    sys.stdout.write(json.dumps(result) + "\n")
    sys.stdout.flush()
    sys.exit(0 if result.get("ok") else 1)


if __name__ == "__main__":
    main()
