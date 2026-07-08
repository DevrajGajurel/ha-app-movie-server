// Loaded first, before the wrapped dashboard app.
//
// The dashboard is bundled *inside* the .wgt package (see tizen/dist/), so
// its relative "api/..." fetches would otherwise resolve against the local
// widget package instead of your movie-server backend. Point this at the
// LAN address of the machine running `npm start` in src/movie_server.
//
// Edit the value below and re-run `npm run build:tizen` (this file is
// copied as-is, no build step required beyond that).
//
// The ?apiBase=... query override below only matters when previewing
// dist/index.html directly in a desktop browser (e.g. via
// tizen/preview-dist.js) — a real packaged Tizen app has no address bar,
// so on-device it always uses the hardcoded default.
(function () {
  const override = new URLSearchParams(location.search).get("apiBase");
  window.MOVIE_SERVER_API_BASE = override || "http://192.168.1.88:3001/";

  // How many pages to fetch before the splash screen hides and the browse
  // screen first renders. Overrides the server's own INITIAL_PAGES setting
  // for this TV client only (the server config still governs the web
  // dashboard). Remaining pages keep loading in the background either way.
  window.TV_INITIAL_PAGES = 3;
})();
