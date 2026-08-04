"""Resolve a single movie/TV episode stream from vidsrc.

Prints one JSON object to stdout. All scraper/Chrome noise is discarded.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

from scraper import scrape

_OUT = sys.stdout


def main() -> None:
    parser = argparse.ArgumentParser(description="Resolve one vidsrc stream as JSON")
    parser.add_argument("id", help="TMDB or IMDB id")
    parser.add_argument("--type", choices=("movie", "tv"), default="movie")
    parser.add_argument("--season", type=int, default=None)
    parser.add_argument("--episode", type=int, default=None)
    parser.add_argument("--browser-timeout", type=int, default=60)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    if args.type == "tv":
        if not args.season or not args.episode:
            print(
                json.dumps({"ok": False, "error": "season and episode are required for type=tv"}),
                file=_OUT,
            )
            sys.exit(2)

    with open(os.devnull, "w", encoding="utf-8") as devnull:
        sys.stdout = devnull
        sys.stderr = devnull
        try:
            result = scrape(
                args.type,
                str(args.id),
                season=args.season,
                episode=args.episode,
                use_browser=not args.no_browser,
                browser_timeout=args.browser_timeout,
                probe_qualities=True,
            )
            payload = {"ok": True, **result}
        except Exception as exc:  # noqa: BLE001
            payload = {"ok": False, "error": str(exc)}

    _OUT.write(json.dumps(payload, separators=(",", ":")) + "\n")
    _OUT.flush()
    sys.exit(0 if payload.get("ok") and payload.get("streams") else 1)


if __name__ == "__main__":
    main()
