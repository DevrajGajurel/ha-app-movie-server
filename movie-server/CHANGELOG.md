# Changelog

## 1.7.41

- Fixed a regression from v1.7.38's fix: a real, genuinely good 5GB download ("The Great Grand Superhero") hit 100% and then silently restarted from scratch instead of completing. Root cause: v1.7.38 made `verifyDownloadedFile` hard-fail whenever ffprobe couldn't recognize the file as media at all (fixing the expired-link-saved-as-garbage bug), but ffprobe can transiently fail on a file that's completely fine immediately after the write stream closes - a network-mounted media directory not yet flushed, antivirus scanning the fresh multi-GB file, Windows not having released the file handle yet - and that transient failure was being treated exactly the same as "this genuinely isn't a video," triggering a full wasted re-download.
- Now retries the probe (2s, then 5s) before concluding the file is actually bad. Costs nothing when the file really is bad (ffprobe fails the same way every time), but rules out a filesystem timing hiccup before condemning a whole multi-GB download to a redo over what turned out to be a few seconds of lag.
- If you hit this again on an in-progress job, it's the older code still running (HA add-on updates lag behind a push, same as always) - it should resolve once this version is deployed. Sorry about the wasted bandwidth in the meantime.

## 1.7.40

- Fixed "Play on TV" doing nothing after approving the TV's first-time pairing prompt (real report: prompt shown, approved, then nothing happened). Root cause: the pending-play request's 2-minute TTL starts the instant the dashboard's request lands, not once MediaNest is actually ready to receive it - on a first-time Samsung TV pairing, the on-screen "Allow connection?" prompt alone can eat 30-90+ seconds of real human reaction time (notice the prompt, find the remote, approve it) before the launch even reaches MediaNest, which then still has to cold-boot and open its own WebSocket connection. That easily used up the whole 2-minute window, so by the time MediaNest connected, the request it was supposed to pick up had already expired.
- Raised the TTL to 5 minutes. Every launch after the first pairing is near-instant (stored token, no prompt), so this longer ceiling only ever matters on that first approval.

## 1.7.39 / MediaNest 1.0.17

