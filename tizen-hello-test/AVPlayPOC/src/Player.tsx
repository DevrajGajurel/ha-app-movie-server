import { useEffect, useRef } from "react";
import { usePlayer } from "./usePlayer";
import { buildPlayUrl, getProgress, saveProgress, reportClientError } from "./api";

interface PlayerProps {
  tmdbId: string | null;
  title: string;
  fileToken?: string | null;
  onClose: () => void;
}

const RESUME_MIN_SECONDS = 10;
const PROGRESS_SAVE_INTERVAL_MS = 10000;

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function Player({ tmdbId, title, fileToken, onClose }: PlayerProps) {
  const player = usePlayer();
  const lastSaveAtRef = useRef(0);
  const resumeAppliedRef = useRef(false);

  // Opens the stream once on mount. raw=1 (baked into buildPlayUrl) is
  // load-bearing: it bypasses the server's eac3->AAC transcode built for
  // the old <video>-element app, which AVPlay doesn't need and which would
  // otherwise collapse the file down to a single audio track.
  useEffect(() => {
    player.open(buildPlayUrl(tmdbId, title, fileToken));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tmdbId, title, fileToken]);

  // Resume position - applied once the player is actually ready, since
  // seekTo() throws before that.
  useEffect(() => {
    if (!player.isReady || resumeAppliedRef.current) return;
    resumeAppliedRef.current = true;
    getProgress(tmdbId, title, fileToken).then((progress) => {
      if (progress && progress.positionSeconds >= RESUME_MIN_SECONDS) {
        player.seekToSeconds(progress.positionSeconds);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player.isReady]);

  // Periodic + on-close progress save.
  useEffect(() => {
    if (!player.isReady || player.durationMs <= 0) return;
    const now = Date.now();
    if (now - lastSaveAtRef.current < PROGRESS_SAVE_INTERVAL_MS) return;
    lastSaveAtRef.current = now;
    saveProgress({
      tmdbId,
      title,
      fileToken,
      positionSeconds: player.currentMs / 1000,
      durationSeconds: player.durationMs / 1000,
      audioTrack: 0,
      subtitleTrack: null,
    });
  }, [player.currentMs, player.isReady, player.durationMs, tmdbId, title, fileToken]);

  useEffect(() => {
    if (player.error) {
      reportClientError("avplay.error", player.error, { tmdbId, title, fileToken });
      const timer = window.setTimeout(onClose, 4000);
      return () => window.clearTimeout(timer);
    }
  }, [player.error, tmdbId, title, fileToken, onClose]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      switch (e.keyCode) {
        case 13: // Enter/OK
          player.togglePlayPause();
          break;
        case 37: // Left
          player.seekBy(-10);
          break;
        case 39: // Right
          player.seekBy(10);
          break;
        case 10009: // Back (Tizen remote)
        case 27: // Escape (desktop preview fallback)
          if (player.durationMs > 0) {
            saveProgress({
              tmdbId,
              title,
              fileToken,
              positionSeconds: player.currentMs / 1000,
              durationSeconds: player.durationMs / 1000,
              audioTrack: 0,
              subtitleTrack: null,
            });
          }
          onClose();
          break;
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [player, tmdbId, title, fileToken, onClose]);

  const pct = player.durationMs > 0 ? Math.min(100, Math.max(0, (player.currentMs / player.durationMs) * 100)) : 0;

  return (
    <div>
      <object id="avplayer" className="player-surface" type="application/avplayer" />
      {player.subtitleText && <div className="subtitle-cue">{player.subtitleText}</div>}
      <div className="player-overlay">
        <div className="player-title">{title}</div>
        <div className="player-progress-track">
          <div className="player-progress-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="player-time">
          <span>{formatTime(player.currentMs / 1000)}</span>
          <span>{formatTime(player.durationMs / 1000)}</span>
        </div>
      </div>
      {player.error && <div className="player-error">Playback error: {player.error}</div>}
    </div>
  );
}
