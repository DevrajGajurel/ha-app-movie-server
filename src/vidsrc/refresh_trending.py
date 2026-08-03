"""Refresh TMDB trending movie streams and print one JSON catalog to stdout.

Used by Movie Server's streamCatalog.js (no local EXPORT_DIR writes).
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
    parser = argparse.ArgumentParser(description="Refresh vidsrc trending streams (JSON on stdout)")
    parser.add_argument("--window", choices=("day", "week"), default="week")
    parser.add_argument("--limit", type=int, default=int(os.environ.get("STREAM_TRENDING_LIMIT", "20")))
    parser.add_argument("--delay", type=float, default=2.0)
    parser.add_argument("--browser-timeout", type=int, default=60)
    args = parser.parse_args()

    limit = max(1, min(20, args.limit))
    movies = fetch_trending(args.window, limit)
    catalog_movies = []

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
                f"[vidsrc-refresh] [{i + 1}/{len(movies)}] {movie.get('title')} ({movie.get('tmdbId')})",
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
        except Exception as exc:  # noqa: BLE001 - surface per-title failures in catalog
            entry["errors"] = [{"error": str(exc)}]
            print(f"[vidsrc-refresh] failed: {exc}", file=sys.stderr)

        catalog_movies.append(entry)
        if i < len(movies) - 1 and args.delay > 0:
            time.sleep(args.delay)

    payload = {
        "refreshedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "window": args.window,
        "count": len(catalog_movies),
        "playable": sum(1 for m in catalog_movies if m.get("streams")),
        "refererHint": REFERER_DEFAULT,
        "movies": catalog_movies,
    }
    sys.stdout.write(json.dumps(payload))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
