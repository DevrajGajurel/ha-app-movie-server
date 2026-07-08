// Loaded before the dashboard's own script. Wraps window.fetch so every
// API call the app makes drives a small activity indicator, and surfaces a
// banner when the TV loses its network link — without touching any of the
// app's own fetch call sites.
(function () {
  "use strict";

  let activeRequests = 0;
  let spinner = null;
  let offlineBanner = null;

  function ensureUi() {
    spinner = document.createElement("div");
    spinner.id = "tv-activity-spinner";
    spinner.setAttribute("aria-hidden", "true");
    spinner.hidden = true;
    document.body.appendChild(spinner);

    offlineBanner = document.createElement("div");
    offlineBanner.id = "tv-offline-banner";
    offlineBanner.setAttribute("role", "status");
    offlineBanner.textContent = "No network connection — check the movie-server is reachable.";
    offlineBanner.hidden = true;
    document.body.appendChild(offlineBanner);
  }

  function updateSpinner() {
    if (spinner) spinner.hidden = activeRequests <= 0;
  }

  function updateOfflineBanner() {
    if (offlineBanner) offlineBanner.hidden = navigator.onLine;
  }

  function patchFetch() {
    const originalFetch = window.fetch.bind(window);
    window.fetch = function patchedFetch(...args) {
      activeRequests++;
      updateSpinner();
      return originalFetch(...args).then(
        (response) => {
          activeRequests = Math.max(0, activeRequests - 1);
          updateSpinner();
          return response;
        },
        (err) => {
          activeRequests = Math.max(0, activeRequests - 1);
          updateSpinner();
          if (!navigator.onLine) updateOfflineBanner();
          throw err;
        }
      );
    };
  }

  function init() {
    ensureUi();
    updateOfflineBanner();
    window.addEventListener("online", updateOfflineBanner);
    window.addEventListener("offline", updateOfflineBanner);
    patchFetch();
  }

  init();
})();
