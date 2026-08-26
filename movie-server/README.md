# Home Assistant Add-on: Movie Server

Run the Movie Server dashboard inside Home Assistant with Ingress (sidebar panel).

## Required options

- `main_url` — listing site to scrape

## Common options

- `tmdb_api_key` — [TMDB API key](https://www.themoviedb.org/settings/api) for posters, genres, and filters
- `download_dir` — defaults to `/media` (e.g. `/media/Plex_Media` for Plex)
- `max_pages` — defaults to `5`
- `emby_url` — Emby server URL 
- `emby_api_key` — Emby API key from Dashboard → Advanced → API Keys

## Advanced options (hidden by default)

On the **Configuration** tab, open **Show unused optional configuration options** to change these. Leave blank to use defaults:

- `initial_pages` — `2`
- `hd_keywords` — `720p,1080p,HD,HDRip,WEB-DL,BluRay,Blu-Ray`
- `k4_keywords` — `2160p,4k,4K,UHD`
- `emby_path_prefix` — only if Emby uses a different path than `download_dir`
- `secondary_url` — optional second listing site (4khdhub-style `movie-card` pages); titles are merged as HD and downloads resolve via shegu.st using TMDB id

## Notes

- Downloads are saved under the configured `download_dir` (default `/media`).
- When Emby is configured, new downloads trigger a library update automatically.
- Open the UI from the add-on page or the **Movie Server** sidebar entry.
- The add-on image copies `movie-server/app` (the Node server) and installs Debian Node 18 + ffmpeg + aria2. It does not clone GitHub or install Node from NodeSource.
- `flaresolverr_url` (**required**) — a [FlareSolverr](https://github.com/FlareSolverr/FlareSolverr) instance you run yourself. Every download-page fetch (the quality list and the direct/file-host resolution) goes through it unconditionally now, not as a fallback - the source sites' anti-bot fronts (Cloudflare Turnstile, "vDDoS" JS challenges, and others) change often enough that a plain `fetch()` attempt first was a losing game. Point it at FlareSolverr's `/v1` endpoint using its **IP address**, e.g. `http://192.168.1.50:8191/v1`, not a `.local` mDNS hostname (e.g. `homeassistant.local`) - this container has no mDNS resolver, so a `.local` name fails with a DNS error even though it resolves fine from your browser or another machine on the LAN. Nothing runs inside this image for it - the add-on won't start until this is set.