- New dashboard sidebar section, "Downloaded Library" - a browser for titles already downloaded (distinct from "Library", the full scraped catalog most of which isn't downloaded, and "Downloads", the job queue) - sorted most-recent-first, each card offering "▶ Play on TV" instead of Download. Scoped to movies for now (a TV show has no single file to play - which episode?).
- "Play on TV" pushes playback to MediaNest over a persistent WebSocket (`tvSocket.js`'s `/api/tv/socket`) rather than polling - MediaNest opens one connection on startup and just listens, and the backend delivers the play request the instant it's made. If MediaNest isn't connected yet, the request is held (2 min) and delivered the moment it connects. A best-effort Samsung TV remote-launch (`samsungTv.js`) also fires alongside the push, to bring MediaNest to the foreground if the TV is idle or on another app - this uses Samsung's local WebSocket remote-control protocol (the same one Smart View uses), needs a one-time on-screen "Allow connection?" approval the first time, and requires the new `tv_ip` add-on option to be set (optional - "Play on TV" still works whenever MediaNest is already open, even without it).
- Verified end-to-end against real hardware and a real backend instance, not just code review: confirmed TV pairing + remote launch against the physical TV (needed a longer approval window than first assumed - bumped the connect timeout from 15s to 60s after a real approval didn't complete in time); confirmed one dashboard click produces exactly one WebSocket push with the correct file token/title/tmdbId, delivered to a live-connected listener.
- `flaresolverr_url`-style required-config precedent was deliberately not repeated here: `tv_ip` is optional, since the WebSocket push path works on its own whenever MediaNest is already running - only the "bring it to the foreground" behavior needs it.

## MediaNest 1.0.16

- Library now sorts by most recently downloaded first, matching Home's own "Recently Downloaded" row - it was sorting alphabetically by title before, burying a just-downloaded title wherever its first letter happened to fall instead of showing it up front.
- Fixed a real, confirmed duplicate: "The Last Sunrise" was appearing twice in "Top 10 Movies" (and, by the same root cause, potentially in every other Home row). Root cause: `getAllMovies()` deduplicated by the scraped page URL (`.link`), not by TMDB identity - the same movie is often re-listed on the source site multiple times at different quality tiers, each with its own distinct URL but matching the same TMDB entry, so the old dedup let every one of them through. Now deduped by TMDB id when there is one (falling back to `.link` for anything without a TMDB match).
- Verified live against the real backend: confirmed "The Last Sunrise" appeared at both position 1 and 3 in Top 10 before the fix, and only once (position 1) after; confirmed Library now opens with "The One" first, matching Recently Downloaded's own order exactly.

## 1.7.38

- Fixed a real, confirmed correctness bug: some file hosts' signed/time-limited links (e.g. "Fast Cloud") redirect to a normal 200 OK HTML page once expired - `response.ok` alone can't tell that apart from the real file, so `downloadFileWithFetch` was silently saving a few KB of error-page HTML as if it were the actual movie and marking the job "completed"/"Saved" (confirmed on a real report: "The One" - Fast Cloud (6.6 GB).mkv saved as 52 KB in a few seconds). The link working fine when opened directly in a browser doesn't mean the same link is still valid by the time the server's own download request lands - it may be queued behind other work, or resolved from an hours-old cache entry.
- Two fixes, layered: (1) `downloadFileWithFetch` now checks the response's `Content-Type` and fails fast (triggering the existing candidate-retry loop) if it's `text/html` instead of real media, before writing anything to disk. (2) The shared post-download verification step (`verifyDownloadedFile`, used by both the plain-fetch and aria2 download paths) now treats "ffprobe couldn't recognize this as media at all" as an outright failure - previously it only checked for one specific mid-file corruption signature (aria2 segment gaps), which a non-video file would never trigger, letting it through as "not corrupted" even though it wasn't a video at all.
- If you have any downloads that finished suspiciously fast or small (like the 52 KB example above), use the existing "Redownload" button on that job - it'll now correctly reject an expired link instead of re-saving the same bad content.

## 1.7.37

- Every FlareSolverr solve now caches the `cf_clearance` cookie (and User-Agent) it earns per domain (`cfClearanceCache.js`, in-memory), and `fetchPageHtml` tries a plain fetch replaying that cookie/UA before paying FlareSolverr's cost again on the next request to the same domain - only falling back to FlareSolverr if the site still challenges the replayed request. The cookie's own `expiry` is trusted as its TTL rather than a fixed guess (confirmed live: filesdl.top issued one valid a full year out).
- Tested this against the real site rather than assuming it works: an immediate fresh-solve-then-replay succeeded (200, real content, no FlareSolverr needed) - but a stale ~1-2h-old cookie replay on the same URL still got re-challenged. This site's protection appears to have some session/timing-dependent behavior beyond plain cf_clearance validity, so this **won't skip FlareSolverr on every request** - but it will skip it whenever the cached clearance is still accepted, at the cost of one extra fast plain-fetch attempt when it isn't. Net effect: fewer FlareSolverr calls on average, never more.

## 1.7.36

- Fixed a real, confirmed TMDB mismatch: "Toxic V2 (2026) South Hindi Dubbed Movie" (Yash's Kannada blockbuster "Toxic: A Fairy Tale for Grown-ups", TMDB popularity ~90) was matching to `tmdbId 1315091` - an unrelated 2025 Lithuanian arthouse film literally titled "Toxic" (popularity ~3, about teens at a modeling school). Root cause: `scoreCandidate`'s exact-title-match bonus (+0.2, on top of an already-maxed similarity=1) let any coincidentally short exact-titled candidate beat a correct match whose real title carries an official subtitle the cleaned query doesn't have (similarity capped at 0.92 for a "contains" match) - popularity barely factored into the score before (max +0.04), even though it's a strong, cheap signal for "which same-titled entry is the one a piracy site is actually distributing" (virtually always the mainstream one, not an obscure festival film).
- Raised popularity's weight in the match score (`Math.min(popularity, 100) / 250`, up from `/1000` with a lower cap) - bounded so it still can't override a genuine title mismatch, but now meaningfully breaks ties between same-named candidates in favor of the popular, contextually-plausible one.
- Verified: ran the real `searchMedia` matcher against the exact scraped title before and after - before, it picked the wrong Lithuanian film; after, it correctly resolves to `tmdbId 1213243`, "Toxic: A Fairy Tale for Grown-ups" (2026). Regression-tested against 9 other real titles from the live catalog (Rush, Toy Story 4, Ghost in the Shell, Lenin, Sarpanch, etc.) - all still resolve to their correct, expected entries.
- Cleared the specific stale Redis cache entry (`movieserver:v1:tmdb:v3|Toxic||2026|movie`) that was holding the wrong match (7-day TTL otherwise) so this doesn't have to wait to self-correct.

## MediaNest 1.0.15

- Search now shows live TMDB-backed suggestions as you type, matching the dashboard's search box (`/api/tmdb/suggest`, already existed server-side - just never wired up in MediaNest). Previously MediaNest's search only ever matched titles already in the locally scraped catalog by plain substring, so a query that didn't exactly match the catalog's own title formatting (a misspelling, different punctuation) came back "No matches" even when the title genuinely existed. Selecting a suggestion fills in its title rather than jumping straight to a TMDB-only result - a title only found via TMDB has no scraped source page to download from, so there's nothing to open yet; this just helps get the search text right, same as the dashboard.
- New `Search`/`suggestions` focus region, navigable the same way as everywhere else in the app (Down from the input into the list, Up back out, Enter to select, Back/Escape to dismiss).
- Verified live against the real backend in the dev preview: typing "sunrise" correctly returned 8 TMDB suggestions (The Last Sunrise, Before Sunrise, Sunrise Earth, etc.) alongside the 2 local catalog matches, and selecting a suggestion filled the search box and closed the list.

## 1.7.35

- Fixed "Watch Trailer" never working, in MediaNest or the dashboard: `trailer.js`'s `/api/trailer` route (`streamYoutubeTrailer`) has always shelled out to `yt-dlp` to resolve a direct stream URL, but the Dockerfile never actually installed it - every attempt failed with a plain "command not found", surfaced to the user as a generic "Could not resolve trailer" with no clue why. Confirmed the actual resolution logic itself is fine: ran the exact same `yt-dlp -f "bestvideo[height<=1080][vcodec^=avc1]+bestaudio[ext=m4a]/best[height<=1080]/best" -g` command trailer.js uses against a real YouTube video and it correctly returned two direct googlevideo.com stream URLs - this was purely a missing dependency.
- `yt-dlp` is now installed via pip (`python3`/`python3-pip` + `pip install yt-dlp`) rather than yt-dlp's own standalone binary release, since that release is amd64-only and this add-on also ships aarch64/armv7 (config.yaml's `arch` list) - the pure-Python pip package works identically on all three.
- Startup log now reports `Trailers: enabled (yt-dlp found)` or a clear "not found on PATH" warning, instead of this only ever surfacing when a user actually clicks Trailer.
- **Deployment note**: this is a Dockerfile change - Home Assistant Supervisor rebuilds the add-on's image from source on update, so no extra step beyond the usual update is needed, but it does mean this update will take longer than a code-only release while the image rebuilds.

## 1.7.34

- `linkmake.in` pages now bypass FlareSolverr and fetch directly - verified live (a real "The Last Sunrise" linkmake.in page, HTTP 200 via plain fetch, no JS challenge) that this host serves its `class="dlink dl"` quality-tier links as static HTML, same as any normal page. Since this hop sat in the same "every download-page fetch goes through FlareSolverr" path as the genuinely-protected file-host pages (see v1.7.29), it was paying several-to-tens-of-seconds of unnecessary FlareSolverr cost on every popup open. Every other domain still requires FlareSolverr as before - this is a single, verified, named exception (`fetchPageHtml`'s new `PLAIN_FETCH_HOSTNAME_PATTERN`), not a general fallback.

## 1.7.33

- Investigated the raw "Unexpected non-whitespace character after JSON at position 3 (line 1 column 4)" error reported on "The Last Sunrise": checked Redis directly and the cached entry for that exact page was valid (6 real download links, correctly cached) - nothing corrupted was stuck there, and by design a failed resolution is never written to cache (only a `.then()` on a successful live resolution ever calls `setCachedOptions`, so a rejected/thrown resolution skips it entirely). The cryptic text itself is most likely FlareSolverr's own diagnostic message about whatever it hit resolving the target page, previously thrown to the user completely without context.
- `fetchPageViaFlareSolverr`'s failure message is now prefixed with the URL it was trying to solve ("flaresolverr failed to solve <url>: <reason>") instead of a bare, context-free string.
- Dashboard: quality-list and direct-link fetches (the two stages that wait on FlareSolverr) now parse their response defensively (`parseJsonResponse`) - a genuinely non-JSON response (e.g. a reverse-proxy timeout page cutting in front of this server's own always-valid-JSON response) now shows a clean, actionable message instead of the raw parser error.
- Reduced FlareSolverr's default timeout from 60s to 45s (still overridable via `FLARESOLVERR_TIMEOUT_MS`) - comfortably under common reverse-proxy default read-timeouts (Home Assistant's own ingress sits in front of this add-on), so this server's own clean timeout error has a chance to win the race and reach the browser as valid JSON, rather than risking the proxy cutting the connection first.

## 1.7.32

- Added `GET /api/flaresolverr/test?url=...` - a debug endpoint that fetches any URL through FlareSolverr exactly the way the real download-resolution flow does (`fetchPageHtml`), and returns the solved page's raw HTML directly (not wrapped in JSON), with the actually-resolved URL echoed in an `X-Flaresolverr-Resolved-Url` header. Lets a suspected anti-bot page - or a `flaresolverr_url` connectivity problem - be checked straight from Swagger instead of needing to reproduce it through a real download popup and read server logs. Documented in `openapi.json`.

## 1.7.31

- The quality-tier list stage of download resolution (the popup's first "Loading..." step) had no caching at all, unlike the direct/file-host stage - meaning every single popup open paid the full FlareSolverr cost (several seconds to tens of seconds, now that every page fetch goes through it - see v1.7.29) even for a title just opened seconds ago. `downloadOptionsCache.js` is now generalized (`resolveOptionsCached`/`prefetchOptionsInBackground`, both keyed by `(kind, source, pageUrl)` where `kind` is `"quality"` or `"direct"`) so the quality stage is cached in Redis exactly the same way the direct stage already was - same TTL, same in-flight de-dupe, same "never cache a zero-option result" rule.
- The existing background prefetch (warms the "direct" cache for every quality option as soon as the quality list itself resolves, so a real click usually finds it already cached) is unaffected in behavior, just re-pointed at the generalized cache functions - and now also fires on a quality-list *cache hit*, not just a live resolution, so it keeps the direct cache warm across repeat visits too.

## 1.7.30

- Fixed "flaresolverr unreachable: fetch failed" - root cause confirmed: `.local` mDNS hostnames (e.g. `homeassistant.local`) don't resolve reliably (or at all) from inside the add-on's container, since it has no mDNS resolver (`avahi`/`nss-mdns`) - even from a machine where mDNS partially works, `homeassistant.local` was seen resolving to a dead IPv6 link-local address that then failed to connect, and the add-on's container has neither that partial support nor a route to that address. `fetchPageViaFlareSolverr`'s error now surfaces the real underlying cause (`err.cause.code`, e.g. `ENOTFOUND`/`UND_ERR_SOCKET`) instead of just the generic, unhelpful "fetch failed", so this class of problem is self-diagnosing from the logs next time.
- README: `flaresolverr_url` should be set to FlareSolverr's **IP address**, not a `.local` hostname, for the reason above.

## 1.7.29

- `flaresolverr_url` is now a **required** add-on option, not optional. Every download-page fetch (both the quality-tier list and the direct/file-host resolution) now goes through FlareSolverr unconditionally instead of trying a plain `fetch()` first and only falling back on a detected challenge - this session alone turned up three distinct anti-bot fronts on these source sites (403 Cloudflare interstitials, HTTP 202 "vDDoS" JS challenges, signed click APIs), and chasing each with its own detection rule was a losing, ever-growing game. A real browser (via FlareSolverr) handles all of them the same way.
- Verified against the real `new8.filesdl.top/drive/...` page that triggered the v1.7.28 fix: posted directly to FlareSolverr's `/v1` endpoint, got back `"message": "Challenge not detected!"` (i.e. it solved the vDDoS challenge cleanly), and the resolved HTML had 7 real `a[class*="button"]` download links (HubCloud, GDFlix, gofile, fuckingfast.net, and others) - exactly what the existing selector already expects, no further changes needed there.
- **Deployment note**: because this is now required, the add-on will refuse to start after upgrading until `flaresolverr_url` is set in its configuration (point it at FlareSolverr's `/v1` endpoint, e.g. `http://homeassistant.local:8191/v1` - the `/v1` suffix matters, the bare host/port alone won't work).

## 1.7.28

- Fixed a silent false-negative on "No direct download links found": confirmed on a real file-host page (`new8.filesdl.top/drive/...`) that some anti-bot fronts answer with a 2xx status (202, in this case) and a pure-JS challenge body (a custom "vDDoS" challenge - computes a cookie via `slowAES.decrypt()`, then self-redirects) instead of the 403/503 the existing Cloudflare-challenge detection was built around. Since `response.ok` was true, `fetchPageHtml`'s challenge check never ran at all, so the page was treated as a normal-but-empty scrape (0 anchor matches) rather than a blocked one - `classifyFetchFailure` now runs unconditionally (not just on non-2xx) and recognizes this body pattern alongside the existing Cloudflare ones. When FlareSolverr is configured it's now tried for this case too; when it isn't, the error now says so explicitly ("configure flaresolverr_url to solve it") instead of surfacing as an unexplained empty result.
- Broadened the "direct" download-link selector to also catch a plain `<button class="...button...">` (not just `<a class="...button...">`), guarded so an href-less match (a JS-driven button, not a real link) is filtered out rather than turned into a bogus URL.

## 1.7.27

- Dashboard: the quality-options popup now resolves each option's link through `/api/redirect` as soon as it's shown, and displays + uses the resolved URL instead of the raw one. Some source links (e.g. `new1.filesdl.in`) are themselves just a domain-alias redirect to a different domain (`new8.filesdl.top`) with the same path - clicking through with the raw alias URL sent the next scrape step at the wrong domain, which is one of the ways a "No direct download links found" could happen even though the real page works fine. Best-effort and non-blocking: each option still shows/uses its raw href immediately, and only updates once (if) the redirect check resolves.
- `openapi.json`: removed the orphaned "Proxy" tag (declared but unused by any documented endpoint) and added the missing `GET /api/redirect` entry - it's existed in the server since the v1.7.24 secure-download-button work but was never added to the Swagger spec.

## 1.7.26 / MediaNest 1.0.14

- Added per-episode playback inside a season-pack part, alongside (not instead of) the "Play Part-NN" buttons from v1.7.25. Checked a real downloaded pack with ffprobe first: it has zero chapter markers (`-show_chapters` returns an empty list), so there's no exact metadata to read an episode's start time from - the only cheap option is estimating it, by dividing the part's actual runtime proportionally across its episodes' TMDB runtimes. This is approximate (real intro/recap/credits length varies per episode, so a seek point can drift by roughly a minute), not frame-accurate, but is the only option that doesn't require decoding the whole file.
- The episode range a part covers (e.g. "Ep.01-06") was already scraped at download time (`findPartLabel`, v1.7.23) - it's now tagged onto the saved filename alongside the existing `PART-01` tag (`withPartTag`, fileDownloads.js: `PART-01 EP01-06 - filename.mkv`) so it survives without needing to re-scrape anything. `findSeasonPackFiles` parses both tags back out and now also probes each part's actual duration (`probeMediaFile`, already cached from prior scans).
- TMDB's per-episode `runtime` field is now included in `/api/tmdb/season` (`EpisodeDetail.runtimeMinutes`).
- MediaNest's Detail page: an episode covered by a season-pack part (and not otherwise individually downloaded) now shows the same "downloaded" ▶ badge the per-episode-file case already had, and selecting it (or the dedicated remote Play key) jumps straight into that part, seeking to the estimated start - instead of opening the download popup for something that's already there. Player accepts a new `startAtSeconds`, which takes priority over resuming from previously-saved progress since picking a specific episode is an explicit choice of where to start.
- Backwards compatible: parts downloaded before this change have no episode-range tag, so they keep offering only the "Play Part-NN" button, exactly as before - no backfilling needed or attempted.

## 1.7.25 / MediaNest 1.0.13

- "Play All Episodes" now offers one button per part when a season was downloaded as split "Part-01"/"Part-02"/... batches, instead of a single button that could only ever point at one of them. Previously `findSeasonPackFile` (fileDownloads.js) picked whichever season-pack file it found first via `.find()`, so a season split into 3 parts silently lost 2/3 of the library to the UI.
- Fix: the part a quality option belongs to (already scraped via `findPartLabel`, see v1.7.23) is now carried all the way through to the saved file - `startDownload`/`/api/downloads/save` accept an optional `part`, and the downloaded filename gets a `PART-01 -` style tag (`withPartTag`, fileDownloads.js) so it survives regardless of what the file host's own filename looks like. `findSeasonPackFile` is now `findSeasonPackFiles`, returning every part-tagged (or untagged, for old-style single-file seasons) match in a season's folder, sorted by part number.
- MediaNest's Detail page renders one "▶ Play Part-NN" button per part (or the original single "▶ Play All Episodes" button when the season has no parts), with left/right arrow-key navigation between them.
- Backwards compatible: files downloaded before this change have no part tag and keep showing as a single "Play All Episodes" button, exactly as before.

## 1.7.24

- Fixed "No direct download links found" (0 matches on `a[class*="button"]`) for real: this wasn't a selector or redirect issue - the file-host (new6.filesdl.top, confirmed live) replaced plain `<a>` download links with JS-driven `<button>`s that reveal the real link through a signed two-step API (the page's own pgid/pgsig plus each button's data-ea, POSTed to a "click" step that returns a one-time redirect token). Confirmed end-to-end against a real Breaking Bad link that both steps are plain HTTP with no JavaScript execution needed - the page's own script only orchestrates two fetches, which are now replicated directly (a HEAD-only redirect resolution for the final hop, so a multi-GB file body is never actually downloaded just to learn its URL). Only attempted as a fallback when the classic anchor selectors find nothing, so this costs nothing on pages that still use plain links.

## 1.7.23 / MediaNest 1.0.12

- Some seasons on the main source are split into "Part-01 (Ep.01-06)"/"Part-02"/... batches, each with its own quality tier of download buttons - confirmed on real pages (e.g. Breaking Bad S05) the split is marked by a plain text divider sitting between groups of buttons, not a wrapping element. The quality scraper now walks page order to attach each option's part label, grouping (never interleaving) by part while keeping the previous best-quality-first sort within each group. Shown as a header in both the dashboard's and MediaNest's download popups.
- Extended this to a real gap in MediaNest: TV downloads there always used shegu's per-episode picker regardless of source, unlike the dashboard (fixed in 1.7.20) - a main-source TV show never even got a season-pack quality list to show Part groupings in. MediaNest's download popup now routes main-source TV through the same quality/direct flow a movie uses (secondary-sourced TV is unchanged), tagged with the season number - preferring the season the user actually navigated to in Detail's own episode grid over guessing from the scraped listing's title, since a listing's own title isn't always the season actually being viewed.
- Fixed a real caching bug: a "0 links found" result (a moved page, an uncleared Cloudflare challenge, any transient miss) was cached for the same multi-hour TTL as a real result, indistinguishable from one - once it happened, every subsequent attempt kept getting the same stuck failure back instead of ever retrying live. Empty results are no longer cached at all, so a bad resolution now naturally retries next time instead of getting stuck. Cleared the current Redis cache to drop everything already stuck this way.

## 1.7.22 / MediaNest 1.0.11

- Fixed Home's "Continue Watching" row silently dropping any title that had rotated off the currently-loaded scraped listing pages - confirmed directly against the real backend: it correctly returned Breaking Bad at 42% progress, but the frontend only ever matched progress items against the live catalog with no fallback, so anything not currently on a loaded page (common for a show watched over more than a few days) vanished from the row entirely instead of showing up without art. Now falls back to the same posterless-stub-plus-direct-TMDB-fetch recovery the Library screen already used, shared between both lists so a title in both doesn't fetch twice. `GET /api/downloads/progress`'s items now also carry a `type` (movie/tv), inferred from whether the progress file lives in a season subfolder, so the recovery fetch can avoid the movie/TV tmdbId collision fixed earlier. Verified in the dev preview with a progress item absent from the mocked catalog - the title and its recovered poster now appear in Continue Watching.
- Fixed subtitles staying on screen through the gap between lines of dialogue instead of clearing when a cue ends - AVPlay only fires `onsubtitlechange` when a new cue starts, never when one ends, and the duration it provides for each cue (which tells you when it should disappear) was being ignored entirely. Now schedules the clear that duration implies, cancelling it if a new cue arrives first.

## MediaNest 1.0.10

- Fixed the remote's Back button during playback always landing on Home's default browse view (scrolled to the top) instead of wherever the user actually was before pressing Play - a Detail page, the Library/Downloads view, a scrolled-down row. Root cause: Home fully unmounted while Player was showing and remounted fresh when it closed, discarding all of its state; on top of that, starting playback from Detail explicitly cleared its own open state before navigating away. Home now stays mounted (just hidden) behind Player, and Detail no longer clears itself when playback starts, so Back returns to exactly where the user left off. Verified in the dev preview: Player mounts with Detail preserved underneath (hidden, not unmounted), and closing it returns to that same Detail page.
- Fixed multi-line subtitles rendering the literal text "<br>" instead of a line break - AVPlay delivers a literal `<br>` tag in cue text for multi-line subtitles, which showed up as-is in a plain React text node. Now converted to a real line break before display.

## 1.7.21

- MediaNest: added a "Play All Episodes" option to a season's episode grid, shown only when a single whole-season file (as opposed to per-episode files) actually exists in the library for that season - the same layout main-source TV downloads produce (see 1.7.20). New `GET /api/downloads/season-pack` backend route detects this by finding a video file in the season's folder with no SxxEyy tag at all, scoped to that season so a same-named pack in a different season isn't matched. Verified against synthetic per-episode-only, season-pack-present, and wrong-season scenarios.

## 1.7.20

- Fixed TV downloads always resolving through the secondary source (shegu) even when a show's listing was scraped from the main source, which made the new Main/Secondary badge misleading (a card labeled "Main" would still hand you secondary-sourced download links). Checked real data from the main source: each season listing publishes one whole-season file per quality tier, not per-episode links, so main-source TV now downloads that file directly (same quality/direct flow a movie already uses) and saves it into the same `Series (tmdb-id)/S0X/` folder structure, tagged with the season number parsed from the listing's own title. Secondary-sourced TV is unaffected and still uses shegu's per-episode picker. Note: since it's one file for the whole season, per-episode features (downloaded badge, episode-level play/resume) don't apply to main-source TV downloads - only to secondary-sourced ones.

## 1.7.19

- Fixed single-episode/movie redownloads reusing the original job's stored candidate links - those are shegu-issued signed URLs that expire in a few hours, so a redownload triggered later than that retried an already-dead link every time regardless of the recent retry fix. Redownloading a TV episode job now re-resolves fresh shegu candidates first, the same way a season redownload already did.
- The direct-download-options cache (`downloadOptionsCache.js`) is now keyed by source (main/secondary) in addition to the page URL, since the same page URL can resolve differently depending on which site's flow led there - previously a cached result from one source's request could incorrectly serve back to the other.
- Download verification (added in 1.7.17) was a full stream-copy-to-null pass over the entire file - correct, but on a 15-20GB file that reads the whole thing a second time after the download itself finishes, adding several minutes to every single download. Replaced with 6 short (15s) sampled windows spread across the file's runtime instead of the whole thing: the corruption this catches showed up densely on real affected files (dozens of instances every 200-800MB), so sampling several spread-out points catches the same class of corruption for a small fraction of the time cost.
- MediaNest's dashboard search results now show a "Main"/"Secondary" badge on every card, plus a filter dropdown to show only one source - multiple near-identical entries for the same title (different scraped listings, e.g. per-season batches) were previously indistinguishable by source.

## 1.7.18

- Investigated frequent secondary-source download failures (aria2c exiting with an HTTP 403 from the 4khdhub/shegu mirror links). Confirmed directly with concurrent curl requests (no aria2 involved) that these Cloudflare-Worker-fronted mirrors intermittently reject a fraction of simultaneous requests against the same signed link, and that a segmented download can't tolerate even one of its connections getting rejected - aria2c also doesn't retry HTTP 403 at all (confirmed `--max-tries`/`--retry-wait` don't apply to it), so a single rejected connection failed the entire candidate outright. aria2 downloads now use a single connection (down from 8) instead of splitting, and a failed candidate is retried a few times before falling through to the next quality/source, instead of giving up immediately. Note: follow-up validation of the exact retry count got muddied by likely self-inflicted rate-limiting from the testing itself (heavy request volume against the same endpoints in a short window) - the mechanism is confirmed real, but how much this fully resolves the reported failure rate isn't proven end-to-end yet.

## 1.7.17

- Fixed a real, confirmed data-corruption bug in the download pipeline: aria2c's segmented download (splits each file across 8 connections) can exit successfully even when one of those segments left a gap of zero bytes partway through the file - invisible to a lightweight duration probe (which only reads the header), but exactly what broke seeking on House of the Dragon and one other title (playback from the start worked since it never touched the gap; seeking anywhere landed on or near one of several scattered gaps per file). Every download is now verified with a full stream-copy demux pass before being marked complete; a corrupted result is deleted and retried against the next fallback candidate, the same way a network failure already was.

## 1.7.16

- MediaNest: TV show detail page now has a real "Continue Watching" flow - the primary button reads "Continue Watching" and jumps straight back to the exact episode/position last watched (via a new `GET /api/downloads/series-resume`, which validates the saved progress still points at a file that exists on disk), falls back to "Play" (S1E1) if nothing's been started yet and it's already downloaded, or "Download" otherwise. Saved progress now records which episode's file it belongs to (`fileToken`), since a season folder holds multiple episodes and previously had only one shared, unlabeled progress record.
- MediaNest: selecting an episode in the grid always opens the download popup now (previously it played the file directly if already downloaded, skipping the popup entirely) - already-downloaded episodes get a small play-icon badge on their thumbnail instead (same treatment as the Library poster grid), and the popup itself gets a "Play S0XE0Y" option at the top when that episode is already on disk, so redownloading is still one extra click away instead of automatic.

## 1.7.15

- Added `GET /api/downloads/episode-file` (tmdbId/title + season/episode -> file token if downloaded) and wired it into MediaNest's episode grid: selecting an episode that's already on disk now plays that exact file directly instead of opening the download popup - previously "Play" on a TV show just grabbed the largest video file across every folder matching that show's id, which meant nothing once more than one episode was downloaded (confirmed this was resolving to the wrong season entirely).
- Cleaned up ~127GB of duplicate/stale files found while investigating the above: House of the Dragon Season 2 had every episode downloaded 2-3 times over (one exact duplicate plus a lower-quality alternate each), and a leftover flat "House of the Dragon S01E01" folder from before this release's folder-nesting fix. Kept the single best-quality copy of each episode.

## 1.7.14

- Fixed single-episode downloads (MediaNest's episode grid, the dashboard's per-episode picker) creating their own separate "Title SxxEyy (tmdb-id)" folder instead of nesting into the season-batch layout ("Title (tmdb-id)/S0X/") - `/api/downloads/save` now accepts season/episode and threads them through like the season-batch downloader always has.
- Fixed the season downloader (and a season-type redownload) re-downloading episodes that were already on disk - confirmed this had produced ~28GB of fully-duplicated episode files across repeated runs. Each episode is now skipped if a matching file already exists in its season folder.
- Added a way to cancel a queued/downloading job: `POST /api/downloads/cancel {jobId}` aborts the fetch or kills aria2c (a season job also stops picking up further episodes and cancels whichever one is currently in flight), cleans up the partial file, and marks the job "failed: Cancelled" so it's still visible in history. Added to the dashboard's Downloads tab and MediaNest's Downloads screen.
- Fixed a real mismatch bug: TMDB movie and TV ids aren't in the same namespace, so the same numeric id can point to two unrelated titles (confirmed: id 94997 is both an unrelated movie and House of the Dragon) - a by-id poster lookup with no type hint always tried movie first and could silently return the wrong title's data. `scanLibrary()` now infers movie vs TV from whether a folder has a season subfolder, and passes that as a type hint so the right entity is always resolved.
- MediaNest: Detail page redesigned for TV shows - poster + genre tags next to the hero, and an episode grid below (season pills, real episode names/thumbnails/descriptions from TMDB) - picking an episode opens the download popup straight at that episode's quality options instead of starting from the season/episode picker.
- MediaNest: Downloads screen is now D-pad navigable (up/down through jobs, Enter to redownload or cancel) - it previously had no keyboard handling at all.

## 1.7.13

- Dashboard: the search box now shows live title suggestions from TMDB as you type (2+ characters, debounced), with poster thumbnails, year, and movie/TV badges - arrow keys + Enter or a click to pick one. Backed by a new `GET /api/tmdb/suggest?q=` route. Picking a suggestion just fills in TMDB's canonical title and re-runs the normal search - it's a typing aid, not a way to browse or download anything TMDB has that isn't actually on the scraped listing site.

## 1.7.12

- MediaNest: the player's title/progress/time overlay now auto-hides after a few seconds during playback (matching HelloTV, and Netflix/Jellyfin/Prime convention) instead of staying on screen the whole time - any key press (play/pause, seek) brings it back and restarts the countdown; it stays visible while paused.
- MediaNest: added a "TV Series" row to the Home screen, right after Top 10 Movies - previously TV shows only surfaced mixed into "Top 10 Movies"/genre rows with no dedicated section. "Top 10 Movies" itself now excludes TV entries so it isn't mislabeled.

## 1.7.11

- MediaNest playback was failing with `webapis.avplay is not available on this platform` (logged for Cocktail 2): the Samsung AVPlay script (`$WEBAPIS/webapis/webapis.js`) was never loaded. Also made the player shell transparent so AVPlay's native video plane is not covered by an opaque background.

## 1.7.10

- Fixed a real cause of missing posters: a trailing release-version tag like "V2" right before the year (e.g. "The Odyssey V2 (2026) ...") rode straight into the TMDB search query and zeroed out an otherwise exact match. Also, a "no TMDB match" result was cached for the same 7 days as a real match - both in Redis and forever in an in-memory Map for the life of the process - so a title that got added to TMDB a day later could still show posterless for up to a week. Negative matches now expire in 6 hours in Redis and are never pinned in-memory.
- Fixed the dashboard's download popup showing no season/episode picker for a TV show scraped from the primary listing site (e.g. "House of the Dragon") - that picker was only wired up for secondary-source titles, even though shegu resolves TV downloads by tmdbId/season/episode regardless of which site the listing itself came from.
- A failed download attempt (a bad candidate link, an aria2c failure) now deletes the incomplete file it left behind before falling back to the next link, instead of leaving orphaned partial files behind on every retry.

## 1.7.9

- Download job history now survives a backend restart: job records (queued/completed/failed) are mirrored into a Redis hash (`movieserver:v1:jobhistory`, capped at 200) and reloaded on startup - any job still "downloading" when the process died is marked interrupted instead of showing stuck forever. Falls back to in-memory-only (today's behavior) when Redis isn't configured.
- Added a redownload option: `POST /api/downloads/redownload` (body `{ jobId }`) re-runs a past job - the same URL/candidates for a regular download, or the same tmdbId/season/episodeCount for a season job - and works even for a job from a previous session now that history survives restarts. Wired into both the dashboard's Downloads tab and MediaNest's Downloads screen.
- MediaNest: the download flow is now a popup (matching the dashboard's style) instead of a full-screen page, and TV shows get a season/episode picker with real names/episode counts from TMDB (no extra fetch - already part of the loaded movie data) - "download entire season" queues the whole season server-side, or pick a single episode's quality/fallback links directly.

## 1.7.8

- Removed the Cineby feature entirely: the `/api/cineby-proxy` backend proxy, `cinebyProxy.js`, the `cineby_url` add-on option and `CINEBY_URL` env var, and all UI (dashboard, MediaNest sidebar tab, HelloTV sidenav panel + remote-control wiring).
- Added a direct-by-id TMDB lookup (`GET /api/tmdb?id=`) and wired it into MediaNest's Library grid: a downloaded title only got its poster/backdrop before if it happened to match something on the currently cached listing pages, so anything downloaded a while ago (since rotated off those pages) showed up posterless. The Library view now fetches those directly by tmdbId (a few at a time) and fills the poster in once it lands.

## 1.7.7

- Home Assistant add-on builds are much faster: the Node app is copied from `movie-server/app` instead of `git clone` of the whole GitHub repo, Node comes from Debian (no NodeSource), and apt runs once. Code-only updates can reuse the apt and `npm install` layers.

## 1.7.6

- Local `docker compose` now matches the Home Assistant add-on image: no Chrome/Xvfb/Python, no vidsrc/hlsProxy copies, and no cf-clearance sidecar. The compose Dockerfile copies `src/movie_server` from the working tree.

## 1.7.5

- MediaNest: added a Library sidebar menu that shows every downloaded title in a TMDB poster grid (7 columns), with Play from the detail screen or the remote Play button.

## 1.7.4

- Fixed a performance regression from 1.7.3: `scanLibrary()` (backing `/api/downloads/library`, called by the dashboard/TV app right after "Loading library from cache…") was walking every download folder's directory tree *twice* - once to check for any media file, once again to find the newest file's timestamp - after season-subfolder support made that walk recursive instead of a single flat `readdir`. Now walks each folder once and reuses the file list for both checks.

## 1.7.3

- TV season downloads now run up to 5 episodes in parallel instead of one at a time, picking up the next episode as soon as a slot frees up.
- Season downloads now land as one folder per series with a season subfolder per season (`Series (tmdb-id)/S01/S01E01 - ....mkv`, `S01E02 - ....mkv`, ...) instead of a separate top-level folder per episode. Filenames are tagged with their episode (`S01E01 - `) so concurrent downloads into the same season folder never collide, even when the source gives two episodes a generic name. Library scanning, playback, subtitle prefetch, delete, and resume-progress all now recurse into season subfolders so this doesn't break anything that reads back what's on disk. Movie downloads are unaffected (still one flat folder per movie).

## 1.7.2

- Fixed `flaresolverr_url` (and every other optional URL/string add-on option - `cineby_url`, `secondary_url`, `redis_url`) being silently treated as configured when left unset. `bashio::config` prints the literal text `null` for an unset optional option, and the run script only trimmed whitespace, so `.env` ended up with e.g. `FLARESOLVERR_URL=null` - a truthy string in Node - which then caused `Failed to fetch download page: ... flaresolverr also failed: flaresolverr unreachable: Failed to parse URL from null` on every Cloudflare-challenged download instead of just skipping the fallback. The run script now normalizes bashio's `null` to an empty string for every optional option, and `main.js` normalizes the same env vars defensively at startup.

## 1.7.1

- Added an optional `flaresolverr_url` add-on option (also `FLARESOLVERR_URL`/`FLARESOLVERR_TIMEOUT_MS` in `.env`): when a download-host redirect hits a genuine Cloudflare Turnstile challenge, the server now falls back to a user-run [FlareSolverr](https://github.com/FlareSolverr/FlareSolverr) instance instead of failing outright - the replacement for the Chrome-based cf-clearance sidecar removed in 1.7.0, but running entirely outside this image. Verified against a real FlareSolverr instance and a real Turnstile-protected download host.

## 1.7.0

- Removed the Streams (vidsrc catalog: `/api/streams*`, `streamCatalog.js`, `streamResolve.js`, `hlsProxy.js`, `src/vidsrc/*`) and Remote Index (`/api/remote`, browsing `a.111477.xyz`) features entirely, from the backend, both TV apps (MediaNest, HelloTV), and the dashboard - both pulled in externally-hosted content this project has no rights to distribute.
- Removed Chrome, Xvfb, and the bundled cf-clearance-scraper sidecar from the Docker image and add-on services - they existed only to support Streams' Cloudflare/Turnstile bypass and a secondary download-host fallback. Download links that hit a genuine Cloudflare Turnstile challenge now fail outright (logged clearly) instead of falling back to a browser solver; this cuts the image down substantially (no bundled browser, no Python/pip, no Xvfb).
- Removed the now-orphaned folder-based M3U8 player backend (`/api/m3u8`, `/api/m3u8/play`) that predated the vidsrc catalog and had no remaining caller.

## 1.6.26

- Fixed the real cause of `[cf-clearance] Chrome binary not found` on every build: `google-chrome-stable`'s own `.deb` declares a hard `Depends: ... wget ...`, and the Dockerfile purged `wget` right after installing Chrome to save space — apt cascaded that into silently removing Chrome too, every single build, regardless of image freshness. `gnupg` is still purged (genuinely build-only); `wget` now stays installed. The build also fails loudly (`command -v google-chrome-stable`) if this ever regresses, instead of deferring to a confusing runtime retry loop. Verified by reproducing the exact Dockerfile layer against the real `ghcr.io/home-assistant/amd64-base-debian:bookworm` base image.

## 1.6.25

- The "direct" download hop (e.g. linkmake.in → new1.filesdl.in → new6.filesdl.top, the one likely to hit a Cloudflare Turnstile challenge) is now resolved and cached in Redis as soon as the quality list loads, in the background — not only when the user actually clicks a quality. A click that lands after the prefetch finishes gets the cached result instantly instead of paying the Cloudflare cost inline; one that lands while it's still resolving joins that same in-flight resolution instead of starting a second one.
- Removed the local SeleniumBase fallback entirely (downloads' `browser_fetch.py` and vidsrc's `_get_m3u8_urls_seleniumbase`) — both had quietly stopped working once `seleniumbase` was dropped from `requirements.txt` in 1.6.23 (an unguarded `from seleniumbase import Driver` would ImportError if ever reached). vidsrc's own prorcp Turnstile fallback now goes through the same cf-clearance-scraper sidecar the downloads flow already uses, instead of a second, independent browser-automation stack.

## 1.6.24

- Fix HA cf-clearance "scanner is not ready" / Chrome-not-found: launch system Chrome with an explicit path, reuse the add-on's Xvfb (`disableXvfb: true`), and retry download scrapes while the browser is still starting.

## 1.6.23

- Remote Index: Added `/api/remote` proxy endpoint to browse external HTTP directories (e.g., `https://a.111477.xyz/`). Fetches and parses HTML index pages, extracts anchor tags for files/directories, sorts by year (newest first), and enriches files with TMDB posters in batches of 50. HelloTV sidebar now includes "Remote" option; MediaNest Remote view integrated.
- Replaced SeleniumBase with cloudscraper for Cloudflare bypass in `scraper.py` (`cloudscraper>=1.2.71`). Lighter weight (~100MB savings) and simpler configuration.

## 1.6.22

- Slim the Home Assistant add-on image: purge build-only `git`/`gnupg`/`wget` after use, skip Puppeteer’s second Chrome download, and strip cf-clearance test deps (`jest`/`supertest`/Babel) that were shipped as production packages.

## 1.6.21

- Bundle [cf-clearance-scraper](https://github.com/ZFC-Digital/cf-clearance-scraper) inside the Home Assistant add-on image and start it via s6 alongside Xvfb + movie-server (`CF_CLEARANCE_URL=http://127.0.0.1:3000`). HA no longer needs a separate container for Turnstile-protected download pages.
- Split Xvfb into its own s6 service so Chrome for cf-clearance and SeleniumBase share `:99`.

## 1.6.20

- Add optional `cf-clearance` Docker Compose sidecar ([cf-clearance-scraper](https://github.com/ZFC-Digital/cf-clearance-scraper)) and try its `mode: "source"` API first when download hosts return a Cloudflare Turnstile challenge; SeleniumBase browser fetch remains the fallback.
- Set `CF_CLEARANCE_URL` (default `http://cf-clearance:3000` in compose) to enable; host port defaults to `3010`.

## 1.6.19

- Install `python3-tk` / `python3-dev` so SeleniumBase can click Cloudflare Turnstile (MouseInfo).
- Harden `browser_fetch.py`: keep driver banners off stdout, always emit one JSON result, prefer CDP captcha click before OS click.

## 1.6.18

- Resolve download URLs through the same `resolveRedirectUrl` used by `/api/redirect` before scraping (e.g. `new1.filesdl.in` → `new6.filesdl.top`), so redirecting download hosts no longer return 403 on the first hop.
- Send browser headers on outbound scrapes; if a host still serves a Cloudflare Turnstile challenge, fall back to `browser_fetch.py` (SeleniumBase UC) to clear it.
- Fix vidsrc catalog refresh crash on Python 3.9 (`from __future__ import annotations` in `scraper.py`).

## 1.6.17

- Install `aria2` in Docker images so server downloads work when "Use aria2" is enabled; if `aria2c` is still missing, fall back to the normal fetch download instead of failing with ENOENT.

## 1.6.16

- Fixed TMDB matching for secondary TV titles (e.g. "The Summer I Turned Pretty"): prefer the TV search endpoint without appending "series" to the query, which was returning zero TMDB hits.

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
