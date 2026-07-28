# Changelog

## 1.4.26

- Fixed the row title and poster bottoms getting clipped after pinning the hero: measured it precisely — a single row (title + poster) needs ~550px at the current poster size, but the 66vh hero only left 367px for rows. Rebalanced to a 44vh hero / 44vh-to-bottom rows split, which leaves ~605px — enough for one full row plus a peek of the next row's title, verified against the actual measured row height rather than guessing.

## 1.4.25

- Hero is now truly fixed at the top (Prime Video-style) — only the rows list scrolls independently beneath it, so the hero never scrolls out of view no matter how far down you browse. Previously the whole page scrolled as one unit, so navigating into later rows scrolled the hero off-screen entirely.
- Fixed the real cause of the poster focus border still wrapping the title text: a separate stylesheet (css/tv.css, loaded after the main styles) has a generic `[tabindex="0"]:focus` rule for every other focusable element, which matches poster cards too with equal CSS specificity — and being loaded later, it was winning over our own override and drawing round the whole card. Poster cards' own outline-suppression is now `!important` so their custom ring (scoped to just the image) always wins.

## 1.4.24

- TV app: reworked the hero to match Prime Video's actual behavior — removed the Play/Download/More Info buttons from the hero entirely (Enter on a poster still opens its detail page as before; the dedicated remote Play/Pause button now plays a focused, already-downloaded poster directly without opening detail page first). The hero now reliably reflects whatever poster is currently focused in *any* row, not just Continue Watching.
- Fixed the actual cause of that: the hero-follows-focus feature depended on the native browser `focus` event, which isn't reliably delivered in every state (confirmed `document.hasFocus()` can be false while `document.activeElement` still updates correctly) — the same class of "don't trust native platform behavior" issue as the video controls and Enter-activation fixes. `focus-manager.js` now dispatches its own `tv-focus-changed` event directly whenever it moves focus, so the hero (and anything else that needs to react to focus) no longer depends on the platform delivering a native event.

## 1.4.23

- Fixed Enter/OK not activating focused buttons (e.g. the exit-confirmation dialog): confirmed a synthetic Enter keydown doesn't trigger a browser's native "click the focused button" behavior, and Tizen's WebKit isn't reliable here either — same class of issue as the native video controls. Enter now explicitly calls `.click()` on the focused button/link itself instead of assuming the platform will.
- TV app: selecting a poster for a movie that's already downloaded now plays it directly instead of opening the detail page first (still opens detail page for movies you haven't downloaded yet).
- Poster focus outline: suppressed WebKit's own tap/focus highlight overlay (`-webkit-tap-highlight-color`), which was drawing around the whole card (image + title) independent of our custom focus ring that's meant to wrap just the poster image.

## 1.4.22

- Removed the on-screen debug log now that the media-key privilege fix is confirmed working.
- Stopped registering `"Return"` as a TV input key — it isn't a valid key name (was throwing `InvalidValuesError`), and per Samsung's docs Back/arrows/Enter are delivered automatically without registration anyway, so it was a no-op that only produced log noise.
- TV app: pressing Back on the main posters page (nothing else open) now shows an "Exit Movie Server?" confirmation instead of exiting immediately, so an accidental extra Back press doesn't kick you out of the app.

## 1.4.21

- Fixed the remote's dedicated media keys (Play/Pause, Rewind, Fast-Forward, Stop) not working at all: config.xml declared the privilege as `tvinputdevice` (missing a dot), which isn't a real Tizen privilege string, so `tizen.tvinputdevice.registerKey()` silently failed for every key. Corrected to `http://tizen.org/privilege/tv.inputdevice` per Samsung's docs — this is a public-level privilege, no Partner certificate needed.
- Removed the temporary on-screen debug log used to diagnose the above.

## 1.4.20

- TV app: audio and subtitle tracks are now chosen DURING playback (press Up to open the panel) instead of on a screen before pressing Play. Subtitles switch instantly (just an overlay track); switching audio reloads the stream with the new track and seeks back to where you were, since it's not adaptive streaming.
- API: `GET /api/downloads/versions` now also lists text-based subtitle tracks (SRT/ASS/SSA/mov_text — bitmap formats like PGS can't convert to WebVTT so aren't offered). New `GET /api/downloads/subtitle?file=&track=` extracts and converts one subtitle stream to WebVTT.
- Fixed non-default audio track playback failing with "unsupported container/codec": the remux was outputting fragmented MP4, which Tizen's player rejected outright even for codecs it plays fine via direct passthrough. Switched to Matroska remuxing instead, which streams to a pipe without needing fragmentation and matches the container these downloads already are.
- Poster cards are ~14% larger in both regular rows and the Top 10 row.
- Seek step reduced from 30s to 10s per press (still accelerates up to 60s while held).
- Temporary: added an on-screen debug log to diagnose the remote's dedicated Play/Pause button not responding — will be removed once resolved.

## 1.4.19

