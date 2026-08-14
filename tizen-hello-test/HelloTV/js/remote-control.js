// Maps the physical Samsung TV remote to the app: arrow keys drive
// focus-manager.js, Enter activates, Return closes the download modal or
// backs out / exits, and media transport keys are exposed as DOM events for
// any future <video> playback element.
(function () {
  "use strict";

  const hasTizenInput = typeof tizen !== "undefined" && tizen.tvinputdevice;

  // Arrows, Enter, and Back are delivered automatically per Samsung's docs
  // and need no registration ("Return" isn't even a valid key name here —
  // trying to register it throws InvalidValuesError). Only the media
  // transport keys actually need explicit registration to be delivered.
  const KEYS_TO_REGISTER = ["MediaPlay", "MediaPause", "MediaStop", "MediaRewind", "MediaFastForward", "MediaPlayPause"];

  function registerTizenKeys() {
    if (!hasTizenInput) return; // running in a regular browser (dev/preview)
    for (const key of KEYS_TO_REGISTER) {
      try {
        tizen.tvinputdevice.registerKey(key);
      } catch (err) {
        console.warn(`[remote-control] could not register key "${key}":`, err.message);
      }
    }
  }

  const KEYCODE_DIRECTION = {
    37: "left",
    38: "up",
    39: "right",
    40: "down",
  };

  const MEDIA_KEYCODES = {
    415: "play",
    19: "pause",
    413: "stop",
    417: "fast-forward",
    412: "rewind",
    10252: "play-pause",
  };

  const RETURN_KEYCODES = new Set([10009]);
  const EXIT_KEYCODES = new Set([10182]);

  function isTextEntry(el) {
    if (!el) return false;
    if (el.tagName === "TEXTAREA") return true;
    if (el.tagName === "INPUT") {
      const type = (el.type || "text").toLowerCase();
      return ["text", "search", "email", "number", "password", "tel", "url"].includes(type);
    }
    return false;
  }

  function openModal() {
    const exitConfirm = document.getElementById("exit-confirm-modal");
    if (exitConfirm && !exitConfirm.hidden) return exitConfirm;
    const deleteConfirm = document.getElementById("delete-confirm-modal");
    if (deleteConfirm && !deleteConfirm.hidden) return deleteConfirm;
    const tracksPanel = document.getElementById("player-tracks-panel");
    if (tracksPanel && !tracksPanel.hidden) return tracksPanel;
    const player = document.getElementById("player-overlay");
    if (player && !player.hidden) return player;
    const version = document.getElementById("version-modal");
    if (version && !version.hidden) return version;
    const download = document.getElementById("download-modal");
    if (download && !download.hidden) return download;
    const trailer = document.getElementById("trailer-overlay");
    if (trailer && !trailer.hidden) return trailer;
    const detail = document.getElementById("detail-page");
    if (detail && !detail.hidden) return detail;
    const search = document.getElementById("search-overlay");
    if (search && !search.hidden) return search;
    return null;
  }

  function isModalOpen() {
    return Boolean(openModal());
  }

  function closeModal() {
    const modal = openModal();
    if (!modal) return;
    if (modal.id === "search-overlay") {
      document.dispatchEvent(new CustomEvent("tv-close-search"));
      return;
    }
    if (modal.id === "exit-confirm-modal") {
      closeExitConfirm();
      return;
    }
    if (modal.id === "delete-confirm-modal") {
      document.dispatchEvent(new CustomEvent("tv-close-delete-confirm"));
      return;
    }
    if (modal.id === "player-tracks-panel") {
      window.TVPlayer?.closeTracksPanel();
      return;
    }
    if (modal.id === "player-overlay") {
      document.getElementById("player-close-btn")?.click();
      return;
    }
    const closeBtn = modal.querySelector("#download-modal-close, #detail-page-close, #version-modal-close, #trailer-close-btn");
    if (closeBtn) closeBtn.click();
  }

  // Some Samsung TV firmware delivers BOTH a keydown (keyCode 10009) and a
  // separate "tizenhwkey" event for the same physical back-button press.
  // Without this guard, the first call closes the open modal and the very
  // next call (finding nothing left open) exits the whole app.
  let lastBackOutAt = 0;
  const BACK_OUT_DEBOUNCE_MS = 500;

  function backOut() {
    const now = Date.now();
    if (now - lastBackOutAt < BACK_OUT_DEBOUNCE_MS) return;
    lastBackOutAt = now;

    const modal = openModal();
    const sidenavOpen = window.TVFocusManager?.isSidenavOpen?.();

    if (modal) {
      closeModal();
    } else if (sidenavOpen) {
      window.TVFocusManager.closeSidenav();
    } else {
      showExitConfirm();
    }
  }

  // Back on the main posters page (nothing else open) asks for
  // confirmation instead of exiting immediately, so an accidental extra
  // Back press doesn't kick you out of the app.
  let preExitConfirmFocus = null;

  function showExitConfirm() {
    const modal = document.getElementById("exit-confirm-modal");
    if (!modal) {
      exitApp();
      return;
    }
    preExitConfirmFocus = document.activeElement;
    modal.hidden = false;
    const yesBtn = document.getElementById("exit-confirm-yes");
    document.querySelectorAll(".tv-focused").forEach((n) => n.classList.remove("tv-focused"));
    yesBtn?.classList.add("tv-focused");
    yesBtn?.focus();
  }

  function closeExitConfirm() {
    const modal = document.getElementById("exit-confirm-modal");
    if (modal) modal.hidden = true;
    if (preExitConfirmFocus && document.contains(preExitConfirmFocus) && preExitConfirmFocus.offsetParent !== null) {
      preExitConfirmFocus.classList.add("tv-focused");
      preExitConfirmFocus.focus({ preventScroll: true });
    } else {
      window.TVFocusManager?.focusFirst();
    }
    preExitConfirmFocus = null;
  }

  function exitApp() {
    if (typeof tizen !== "undefined" && tizen.application) {
      try {
        tizen.application.getCurrentApplication().exit();
        return;
      } catch (err) {
        console.warn("[remote-control] exit() failed:", err.message);
      }
    }
    // Dev/browser fallback: nothing meaningful to do outside Tizen.
    console.info("[remote-control] exit requested (no-op outside Tizen)");
  }

  // The main player is now backed by AVPlay (see index.html's
  // startPlayer()/webapis.avplay) instead of a <video> element - AVPlay has
  // no per-element media API at all (getCurrentTime/seekTo/play/pause all
  // live on the single global webapis.avplay singleton, not on
  // #player-video itself), so it can't be manipulated the same way the
  // trailer's real <video> element still is. mainPlayerOpen()/trailerOpen()
  // pick which path a given key press should take.
  function mainPlayerOpen() {
    const player = document.getElementById("player-overlay");
    return Boolean(player && !player.hidden);
  }

  function trailerOpen() {
    const trailer = document.getElementById("trailer-overlay");
    return Boolean(trailer && !trailer.hidden);
  }

  function activeTrailerVideoElement() {
    return trailerOpen() ? document.getElementById("trailer-video") : null;
  }

  // Left/Right while a video is open seeks instead of moving focus.
  // Holding the key repeats (browser key-repeat fires keydown with
  // e.repeat=true) and each repeat jumps a bit further, so a long press
  // feels like it's fast-forwarding/rewinding quicker rather than just
  // taking many identical small steps.
  const SEEK_STEP_SECONDS = 10;
  const SEEK_MAX_STEP_SECONDS = 60;
  let seekRepeatDirection = null;
  let seekRepeatCount = 0;

  function seekActiveMedia(deltaSeconds) {
    if (mainPlayerOpen()) {
      window.TVPlayer?.seekBy(deltaSeconds);
      return;
    }
    const video = activeTrailerVideoElement();
    if (!video) return;
    // The trailer stream is a live server-side mux with no known total
    // length up front, so video.duration is often not a finite number yet
    // — don't require one just to clamp the lower bound.
    const maxTime = Number.isFinite(video.duration) ? video.duration : Infinity;
    video.currentTime = Math.min(Math.max(0, video.currentTime + deltaSeconds), maxTime);
  }

  function handleSeekKey(direction, isRepeat) {
    if (!isRepeat || seekRepeatDirection !== direction) {
      seekRepeatDirection = direction;
      seekRepeatCount = 0;
    } else {
      seekRepeatCount += 1;
    }
    const step = Math.min(SEEK_STEP_SECONDS * (1 + seekRepeatCount), SEEK_MAX_STEP_SECONDS);
    seekActiveMedia(direction === "right" ? step : -step);
    if (mainPlayerOpen()) window.TVPlayer?.showControls();
  }

  function resetSeekRepeat() {
    seekRepeatDirection = null;
    seekRepeatCount = 0;
  }

  function dispatchMediaEvent(action) {
    document.dispatchEvent(new CustomEvent("tv-media-command", { detail: { action } }));

    if (mainPlayerOpen()) {
      switch (action) {
        case "play":
        case "play-pause":
        case "pause":
          window.TVPlayer?.togglePlayPause();
          break;
        case "stop":
          document.getElementById("player-close-btn")?.click();
          break;
        case "fast-forward":
          window.TVPlayer?.seekBy(10);
          break;
        case "rewind":
          window.TVPlayer?.seekBy(-10);
          break;
      }
      return;
    }

    const video = activeTrailerVideoElement();
    if (!video) return;
    switch (action) {
      case "play":
      case "play-pause":
        window.TVTrailer ? window.TVTrailer.togglePlayPause() : (video.paused ? video.play() : video.pause());
        break;
      case "pause":
        video.pause();
        break;
      case "stop":
        video.pause();
        video.currentTime = 0;
        break;
      case "fast-forward":
        video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 10);
        break;
      case "rewind":
        video.currentTime = Math.max(0, video.currentTime - 10);
        break;
    }
  }

  // The old <video> element reliably became document.activeElement after
  // .focus() (see index.html's startPlayer()), so gating seek/tracks-panel
  // handling on "focus is literally on player-video" worked fine. AVPlay's
  // render target is an <object type="application/avplayer"> instead, and
  // that does NOT reliably hold keyboard focus the same way on this
  // platform - confirmed by seek keys silently doing nothing once the
  // <video>-to-AVPlay migration landed. Gate on the tracks panel's own
  // hidden state instead: it's already the thing that should "steal" Left/
  // Right/Up from the player while open (for navigating its own track
  // list), and unlike focus-equality it doesn't depend on the platform's
  // opinion of whether an <object> is focusable.
  function playerIsActiveModal() {
    const tracksPanel = document.getElementById("player-tracks-panel");
    if (tracksPanel && !tracksPanel.hidden) return false;
    return mainPlayerOpen();
  }

  function handleKeydown(e) {
    const direction = KEYCODE_DIRECTION[e.keyCode];
    if (direction) {
      if ((direction === "left" || direction === "right") && isTextEntry(document.activeElement)) {
        return; // let the caret move within the text field
      }
      if (playerIsActiveModal()) {
        if (direction === "left" || direction === "right") {
          e.preventDefault();
          handleSeekKey(direction, e.repeat);
        } else if (direction === "up") {
          e.preventDefault();
          window.TVPlayer?.openTracksPanel();
        }
        return; // down while the player is open: no-op for now
      }
      if (document.activeElement === document.getElementById("trailer-video")) {
        if (direction === "left" || direction === "right") {
          e.preventDefault();
          handleSeekKey(direction, e.repeat);
        }
        return;
      }
      e.preventDefault();
      window.TVFocusManager?.moveFocus(direction);
      return;
    }

    if (e.keyCode === 13) {
      if (playerIsActiveModal()) {
        // The player has no native controls to activate (see the
        // direction-key handling above) — Enter/OK is play/pause here.
        e.preventDefault();
        window.TVPlayer?.togglePlayPause();
        return;
      }
      if (document.activeElement === document.getElementById("trailer-video")) {
        e.preventDefault();
        window.TVTrailer?.togglePlayPause();
        return;
      }
      // Enter: don't rely on the platform auto-activating a focused
      // <button>/<a> on Enter — confirmed unreliable on Tizen's WebKit
      // (this is the same category of issue as the native video controls:
      // assumed-native remote/keyboard behavior that doesn't actually
      // happen on this platform). Click it ourselves instead. Leave real
      // text inputs alone so Enter doesn't do anything unexpected there.
      const el = document.activeElement;
      if (!el) return;
      if (el.tagName === "BUTTON" || el.tagName === "A") {
        e.preventDefault();
        el.click();
      } else if (el.getAttribute("tabindex") === "0") {
        e.preventDefault();
        window.TVFocusManager?.activateFocused();
      }
      return;
    }

    // Desktop-browser convenience for tizen/preview-dist.js: real Tizen
    // remotes never send Backspace, so this is safe to treat as Return as
    // long as it's not actually editing text.
    const isDesktopBackAlias = e.keyCode === 8 && !isTextEntry(document.activeElement);

    if (RETURN_KEYCODES.has(e.keyCode) || isDesktopBackAlias) {
      e.preventDefault();
      backOut();
      return;
    }

    if (EXIT_KEYCODES.has(e.keyCode)) {
      e.preventDefault();
      exitApp();
      return;
    }

    const mediaAction = MEDIA_KEYCODES[e.keyCode];
    if (mediaAction) {
      e.preventDefault();
      dispatchMediaEvent(mediaAction);
    }
  }

  // Older Tizen reference apps deliver the back key as a custom
  // "tizenhwkey" event instead of (or in addition to) a keydown; handle
  // both so the app behaves the same across TV firmware versions.
  function handleHwKey(e) {
    if (e.keyName === "back") backOut();
  }

  function handleKeyup(e) {
    if (KEYCODE_DIRECTION[e.keyCode] === seekRepeatDirection) resetSeekRepeat();
  }

  registerTizenKeys();
  document.addEventListener("keydown", handleKeydown);
  document.addEventListener("keyup", handleKeyup);
  document.addEventListener("tizenhwkey", handleHwKey);

  // Delegated on document rather than bound directly to the buttons: this
  // script tag loads at the very top of <body>, before the exit-confirm
  // modal's own HTML further down has been parsed, so getElementById here
  // would find nothing and silently attach to null. Delegation only looks
  // the buttons up once a real click event happens, long after the DOM is
  // fully built — this is the actual reason Enter (which dispatches a
  // synthetic click via el.click(), see the keyCode 13 handler above) never
  // did anything on this dialog: the click fired into a pair of buttons
  // with no listener at all, not a problem with Enter itself.
  document.addEventListener("click", (e) => {
    if (e.target.closest("#exit-confirm-yes")) {
      exitApp();
    } else if (e.target.closest("#exit-confirm-cancel")) {
      closeExitConfirm();
    }
  });
})();
