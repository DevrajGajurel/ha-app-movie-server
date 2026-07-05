# Home Assistant Add-on: Movie Server

Run the Movie Server dashboard inside Home Assistant with Ingress (sidebar panel).

## Required options

- `main_url` — listing site to scrape

## Common options

- `tmdb_api_key` — [TMDB API key](https://www.themoviedb.org/settings/api) for posters, genres, and filters
- `download_dir` — defaults to `/media` (e.g. `/media/Plex_Media` for Plex)
- `max_pages` — defaults to `5`

## Advanced options (hidden by default)

On the **Configuration** tab, open **Show unused optional configuration options** to change these. Leave blank to use defaults:

- `initial_pages` — `2`
- `hd_keywords` — `720p,1080p,HD,HDRip,WEB-DL,BluRay,Blu-Ray`
- `k4_keywords` — `2160p,4k,4K,UHD`

## Notes

- Downloads are saved under the configured `download_dir` (default `/media`).
- Open the UI from the add-on page or the **Movie Server** sidebar entry.
