# Changelog

## 1.6.15

- Source search now queries primary and secondary (`/?s=…`) in parallel when the local cache has no matches; primary search resolves the live domain and ignores the homepage "Latest Movies" block appended under search results.

## 1.6.14

- Secondary TV: "Download entire season" queues every episode in the background, picks the highest-quality shegu link first, and falls back to the next link if one fails.

## 1.6.13

- Secondary TV downloads use `downloads.shegu.st/tv/{tmdbId}/{season}/{episode}` with a season/episode picker (movies still use `/movie/{tmdbId}`).

## 1.6.12

- Secondary pagination now uses `/page/1/` … `/page/N/` (4khdhub ignores `?page=` and always returned page 1).

## 1.6.11

- Secondary source (4khdhub) now scrapes `a.movie-card` / `.movie-card-meta` instead of the primary site selectors, and resolves downloads via `downloads.shegu.st/movie/{tmdbId}` (direct file URLs in one step).

## 1.6.10

- Added optional secondary listing URL (`SECONDARY_URL` / HA `secondary_url` / dashboard "Secondary URL (HD only)"): scraped alongside the main source, but only titles matching `HD_KEYWORDS` are merged into the catalog (and search).

## 1.6.9

- Added `GET /api/streams/by-tmdb` to resolve proxied HLS URLs for a TMDB movie or TV episode (`type`, `season`, `episode`).

## 1.6.8

- Added standalone Swagger UI at `/swagger` (OpenAPI at `/openapi.json`); not linked from the dashboard.

## 1.6.7

- Server Streams: manually add an m3u8 URL (title + URL + optional Referer) to the Redis cache; manuals survive catalog refresh and can be removed from the card.

## 1.6.6

- Server Streams player starts at highest quality and lets you switch Quality/Audio in the player (no pre-play picker).

## 1.6.5

- Server Streams view: click a poster (or quality chip) to play via the HLS proxy; multi-quality titles open a picker.

## 1.6.4

- Server dashboard sidebar to switch between Library and Streams views (bottom tabs on mobile).

## 1.6.3

- Quiet Streams refresh logs: only log each title and available qualities (scraper/Chrome noise suppressed).

## 1.6.2

- Fix Streams scrape NDJSON pollution: scraper/Chrome progress logs go to stderr so Redis updates reliably; non-JSON stdout lines are treated as log noise instead of parse errors.
- Backend dashboard shows a Streams catalog panel (posters, qualities, refresh status) with a manual Refresh catalog button.

## 1.6.1

- Streams Redis catalog now updates after each scraped title (NDJSON progress), so posters appear one-by-one during refresh instead of only at the end.

## 1.6.0

- Streams now come from a Redis-backed vidsrc trending catalog (refreshed every 4 hours via Chrome/Selenium scrape), not local `M3U8/` files.
- New `GET /api/streams`, `POST /api/streams/refresh`, and `GET /api/hls-proxy` (Referer-injecting HLS proxy). MediaNest/HelloTV show TMDB posters and a quality picker before play.
- Docker images move to Debian bookworm with Python, Chrome, and Xvfb so the in-app scrape can run.

## 1.5.8

- Version bump to sync Home Assistant with the current state of the app.

## 1.5.7

- Added Cineby diagnostics: proxy logs (`[cineby-proxy]`) for HTML fetches, failures, and blocked redirects; TV apps report open/load/error via `/api/client-log`; the injected cursor script reports load, JS errors, and OK-clicks into `movieserver-client.log`.

## 1.5.6

- Streams tab shows TMDB posters in a Home-style horizontal poster row (MediaNest + HelloTV). `GET /api/m3u8` enriches each playlist filename via TMDB when configured.

## 1.5.5

- Keep Cineby inside MediaNest/HelloTV: sandboxed iframe (no top-level navigation), MediaNest chrome bar, block off-origin redirects, and forward the TV remote into the proxied page so D-pad moves the cursor and OK clicks instead of only scrolling the outer app.

## 1.5.4

