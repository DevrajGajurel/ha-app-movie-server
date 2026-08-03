import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";

// Some Samsung TV firmware delivers BOTH a real keydown (keyCode 10009) AND
// a separate tizenhwkey event for the SAME physical Back press. Every
// screen's own back handler (Home/Detail/DownloadModal/Search/Player) reacts
// to the first of the two, closing/returning to whatever's underneath - the
// duplicate then lands on that next screen and triggers ITS back handler
// too, which is why Home's exit-confirm was popping up after leaving
// Detail/Search/Downloads/the player: the second, spurious 10009 always
// found itself back on the browse screen with nothing left to close.
// Swallowed here once, in the capture phase (runs before any component's own
// bubble-phase listener), so no per-screen code needs to know about this.
let lastBackAt = 0;
const BACK_DEBOUNCE_MS = 500;
document.addEventListener(
  "keydown",
  (e: KeyboardEvent) => {
    if (e.keyCode !== 10009) return;
    const now = Date.now();
    if (now - lastBackAt < BACK_DEBOUNCE_MS) {
      e.stopImmediatePropagation();
      return;
    }
    lastBackAt = now;
  },
  true
);

// tizenhwkey is Samsung's own back-button event on top of (sometimes
// instead of) a normal keydown - handled once here at the app root so
// every screen gets consistent Back behavior without wiring it per-screen.
document.addEventListener("tizenhwkey", (e: Event) => {
  const key = (e as CustomEvent & { keyName?: string }).keyName;
  if (key === "back") {
    document.dispatchEvent(new KeyboardEvent("keydown", { keyCode: 10009 } as KeyboardEventInit));
  }
});

// Arrows/Enter/Back are delivered automatically per Samsung's docs, but the
// remote's dedicated media-transport buttons (Play, Pause, Play/Pause,
// Stop, Rewind, Fast-Forward) are NOT - without registering them here first,
// Tizen never even dispatches a keydown for them, which is exactly why the
// Play button did nothing on any screen (Player.tsx's keyCode switch was
// never reached). Matches HelloTV's remote-control.js registration.
const MEDIA_KEYS_TO_REGISTER = ["MediaPlay", "MediaPause", "MediaStop", "MediaRewind", "MediaFastForward", "MediaPlayPause"];
if (typeof tizen !== "undefined" && tizen.tvinputdevice) {
  for (const key of MEDIA_KEYS_TO_REGISTER) {
    try {
      tizen.tvinputdevice.registerKey(key);
    } catch (err) {
      console.warn(`[main] could not register key "${key}":`, err instanceof Error ? err.message : err);
    }
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
