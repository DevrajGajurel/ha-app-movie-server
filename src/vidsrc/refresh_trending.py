"""Refresh TMDB trending movie streams.

Emits NDJSON on stdout (one event per line) so Movie Server can write Redis
after each title instead of waiting for the full batch:

  {"event":"start","window":"week","total":20}
  {"event":"movie","index":1,"total":20,"movie":{...}}
  {"event":"done","refreshedAt":"...","count":20,"playable":12,"window":"week"}

Progress logs go to stderr.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from typing import Literal

import requests

from scraper import scrape

TMDB_API = "https://api.themoviedb.org/3"
TMDB_IMG = "https://image.tmdb.org/t/p"
REFERER_DEFAULT = "https://cloudorchestranova.com/"


def _tmdb_key() -> str:
    key = os.environ.get("TMDB_API_KEY", "").strip()
    if not key:
        raise SystemExit("TMDB_API_KEY is not set")
    return key


# Keep a private handle to real stdout for NDJSON. Scraper/Chrome/undetected-
# chromedriver print progress to stdout; we redirect that to stderr so Node
# only sees structured events on stdout.
_NDJSON_OUT = sys.stdout


def emit(event: dict) -> None:
    _NDJSON_OUT.write(json.dumps(event, separators=(",", ":")) + "\n")
    _NDJSON_OUT.flush()


def fetch_trending(window: Literal["day", "week"], limit: int) -> list[dict]:
    resp = requests.get(
        f"{TMDB_API}/trending/movie/{window}",
        params={"api_key": _tmdb_key(), "language": "en-US"},
        timeout=20,
    )
    resp.raise_for_status()
    results = resp.json().get("results", [])
    out = []
    for m in results[:limit]:
        poster_path = m.get("poster_path")
        backdrop_path = m.get("backdrop_path")
        release = m.get("release_date") or ""
        out.append(
            {
                "tmdbId": m["id"],
                "title": m.get("title"),
                "overview": m.get("overview") or None,
                "year": release[:4] if release else None,
                "rating": m.get("vote_average"),
                "poster": f"{TMDB_IMG}/w342{poster_path}" if poster_path else None,
                "backdrop": f"{TMDB_IMG}/w1280{backdrop_path}" if backdrop_path else None,
                "releaseDate": release or None,
                "popularity": m.get("popularity"),
            }
        )
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description="Refresh vidsrc trending streams (NDJSON on stdout)")
    parser.add_argument("--window", choices=("day", "week"), default="week")
    parser.add_argument("--limit", type=int, default=int(os.environ.get("STREAM_TRENDING_LIMIT", "20")))
    parser.add_argument("--delay", type=float, default=2.0)
    parser.add_argument("--browser-timeout", type=int, default=60)
    args = parser.parse_args()

    limit = max(1, min(20, args.limit))
    movies = fetch_trending(args.window, limit)
    total = len(movies)
    playable = 0

    # Route all incidental prints (scraper + deps) to stderr for the scrape loop.
    sys.stdout = sys.stderr

    emit({"event": "start", "window": args.window, "total": total, "refererHint": REFERER_DEFAULT})

    for i, movie in enumerate(movies):
        entry = {
            **movie,
            "referer": REFERER_DEFAULT,
            "playerHost": None,
            "streams": [],
            "errors": [],
        }
        try:
            print(
                f"[vidsrc-refresh] [{i + 1}/{total}] {movie.get('title')} ({movie.get('tmdbId')})",
                file=sys.stderr,
            )
            result = scrape(
                "movie",
                str(movie["tmdbId"]),
                use_browser=True,
                browser_timeout=args.browser_timeout,
            )
            entry["streams"] = [
                {
                    "url": s["url"],
                    "type": s.get("type", "hls"),
                    "referer": s.get("referer", REFERER_DEFAULT),
                    "bestQuality": s.get("best_quality"),
                    "qualities": [
                        {
                            "label": q.get("label"),
                            "resolution": q.get("resolution"),
                            "width": q.get("width"),
                            "height": q.get("height"),
                            "bandwidth": q.get("bandwidth"),
                            "frameRate": q.get("frame_rate"),
                            "codecs": q.get("codecs"),
                            "url": q.get("url"),
                        }
                        for q in (s.get("qualities") or [])
                        if q.get("url")
                    ],
                }
                for s in result.get("streams", [])
            ]
            entry["errors"] = result.get("errors", [])
            entry["playerHost"] = result.get("player_host")
            if entry["streams"]:
                entry["referer"] = entry["streams"][0].get("referer") or REFERER_DEFAULT
                playable += 1
        except Exception as exc:  # noqa: BLE001
            entry["errors"] = [{"error": str(exc)}]
            print(f"[vidsrc-refresh] failed: {exc}", file=sys.stderr)

        emit({"event": "movie", "index": i + 1, "total": total, "movie": entry})

        if i < total - 1 and args.delay > 0:
            time.sleep(args.delay)

    emit(
        {
            "event": "done",
            "refreshedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "window": args.window,
            "count": total,
            "playable": playable,
            "refererHint": REFERER_DEFAULT,
        }
    )


if __name__ == "__main__":
    main()