- Cineby on the TV now loads through a same-origin `/api/cineby-proxy` that strips frame-blocking headers and injects a D-pad virtual cursor (arrows move, Enter clicks, Back returns to the app). This keeps remote control working inside Cineby without navigating the widget away.

## 1.5.3

- Added a **Streams** sidebar tab that lists `.m3u8` playlists from `PlexMedia/M3U8` (container `/downloads/M3U8`) and plays them via AVPlay. New APIs: `GET /api/m3u8` and `GET /api/m3u8/play?file=…`.

## 1.5.2

- Fixed Cineby opening again after a local iframe regression: cineby.at/tech both send `X-Frame-Options: DENY`, so the tab always uses top-level navigation (from the sidebar select path) instead of framing.

## 1.5.1

- Cineby tab no longer uses an iframe: sites such as cineby.tech set CSP `frame-ancestors 'none'`, which browsers always enforce. The tab now opens the configured URL as a top-level page instead (remote Back returns via history).

## 1.5.0

- Renamed the advanced TV app from AVPlayPOC to **MediaNest**, marking it as a production app rather than a proof of concept - new icon, display name, and project folder. The underlying Tizen package id was left unchanged so this updates the existing install rather than orphaning it.
- Added Delete and Trailer actions to MediaNest's movie detail screen: Delete removes the downloaded file (with a confirm step, defaulting to Cancel) via the existing `/api/downloads/media` route; Trailer plays the existing `/api/trailer` proxied stream in a fullscreen video overlay, available for any title with a TMDB trailer regardless of download status.

## 1.4.57

