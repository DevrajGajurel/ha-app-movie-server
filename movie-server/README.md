# Home Assistant Add-on: Movie Server

Run the Movie Server dashboard inside Home Assistant with Ingress (sidebar panel).

## Required options

- `main_url` — listing site to scrape

## Common options

- `tmdb_api_key` — [TMDB API key](https://www.themoviedb.org/settings/api) for posters, genres, and filters
- `download_dir` — defaults to `/media` (e.g. `/media/Plex_Media` for Plex)
- `max_pages` — defaults to `5`

## Advanced options (hidden by default)

On the **Configuration** tab, open **Show unused optional configuration options** to change:

- `initial_pages` — pages loaded first (default `2`)
- `hd_keywords` — HD badge keywords
- `k4_keywords` — 4K badge keywords

## Notes

- Downloads are saved under the configured `download_dir` (default `/media`).
- Open the UI from the add-on page or the **Movie Server** sidebar entry.
