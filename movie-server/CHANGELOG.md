# Changelog

## 1.2.7

- Show CSS selectors tried when no download links are found, with match counts for easier debugging.
- Fix local Docker port mapping so `${PORT}` matches inside and outside the container.

## 1.2.6

- Add streaming endpoint (`/api/downloads/play`) for already-downloaded movies with HTTP range support.
- Sync Home Assistant add-on version with the app release.

## 1.2.5

- Add Play button and streaming support for downloaded movies in the dashboard.

## 1.2.4

- Add CORS headers so the Tizen TV client can call the API cross-origin.
- Include TMDB backdrop images in movie metadata for TV hero banners.

## 1.2.3

- Fix TMDB title parsing for filmyfly-style names: cut metadata at the year instead of stripping `movie` from real titles.
- Support alternate titles in parentheses, space-insensitive matching, and Hindi spelling variants.
- Reject junk TMDB results (trailers, audio launches) while restoring posters for South/Bollywood listings.

## 1.2.2

- Improve TMDB matching by cleaning source titles (year, language, quality, Bollywood tags) before search.
- Score results by title similarity and release year instead of popularity alone.
- Skip weak matches so incorrect posters/titles are not shown.

## 1.2.1

- Filter preset chips now support multi-select (combine HD, 4K, movies, TV, recent, top-rated).
- Add **Source order** sort option to list movies in the same order as the source site.

## 1.2.0

- Add Emby integration with optional `emby_url` and `emby_api_key` in add-on configuration.
- `POST /api/emby/refresh` triggers a full library scan; downloads auto-notify Emby when configured.

## 1.1.1

- Add HD (and 4K) quality filter dropdown plus an HD only preset chip.

## 1.1.0

- Persist downloaded status across restarts by scanning the download folder.
- Save downloads into `Title (tmdb-<id>)` folders with a `.movieserver.json` marker for reliable matching.
- Show the downloaded checkmark for previously downloaded movies detected in the folder (by TMDB ID or title).

## 1.0.9

- Improve mobile layout with horizontal movie cards, touch-friendly buttons, and a bottom-sheet download modal.
- Filters stack in a 2-column grid with horizontally scrollable preset chips.

## 1.0.8

- Fix HD/4K badges missing in Home Assistant when optional keyword config is blank or overridden by empty env vars.
- Re-apply quality tags after TMDB enrichment and log loaded keyword lists on startup.

## 1.0.7

- Document and enforce defaults for optional advanced options when left blank in HA config.
- Defaults: `initial_pages=2`, HD/4K keyword lists unchanged.

## 1.0.6

- Show a compact downloaded checkmark on movie cards; hover to see the saved file path.
- Keep slim progress bar for active downloads and a small icon for failures.

## 1.0.5

- Set default source URL to `https://filmyfly.luxe/` for new installs.

## 1.0.4

- Align app and integration version numbers with the Home Assistant add-on release.

## 1.0.3

- Fix downloads saving to `/app/downloads` instead of the configured HA folder (env was read before `.env` loaded).
- Log each download path on queue and completion; show saved path on movie cards.
- Default download folder is now `/media/Plex_Media`.

## 1.0.2

- Move `initial_pages`, `hd_keywords`, and `k4_keywords` to optional advanced config (hidden until expanded in the UI).
- Defaults are applied in `run.sh` when those options are not set.

## 1.0.1

- Remove dashboard header and in-UI config editors (URL, pages); configure via Home Assistant add-on options.
- Add `icon.png` branding for the Home Assistant add-on store.

## 1.0.0

- Initial Home Assistant add-on packaging for Movie Server.
- Ingress sidebar panel, TMDB enrichment, filters, and server-side downloads to `/media`.
- Dockerfile installs app from `src/movie_server` in this repository.