- Added a Cineby sidebar tab on the TV apps (MediaNest + HelloTV) that loads a configurable webpage in an iframe. Set `cineby_url` in Home Assistant add-on options (or `CINEBY_URL` / the local dashboard's Cineby URL field). Exposed as `cinebyUrl` on `GET/PUT /api/config`.

## 1.4.56

- `scanLibrary()` (backing `/api/downloads/library`, used by the advanced app's "Recently Downloaded" row) now reports each download's actual video file creation date (`downloadedAt`) instead of nothing - sourced from the newest video file's birthtime in that folder, falling back to folder mtime only if unreadable. This is a more reliable signal than the marker file's save timestamp or folder mtime alone, since a folder can predate the file inside it (e.g. re-downloading into an existing title's folder).

## 1.4.55

- Fixed AVPlay refusing an otherwise-ordinary 1080p-ish H.264/AAC file outright (`PLAYER_ERROR_NOT_SUPPORTED_FORMAT`) - its SPS header declared H.264 Level 5.1, a tier meant for ~4K content, almost certainly a mistake from whatever tool produced that particular (low-quality "HQCam") release. `/api/downloads/play` now detects an implausible level (5.0+ declared for anything at or below 1088p) via ffprobe and rewrites just that header field in-place via ffmpeg's `h264_metadata` bitstream filter - no re-encode, no quality loss, near-instant. Applies regardless of `raw=1` since this affects AVPlay itself, not just the old `<video>`-element path. Verified against the actual file: ffprobe confirms the corrected stream reports Level 4.1, and the real HTTP route now returns valid `video/x-matroska` output.

## 1.4.54

- Fixed seek (Left/Right) and Enter/play-pause not working after the AVPlay migration: that handling was gated on `document.activeElement === player-video`, which worked reliably for the old `<video>` element but not for AVPlay's `<object type="application/avplayer">` render target - it doesn't reliably hold keyboard focus the same way. Re-gated on whether the tracks panel is open instead (it's the only thing that should "steal" Left/Right/Up from the player), which doesn't depend on the platform's opinion of whether an `<object>` is focusable.

## 1.4.53

- Replaced the movie player's `<video>` element with Samsung's native AVPlay API (`webapis.avplay`), the same engine Emby/Jellyfin use - this is what was actually needed to stop the TV rebooting: AVPlay's own decoder handles eac3/Dolby-Digital-Plus audio and 10-bit HEVC (Main 10) natively, both confirmed crash triggers for the browser's `<video>` element. The 10-bit playback-blocking guard added in 1.4.52 is removed since it's no longer needed. Audio/subtitle track switching now happens live via AVPlay's `setSelectTrack` (no server remux, no reload) instead of the old server-side ffmpeg remux dance. Playback now always requests the original file untouched (`raw=1`) so every embedded track stays available to switch between. Verified against the exact previously-crashing file via a dedicated AVPlay POC app before porting this into the main app.

## 1.4.52

- The audio-codec fix alone didn't stop the TV reboot - both crashing titles are also 10-bit HEVC (Main 10 profile), and the crash is happening at a level our own error-cleanup (1.4.47) can't reliably reach or prevent once it starts. Rather than keep reacting after the fact, the TV app now checks a file's video profile/bit depth (new `videoProfile`/`videoBitDepth` fields from ffprobe, exposed via `/api/downloads/versions`) *before* ever loading it into the `<video>` element, and blocks playback with a clear on-screen message instead for anything 10-bit - trading "won't play yet" for "won't crash the whole TV". Bumped the probe cache to v2 since existing cached entries don't have the new fields. A proper fix (playing 10-bit HEVC natively) is what the AVPlay POC is for.

## 1.4.51

- Added `Cache-Control: no-store` to every downloads/play response. Verified via direct testing that the 1.4.49 audio-transcode fix is actually serving correctly (HEVC + single AAC track) for both previously-crashing titles - but the same URL (tmdbId/title, no explicit file token) can end up pointing at different bytes over time (a re-download, a newly-preferred larger file, or a track that now gets transcoded when it didn't before), and none of these responses had ever set a caching header, leaving the door open for a client to keep replaying a stale response instead of re-fetching after a server-side fix.

## 1.4.50

- Added a `raw=1` diagnostic override to `/api/downloads/play` that forces the original file bytes through untouched, bypassing the new auto-transcode from 1.4.49 - needed to test whether a native player (AVPlay POC) can handle a codec the browser `<video>` element can't, without the server already working around it.

## 1.4.49

- Found and fixed the actual cause of the TV reboot from a real crash log: the movie's default audio track was `eac3` (Dolby Digital Plus) - a codec browsers essentially never support in an HTML5 `<video>` element, even though the TV's own hardware decoder handles it fine natively (which is exactly why Emby/Jellyfin, built on Samsung's native AVPlay API, can play the same file without issue). `/api/downloads/play` now checks the selected track's codec via the existing cached ffprobe info and, when it's Dolby Digital/Plus/DTS/TrueHD, transparently remuxes just the audio to AAC (video stays untouched via `-c:v copy`, no quality loss or slow re-encode) instead of raw byte-streaming a codec the browser was always going to choke on. Verified directly against the real crashing file: 15s of both original and transcoded output ffprobed to confirm HEVC video unchanged, audio now AAC.

## 1.4.48

- Added a `GET /api/client-log` read-side companion to the crash-log endpoint added in 1.4.47 - there was no way to pull `movieserver-client.log` back remotely (the existing download/media routes only serve recognized video extensions), which left it unreadable from outside the HA host during an active crash investigation.

## 1.4.47

- Fixed a real TV reboot: playing a movie whose codec/profile the TV's hardware decoder can't handle (confirmed on 4K HEVC titles) showed our "can't play this file's format" message correctly, but left the `<video>` element still pointed at the broken stream - a few seconds later the whole TV would crash and reboot. On any playback error the player now immediately releases the video element (`pause()` + clear `src` + `load()`) instead of leaving a choked native decoder pipeline attached, and auto-closes back to the detail page after a few seconds.
- Fixed a cold-launch visual bug: after the instant localStorage-cached catalog rendered, a background status refresh (download/continue-watching badges) could fire *after* the real network fetch had already reset the movie list for merging, but *before* the real data replaced it — briefly wiping the whole screen to a bare "Loading movies..." state before the real catalog reappeared a couple of seconds later. Verified by reproducing the exact race (confirmed it flashes without the fix, doesn't with it).
- The TV app now forwards any error it catches (uncaught exceptions, unhandled promise rejections, video playback errors) to the server, which logs it both to its own console output and to a plain-text `movieserver-client.log` file written next to the downloaded movies - there's no way to attach a debugger or `sdb dlog` to the TV from a dev machine, so a crash report is now something that's actually readable afterward.

## 1.4.46

- TV app now shows the Play button once a download reaches 10% instead of waiting for it to fully finish. The file on disk was already playable well before completion (the backend's play/version lookups just scan for the file itself, regardless of download-job status) - this was previously only reachable by accident (e.g. re-downloading an already-completed title). Below 10% the button still stays hidden, and the "already downloaded" Delete button/badge are unaffected since they still key off the completed-library scan. Verified against live in-progress downloads in the browser preview, including the exact <10%/>=10% boundary.

## 1.4.45

- Fixed "No download links found on this page" errors caused by the source site rotating domains (e.g. filmyfly.faith -> filmyfly.fail): a rotated domain's redirect lands on the new domain's bare homepage rather than the equivalent page, so every download-link selector previously came back with 0 matches even though the page itself was fine. When that happens, the scraper now retries once against the same page path on whatever origin `resolveRedirectUrl(mainUrl)` resolves to - the same lookup already used for the HA integration's domain-rotation sensor - before giving up. Verified against the live site: a page that returned 0 matches on the stale configured domain now resolves the real download link via the retry.

## 1.4.44

- Added an optional `aria2`-based download path, toggled via a new "Use aria2 for downloads" add-on option (default off — the original single-connection fetch stays the default). When enabled, downloads use `aria2c` with 8 parallel Range-request connections per file instead of one, which can substantially beat a single connection's throughput against slow/rate-limited source servers. Everything else (folder naming, marker files, Emby refresh, subtitle prefetch, job progress tracking in the UI) works identically either way — only how the bytes get from the source to disk differs. Verified end-to-end locally against a real ~265MB file: correct segmented download (8 connections, ~65MB/s), accurate live progress, correct final file/folder, and confirmed the original fetch-based path is unaffected by the refactor.

## 1.4.43

- A few visual polish items inspired by beam-tv (another open-source Tizen local-media player): focused posters now lift slightly (`translateY(-6px)`) alongside the existing scale-up, giving a subtle "popping forward" feel; overlay close buttons got a frosted-glass look (`backdrop-filter: blur`) over backdrop images/video, degrading gracefully to the existing plain background on engines without support; the player's progress bar now animates smoothly instead of jumping on each tick; and the elapsed/duration time display uses tabular figures so it doesn't shift width as digits change. All verified rendering correctly (computed styles + screenshots) in the browser preview.

## 1.4.42

- TV app now renders instantly on a cold launch from a `localStorage` snapshot of the last successfully-loaded catalog, instead of sitting on the splash screen for the full network + TMDB fetch every single time the app opens. The real fetch still runs in the background afterward and re-renders over it the moment it resolves — this only changes what's on screen while that's happening. Download/Continue-Watching status (not carried in the snapshot) corrects itself moments later via the existing fast local lookup, without waiting on the network catalog fetch. Verified: a cold reload went from a full network-bound wait to a fully rendered screen (471 movies) in 6ms.

## 1.4.41

- Added two new Redis-backed caches to cut down on redundant work: (1) ffprobe results (video resolution/codec, audio and subtitle track lists — the "available languages" info) are now cached indefinitely, keyed by file path + size + mtime. The same file was being re-probed 2-3 times per session (opening the detail page, the version picker, then the player itself all independently called `/api/downloads/versions`), and a file's embedded tracks never change once downloaded — verified locally: ~130ms (spawns ffprobe) on first probe, ~40ms (cache hit, no subprocess) after. (2) TMDB enrichment (rating, genres, overview, runtime, tagline, director, certification, trailer key) now persists through Redis with a 7-day expiry, behind the existing in-memory cache — previously a full server restart wiped that cache entirely, forcing a re-fetch of the whole library's TMDB data (two requests per title) on the next scrape. Verified: a lookup in a fresh process (simulating a restart) came back in ~40ms with zero TMDB API calls, versus ~370ms for the original fetch. Both are additive — everything falls back to fetching fresh if Redis is unavailable, same as the existing listing cache.

## 1.4.40

- Fixed movies taking noticeably longer to start playing, a regression from 1.4.34's "remember last audio/subtitle track" feature: `startPlayer()` was waiting for a saved-progress lookup to finish before even setting the video's `src`, adding a full network round trip to *every* play so it could know the right audio track upfront — even for the vast majority of movies that have never had a non-default track remembered. Playback now starts immediately with the best already-known choice (an explicit override, or the file's default track), and the saved-progress lookup runs in parallel; it now only causes a brief, uncommon reload in the rarer case where it reveals a different audio track was actually remembered for that movie. Resume position and remembered subtitles are unaffected. Verified: play now starts as soon as the pre-existing (unrelated) file-version lookup resolves, without an extra round trip stacked on top of it.

## 1.4.39

- Fixed low quality, non-working fast-forward, and non-working play/pause on the Trailer feature added in 1.4.38. Two separate issues: (1) the format selector used only avoided needing a server-side merge by settling for YouTube's legacy 360p-max combined streams — now resolves separate video (up to 1080p, H.264) and audio streams via `yt-dlp -g` and muxes them live with `ffmpeg` reading both CDN URLs directly (still nothing written to disk, per explicit instruction), same spawn/pipe pattern as the audio-track remux; (2) `dispatchMediaEvent` in remote-control.js grabbed "the first `<video>` in the document" for the hardware remote's Play/Pause and fast-forward/rewind keys, which always meant the movie player's video, never the trailer's, even when the trailer was the one actually open — fixed to pick whichever overlay is actually visible, which also fixes the hardware fast-forward/rewind keys for the trailer. D-pad Left/Right now also seeks the trailer directly. Verified end-to-end: 1080p playback confirmed, Enter toggles play/pause correctly, a single seek press jumps exactly 10s within the actively-streaming buffer (very large jumps ahead of what's streamed so far may still not land, since nothing is saved to disk for true arbitrary seeking).

## 1.4.38

- Replaced the Trailer feature's YouTube iframe embed with a server-resolved direct video stream, played through a plain `<video>` element (same as a downloaded movie). The iframe approach's "video player configuration issue" turned out to be more than a fixable attribute: Samsung's own Tizen TV guidance only documents the native `<video>` element or their AVPlay API for video, and a Tizen developer trying the same referrer-policy fix on a Xibo signage player confirmed it doesn't reliably work there either. New `/api/trailer?key=<youtubeId>` endpoint spawns `yt-dlp` (added to the Docker image) to resolve the trailer to a format that already combines audio+video, then pipes it straight through. Verified end-to-end: real trailer video plays, Enter toggles play/pause, Back closes and stops the stream.

## 1.4.37

- Subtitles are now converted to WebVTT by a background prefetch instead of on first play: each new download triggers it immediately after saving, and a startup + every-6-hours sweep catches any movie downloaded before this feature existed. Playback now serves the cached conversion directly, removing the spinner that used to show while ffmpeg demuxed the whole file on the fly; a title that hasn't been prefetched yet (just downloaded, or a failed attempt) still falls back to converting live so playback is never blocked on it.
- Attempted fix for the Trailer button's "video player configuration issue" error: this is a documented Tizen/YouTube-embed problem (YouTube's referrer-policy checks against Tizen's WebKit + `<access>` origin whitelist). Added explicit `youtube.com`/`www.youtube.com` access entries to config.xml and set the trailer iframe's `referrerpolicy`/`allow` attributes to match YouTube's own embed snippet. This is a best-effort fix based on community reports for a known-fragile area — needs testing on the real TV, and if it's still broken the realistic fallback is dropping the embed for a server-side extracted direct video stream instead.

## 1.4.36

- Redesigned the movie detail page in a Plex/Jellyfin style: rating, year, runtime, content certification (e.g. PG-13), and an "Ends at HH:MM" estimate now sit in the meta row; tagline and director are shown below the overview when TMDB has them. For already-downloaded titles, a new info row shows the file's video quality (e.g. "4K HEVC") plus Audio/Subtitle cycle buttons — pressing one before Play now sends that exact choice straight into playback instead of only being changeable from the in-player panel after the fact. Delete is now a small icon-only circle button instead of a labeled pill, and a new Trailer button (YouTube embed, when TMDB has one) sits alongside Play and Download.
- Backend: TMDB enrichment now fetches runtime, tagline, director, US content certification, and a trailer key alongside the existing title/genre/rating lookup (one extra request per title, via `append_to_response`). The downloads/versions endpoint also now reports each file's video codec.

## 1.4.35

- Fixed Enter never actually doing anything on the exit-confirmation dialog's Cancel/Exit App buttons. Root cause: `remote-control.js` loads via `<script src>` as the very first thing in `<body>`, before the dialog's own HTML further down the page has been parsed — so its `document.getElementById("exit-confirm-yes")`/`"-cancel"` calls at script load time found nothing and silently attached no listener at all. Pressing Back to open the dialog worked (that's a direct function call), but Enter's synthetic click landed on buttons nobody was listening to. Switched to event delegation on `document`, which works regardless of when the buttons are added to the DOM.

## 1.4.34

- The player now remembers the last audio track and subtitles picked for each movie and re-applies them automatically the next time you play it, instead of always resetting to the file's default track and no subtitles. Stored alongside the existing per-movie resume position, so it survives app/server restarts. Note: resuming mid-movie on a non-default audio track may still restart from the beginning — the audio-track remux stream isn't byte-range seekable, a pre-existing limitation this doesn't fix.

## 1.4.33

- Replaced the TV app's placeholder icon (a plain blue square with "MS" text) with the actual Movie Server brand icon — the same clapperboard glyph used for the Home Assistant integration/add-on — resized to Tizen's recommended 117×117 dev icon size.

## 1.4.32

- Fixed the "Latest Movies" scrape filter (added in 1.4.29) still letting the source site's "Trending" section through: it relied on linkedom's `Node.compareDocumentPosition`, which turns out to be an unreliable heuristic that gives wrong answers for elements in different subtrees at different nesting depths — it was placing the Trending section's movie links "after" the Latest Movies heading when they're actually before it. Replaced with a document-order index built from `querySelectorAll("*")` (spec-guaranteed tree order), which correctly excludes the Trending section now.

## 1.4.31

- Added a Delete option to the movie detail page for already-downloaded titles, with a confirmation dialog before anything is removed. Backend: new `DELETE /api/downloads/media` endpoint removes every downloaded folder matching the movie (all versions, plus its marker/progress files) and notifies Emby of the removal.

## 1.4.30

- Fixed a row's first poster losing its alignment with its row title after the row had been scrolled once: `.tv-row-track` uses mandatory scroll-snap but never told the browser about its own left padding, so snapping settled on "first card flush to the edge" instead of "card indented behind the padding" — added matching `scroll-padding` so the padded position is a stable snap point again. Also, each row now snaps back to its scroll start the moment focus leaves it (Netflix/Prime-style), so a row you scrolled through earlier doesn't stay scrolled away from the beginning forever.

## 1.4.29

- Scraper: only collect movie listings after the "Latest Movies" heading on the source site's homepage/listing pages. The page renders several ad/banner divs before that heading reusing the same class names as the ones below it, so class-based selectors alone couldn't tell them apart — now finds the heading and filters `.row-thumb-link` anchors to only those that come after it in document order.

## 1.4.28

- Fixed the TV app icon not showing on the home screen/app list: `icon.png` was 128×128, but Tizen's documented recommended size for the sideloaded/development app icon is 117×117 — resized accordingly.

## 1.4.27

- Poster cards slightly smaller (225px, down from 250px) with a larger gap between them (1.5rem, up from 1.15rem). Top 10 row's ranked cards scaled down to match. Also leaves more breathing room below the fixed hero, since a row's height shrinks along with the posters.

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
