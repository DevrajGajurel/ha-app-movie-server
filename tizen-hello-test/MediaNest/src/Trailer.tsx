import { useEffect, useRef, useState } from "react";
import { buildTrailerUrl } from "./api";

interface TrailerProps {
  trailerKey: string;
  onClose: () => void;
}

// Same ramping-step idea as Player.tsx's handleSeekKey - keeps climbing for
// as long as the seek key stays held, uncapped.
const SEEK_STEP_SECONDS = 10;

// The trailer is a server-resolved direct stream played through a plain
// <video> element, same technique as a downloaded movie - not a YouTube
// iframe embed (see /api/trailer in main.js, which resolves+remuxes the
// YouTube stream server-side). No AVPlay needed here: it's a short, single
// track stream, not the main title.
export function Trailer({ trailerKey, onClose }: TrailerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const seekRepeatDirectionRef = useRef<"left" | "right" | null>(null);
  const seekRepeatCountRef = useRef(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    videoRef.current?.play().catch(() => {
      // Autoplay can be blocked in some contexts - the user can still hit
      // Enter/OK to start it manually.
    });
  }, []);

  function togglePlayPause() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  }

  function handleSeekKey(direction: "left" | "right", isRepeat: boolean) {
    const video = videoRef.current;
    if (!video) return;
    if (!isRepeat || seekRepeatDirectionRef.current !== direction) {
      seekRepeatDirectionRef.current = direction;
      seekRepeatCountRef.current = 0;
    } else {
      seekRepeatCountRef.current += 1;
    }
    const step = SEEK_STEP_SECONDS * (1 + seekRepeatCountRef.current);
    const maxTime = Number.isFinite(video.duration) ? video.duration : Infinity;
    video.currentTime = Math.min(Math.max(0, video.currentTime + (direction === "right" ? step : -step)), maxTime);
  }

  useEffect(() => {
    function onKeyUp(e: KeyboardEvent) {
      const direction = e.keyCode === 37 ? "left" : e.keyCode === 39 ? "right" : null;
      if (direction && seekRepeatDirectionRef.current === direction) {
        seekRepeatDirectionRef.current = null;
        seekRepeatCountRef.current = 0;
      }
    }
    document.addEventListener("keyup", onKeyUp);
    return () => document.removeEventListener("keyup", onKeyUp);
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      switch (e.keyCode) {
        case 13: // Enter/OK
        case 415: // MediaPlay
        case 19: // MediaPause
        case 10252: // MediaPlayPause
          togglePlayPause();
          break;
        case 37: // Left
        case 412: // MediaRewind
          handleSeekKey("left", e.repeat);
          break;
        case 39: // Right
        case 417: // MediaFastForward
          handleSeekKey("right", e.repeat);
          break;
        case 10009: // Back (Tizen remote)
        case 27: // Escape (desktop preview fallback)
        case 413: // MediaStop
          onClose();
          break;
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="detail-overlay" style={{ background: "#000" }}>
      <video
        ref={videoRef}
        className="trailer-video"
        src={buildTrailerUrl(trailerKey)}
        onError={() => setError("Trailer failed to load.")}
        autoPlay
      />
      {error && <div className="player-error">{error}</div>}
    </div>
  );
}
