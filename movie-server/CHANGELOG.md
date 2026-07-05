# Changelog

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