- TV app: Continue Watching home row (newest resume first) and cyan progress strips on posters with saved playback position.
- API: `GET /api/downloads/progress` with no query params returns all in-progress resume entries for Continue Watching.

## 1.4.18

- TV app: focused poster updates the hero (backdrop, title, meta, Play/Download) with a short debounce — Jellyfin/Netflix-style spotlight browsing.

## 1.4.17

- Skip three.js for the Movie Server UI (wrong tool for a 2D poster browser on Tizen); polish the TV app with CSS-only hero Ken Burns, stronger focus scale on posters, and horizontal scroll-snap.

## 1.4.16

- TV app: keep recent search queries when reopening Search and add a Library menu that shows downloaded movies for direct playback.

## 1.4.15

- TV app: make poster rails slightly larger and restyle the browse screen with a darker Prime Video-inspired look, cyan accents, pill hero actions, and stronger focus rings.

## 1.4.14

- When local search has no matches, scrape the source site `search.html?search=...` (same `.row-thumb-link` parsing) and show those movies in the web and TV UIs.

## 1.4.13

- TV app: slightly increase all text sizes for better 10-foot readability.

## 1.4.12

- Simplify `/api/redirect` to return only `{ "url": "..." }` — the final destination if redirected (HTTP or JS), otherwise the original URL.

## 1.4.11

- Detect FilmyFly-style JavaScript mirror redirects in `/api/redirect` (not just HTTP 301/302), so Home Assistant can alert when `ww2.*` is sent to the canonical domain.

## 1.4.10

- Clarify source URL redirect monitoring: `/api/redirect` now returns `originalUrl`, `url`, and `redirected`.
- Add `sensor.movie_server_source_final_url` so Home Assistant always shows the resolved URL, even when no HTTP redirect is detected.

## 1.4.9

- Polish HACS presentation: compressed brand icon/logo, integration `brand/` assets, and a cleaner integration-focused README.
- Move add-on and development docs to `docs/`.

## 1.4.8

- Add a Home Assistant "Source URL redirected" problem binary sensor. It resolves the configured `main_url` through `/api/redirect` and exposes the redirected `final_url` as an attribute for notifications.

## 1.4.7

- Add HACS packaging: `hacs.json`, brand icon, and README install steps for the sensors integration.
- Fix integration `manifest.json` (`issue_tracker`, `codeowners`) for HACS validation.

## 1.4.6

- Resume playback: the player now remembers where you left off in a movie and auto-resumes from that position next time you press Play. Position is stored server-side alongside the movie's downloaded file (so it survives app reinstalls), saved every ~10s during playback plus on pause/exit, and cleared automatically once a movie is nearly finished (>95%) so it starts over from the beginning.

## 1.4.5

- TV app: replaced the native `<video controls>` chrome with a custom player (progress bar with time labels, movie title, auto-hiding control bar, center play/pause flash icon, buffering spinner). This also fixes Play/Pause not responding on the remote — Tizen's native video controls don't reliably respond to D-pad input, so Enter/OK is now handled directly to toggle playback.

## 1.4.4

- Track source-site scrape health (last success/error) independently of the Redis cache, since a warm cache can keep serving stale data for hours after the source domain dies. Exposed via `/api/config` and a new "Scrape problem" binary sensor in Home Assistant.
- Fixed a bug where the app crashed on every movie listing request when Redis/REDIS_URL wasn't configured at all.
- TV app: Left/Right now seeks 30s in the video player instead of moving focus; holding the key accelerates the jump size (30s -> 60s -> 90s -> 120s cap).

## 1.4.3

- Load the full poster library in one request when Redis cache is warm (no more page-by-page UI loading).
- Redis cache reads now use MGET for faster bulk page retrieval.

## 1.4.2

- Sync Home Assistant add-on version with the latest app release.

## 1.4.1

- Fix Redis cache key so domain rotations on the source site do not orphan cached listings.
- Cache key prefix bumped to v2.

## 1.4.0

- Add optional Redis listing cache with automatic refresh every 4 hours.
- Dashboard loads from cache by default; Refresh button always scrapes live from the source site.
- Per-page cache upsert keeps TMDB-enriched listings ready for fast responses.

## 1.3.0

- Add `GET /api/redirect?url=...` to resolve HTTP redirects and return the final URL.

## 1.2.12

- Sync Home Assistant add-on version with the latest app release.
- Install `ffmpeg` in the HA add-on image for audio-track playback remuxing.

## 1.2.11

- Add version/language picker before playback when multiple downloaded files or audio tracks exist.
- New `GET /api/downloads/versions` endpoint with ffprobe metadata.
- `/api/downloads/play` supports a specific file and audio track selection.

## 1.2.9

- Add a local-only Source URL input in the dashboard; Home Assistant keeps using add-on options.
- Expose `configEditable` from `/api/config` and block in-app config writes in the HA add-on.

## 1.2.8

- Add fallback download selectors for FilmyFly pages using `.dlbtn a`, `.dlbtn a.bg2`, and `a.bg2`.
- De-duplicate matched download anchors when multiple selectors find the same link.

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
