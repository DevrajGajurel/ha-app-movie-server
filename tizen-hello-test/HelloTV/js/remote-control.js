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
    const closeBtn = modal.querySelector("#download-modal-close, #detail-page-close, #version-modal-close");
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

  // Left/Right while the player is open seeks instead of moving focus.
  // Holding the key repeats (browser key-repeat fires keydown with
  // e.repeat=true) and each repeat jumps a bit further, so a long press
  // feels like it's fast-forwarding/rewinding quicker rather than just
  // taking many identical small steps.
  const SEEK_STEP_SECONDS = 10;
  const SEEK_MAX_STEP_SECONDS = 60;
  let seekRepeatDirection = null;
  let seekRepeatCount = 0;

  function seekPlayer(deltaSeconds) {
    const video = document.getElementById("player-video");
    if (!video || !Number.isFinite(video.duration)) return;
    video.currentTime = Math.min(Math.max(0, video.currentTime + deltaSeconds), video.duration);
  }

  function handlePlayerSeek(direction, isRepeat) {
    if (!isRepeat || seekRepeatDirection !== direction) {
      seekRepeatDirection = direction;
      seekRepeatCount = 0;
    } else {
      seekRepeatCount += 1;
    }
    const step = Math.min(SEEK_STEP_SECONDS * (1 + seekRepeatCount), SEEK_MAX_STEP_SECONDS);
    seekPlayer(direction === "right" ? step : -step);
    window.TVPlayer?.showControls();
  }

  function resetSeekRepeat() {
    seekRepeatDirection = null;
    seekRepeatCount = 0;
  }

  function dispatchMediaEvent(action) {
    document.dispatchEvent(new CustomEvent("tv-media-command", { detail: { action } }));

    // If the app ever adds a <video> element, wire the transport keys to it
    // for free; harmless no-op otherwise.
    const video = document.querySelector("video");
    if (!video) return;
    switch (action) {
      case "play":
      case "play-pause":
        window.TVPlayer ? window.TVPlayer.togglePlayPause() : (video.paused ? video.play() : video.pause());
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

  function handleKeydown(e) {
    const player = document.getElementById("player-overlay");
    const playerOpen = Boolean(player && !player.hidden);

    const direction = KEYCODE_DIRECTION[e.keyCode];
    if (direction) {
      if ((direction === "left" || direction === "right") && isTextEntry(document.activeElement)) {
        return; // let the caret move within the text field
      }
      if (playerOpen && document.activeElement === document.getElementById("player-video")) {
        if (direction === "left" || direction === "right") {
          e.preventDefault();
          handlePlayerSeek(direction, e.repeat);
        } else if (direction === "up") {
          e.preventDefault();
          window.TVPlayer?.openTracksPanel();
        }
        return; // down while the player is open: no-op for now
      }
      e.preventDefault();
      window.TVFocusManager?.moveFocus(direction);
      return;
    }

    if (e.keyCode === 13) {
      if (playerOpen && document.activeElement === document.getElementById("player-video")) {
        // The player has no native controls to activate (see the
        // direction-key handling above) — Enter/OK is play/pause here.
        e.preventDefault();
        window.TVPlayer?.togglePlayPause();
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
  document.getElementById("exit-confirm-yes")?.addEventListener("click", exitApp);
  document.getElementById("exit-confirm-cancel")?.addEventListener("click", closeExitConfirm);
})();
