# Home Assistant Add-on: Movie Server

Run the Movie Server dashboard inside Home Assistant with Ingress (sidebar panel).

## Required options

- `main_url` — listing site to scrape

## Recommended options

- `tmdb_api_key` — [TMDB API key](https://www.themoviedb.org/settings/api) for posters, genres, and filters
- `download_dir` — defaults to `/media` (HA media folder)

## Notes

- Downloads are saved under the configured `download_dir` (default `/media`).
- Open the UI from the add-on page or the **Movie Server** sidebar entry.
