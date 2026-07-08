// App lifecycle glue: initial focus once the dashboard has real content,
// visibility handling for suspend/resume (Home key backgrounds the app —
// Tizen freezes JS execution on suspend on its own, so there is nothing to
// manually pause; we just re-establish focus on resume), and basic error
// logging since there is no devtools console on a real TV.
(function () {
  "use strict";

  function whenSplashGone(callback) {
    const splash = document.getElementById("splash");
    if (!splash) {
      callback();
      return;
    }
    if (splash.hidden) {
      callback();
      return;
    }
    const observer = new MutationObserver(() => {
      if (splash.hidden) {
        observer.disconnect();
        callback();
      }
    });
    observer.observe(splash, { attributes: true, attributeFilter: ["hidden"] });
  }

  function establishInitialFocus() {
    whenSplashGone(() => window.TVFocusManager?.focusFirst());
  }

  function handleVisibilityChange() {
    if (document.visibilityState === "visible") {
      document.dispatchEvent(new CustomEvent("tv-app-resumed"));
      if (!document.activeElement || document.activeElement === document.body) {
        window.TVFocusManager?.focusFirst();
      }
    } else {
      document.dispatchEvent(new CustomEvent("tv-app-suspended"));
    }
  }

  window.addEventListener("error", (e) => {
    console.error("[tizen-lifecycle] uncaught error:", e.message, e.filename, e.lineno);
  });

  document.addEventListener("visibilitychange", handleVisibilityChange);

  if (document.readyState === "complete" || document.readyState === "interactive") {
    establishInitialFocus();
  } else {
    document.addEventListener("DOMContentLoaded", establishInitialFocus);
  }
})();
