import { useEffect, useMemo, useRef, useState } from "react";
import { usePlayer } from "./usePlayer";
import { buildPlayUrl, getProgress, saveProgress, reportClientError, getVersions, type MediaVersion } from "./api";

interface PlayerProps {
  tmdbId?: string | null;
  title: string;
  fileToken?: string | null;
  // Seeks here once the player is ready, instead of resuming from saved
  // progress - used when jumping straight to a specific episode's estimated
  // start time inside a season-pack file (see Detail.tsx's episode grid).
  startAtSeconds?: number;
  onClose: () => void;
}

const RESUME_MIN_SECONDS = 10;
const PROGRESS_SAVE_INTERVAL_MS = 10000;

// Ramps the jump size up every repeat while the seek key is held (10s, 20s,
// 30s...) instead of always jumping a flat 10s - keeps climbing for as long
// as the button stays held, uncapped, so a long hold covers a lot more of
// the timeline instead of leveling off and crawling.
const SEEK_STEP_SECONDS = 10;

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

function trackLabel(t: { language: string | null; title: string | null; index: number }): string {
  return t.title || (t.language ? t.language.toUpperCase() : `Track ${t.index + 1}`);
}

export function Player({ tmdbId = null, title, fileToken, startAtSeconds, onClose }: PlayerProps) {
  const player = usePlayer();
  const lastSaveAtRef = useRef(0);
  const rememberedAppliedRef = useRef(false);
  const seekRepeatDirectionRef = useRef<"left" | "right" | null>(null);
  const seekRepeatCountRef = useRef(0);

  const [version, setVersion] = useState<MediaVersion | null>(null);
  const [selectedAudioTrack, setSelectedAudioTrack] = useState(0);
  const [selectedSubtitleTrack, setSelectedSubtitleTrack] = useState<number | null>(null);
  const [tracksPanelOpen, setTracksPanelOpen] = useState(false);
  const [tracksFocusIndex, setTracksFocusIndex] = useState(0);
  const [centerIcon, setCenterIcon] = useState<string | null>(null);
  const centerIconTimerRef = useRef<number | null>(null);

  // Auto-hides the title/progress/time overlay after a few seconds of
  // inactivity during playback, matching HelloTV's showPlayerControls() -
  // stays visible while paused (nothing to hide it from) or right after any
  // interaction, same Netflix/Jellyfin/Prime convention.
  const CONTROLS_HIDE_MS = 4000;
  const [controlsVisible, setControlsVisible] = useState(true);
  const controlsHideTimerRef = useRef<number | null>(null);

  function showControls() {
    setControlsVisible(true);
    if (controlsHideTimerRef.current) window.clearTimeout(controlsHideTimerRef.current);
    if (player.state === "PLAYING") {
      controlsHideTimerRef.current = window.setTimeout(() => setControlsVisible(false), CONTROLS_HIDE_MS);
    }
  }

  useEffect(() => {
    return () => {
      if (controlsHideTimerRef.current) window.clearTimeout(controlsHideTimerRef.current);
    };
  }, []);

  // Resuming playback (e.g. after the tracks panel closes, or after a
  // pause) should restart the hide countdown even without a fresh keypress.
  useEffect(() => {
    showControls();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player.state]);

  // Brief play/pause glyph flash on toggle, matching HelloTV's
  // flashPlayerCenterIcon() - the only visual feedback Enter/OK gives here,
  // since there's no persistent play/pause button.
  function flashCenterIcon(glyph: string) {
    setCenterIcon(glyph);
    if (centerIconTimerRef.current) window.clearTimeout(centerIconTimerRef.current);
    centerIconTimerRef.current = window.setTimeout(() => setCenterIcon(null), 600);
  }

  function togglePlayPauseWithFlash() {
    const wasPlaying = player.state === "PLAYING";
    player.togglePlayPause();
    flashCenterIcon(wasPlaying ? "⏸" : "▶");
    showControls();
  }

  // Opens the stream once on mount. raw=1 (baked into buildPlayUrl) is
  // load-bearing: it bypasses the server's eac3->AAC transcode built for
  // the old <video>-element app, which AVPlay doesn't need and which would
  // otherwise collapse the file down to a single audio track.
  useEffect(() => {
    player.open(buildPlayUrl(tmdbId, title, fileToken));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tmdbId, title, fileToken]);

  // This exact file's track list, for the tracks panel's labels - the
  // combined getTotalTrackInfo() index AVPlay actually needs for
  // setSelectTrack lives in avplay.ts's own trackIndexMap, keyed by this
  // same per-type position (0-based within just audio/just text), so the
  // two stay in sync without either side needing to know about the other.
  useEffect(() => {
    getVersions(tmdbId, title)
      .then((versions) => {
        const match = (fileToken && versions.find((v) => v.token === fileToken)) || versions[0];
        setVersion(match || null);
      })
      .catch(() => {
        // No track info available - panel just won't offer anything.
      });
  }, [tmdbId, title, fileToken]);

  // Resume position + remembered audio/subtitle track - applied once the
  // player is actually ready, since seekTo()/selectAudioTrack() both throw
  // before that.
  useEffect(() => {
    if (!player.isReady || rememberedAppliedRef.current) return;
    rememberedAppliedRef.current = true;
    // An explicit start point (a specific episode picked out of a season-
    // pack file) always wins over resuming wherever this file was last left
    // off - the user just chose exactly where to start.
    const hasExplicitStart = Number.isFinite(startAtSeconds) && (startAtSeconds as number) > 0;
    if (hasExplicitStart) player.seekToSeconds(startAtSeconds as number);
    getProgress(tmdbId, title, fileToken).then((progress) => {
      if (!hasExplicitStart && progress && progress.positionSeconds >= RESUME_MIN_SECONDS) {
        player.seekToSeconds(progress.positionSeconds);
      }
      if (progress && Number.isInteger(progress.audioTrack) && progress.audioTrack !== 0) {
        setSelectedAudioTrack(progress.audioTrack);
        player.selectAudioTrack(progress.audioTrack);
      }
      // Always explicitly apply subtitle state, even when there's no
      // remembered track: AVPlay auto-shows the first embedded subtitle
      // track by default unless setSilentSubtitle(true) is called, so
      // skipping this call when there's nothing remembered left the menu
      // showing "Off" while the native player silently displayed subtitles
      // anyway. Matches HelloTV's avApplyPendingAdjustments, which always
      // calls avSelectSubtitleTrack(selectedSubtitleTrack) unconditionally.
      const subtitleTrack = progress && progress.subtitleTrack != null ? progress.subtitleTrack : null;
      setSelectedSubtitleTrack(subtitleTrack);
      player.selectSubtitleTrack(subtitleTrack);
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
      audioTrack: selectedAudioTrack,
      subtitleTrack: selectedSubtitleTrack,
    });
  }, [player.currentMs, player.isReady, player.durationMs, tmdbId, title, fileToken, selectedAudioTrack, selectedSubtitleTrack]);

  useEffect(() => {
    if (player.error) {
      reportClientError("avplay.error", player.error, { tmdbId, title, fileToken });
      const timer = window.setTimeout(onClose, 4000);
      return () => window.clearTimeout(timer);
    }
  }, [player.error, tmdbId, title, fileToken, onClose]);

  function closeAndSave() {
    if (player.durationMs > 0) {
      saveProgress({
        tmdbId,
        title,
        fileToken,
        positionSeconds: player.currentMs / 1000,
        durationSeconds: player.durationMs / 1000,
        audioTrack: selectedAudioTrack,
        subtitleTrack: selectedSubtitleTrack,
      });
    }
    onClose();
  }

  // Combined audio+subtitle option list for the tracks panel - "Off" is
  // always the first subtitle option, matching HelloTV's panel.
  const trackOptions = useMemo(() => {
    const audio = (version?.audioTracks || []).map((t) => ({ kind: "audio" as const, index: t.index, label: trackLabel(t) }));
    const subtitle: { kind: "subtitle"; index: number | null; label: string }[] = [
      { kind: "subtitle", index: null, label: "Subtitles: Off" },
      ...(version?.subtitleTracks || []).map((t) => ({ kind: "subtitle" as const, index: t.index, label: trackLabel(t) })),
    ];
    return [...audio, ...subtitle];
  }, [version]);

  function handleSeekKey(direction: "left" | "right", isRepeat: boolean) {
    if (!isRepeat || seekRepeatDirectionRef.current !== direction) {
      seekRepeatDirectionRef.current = direction;
      seekRepeatCountRef.current = 0;
    } else {
      seekRepeatCountRef.current += 1;
    }
    const step = SEEK_STEP_SECONDS * (1 + seekRepeatCountRef.current);
    player.seekBy(direction === "right" ? step : -step);
    showControls();
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
      if (tracksPanelOpen) {
        if (e.keyCode === 40) setTracksFocusIndex((i) => Math.min(trackOptions.length - 1, i + 1));
        else if (e.keyCode === 38) setTracksFocusIndex((i) => Math.max(0, i - 1));
        else if (e.keyCode === 13) {
          const opt = trackOptions[tracksFocusIndex];
          if (opt) {
            if (opt.kind === "audio") {
              setSelectedAudioTrack(opt.index);
              player.selectAudioTrack(opt.index);
            } else {
              setSelectedSubtitleTrack(opt.index);
              player.selectSubtitleTrack(opt.index);
            }
          }
          setTracksPanelOpen(false);
        } else if (e.keyCode === 10009 || e.keyCode === 27) {
          setTracksPanelOpen(false);
        }
        return;
      }

      switch (e.keyCode) {
        case 13: // Enter/OK
          togglePlayPauseWithFlash();
          break;
        case 37: // Left
          handleSeekKey("left", e.repeat);
          break;
        case 39: // Right
          handleSeekKey("right", e.repeat);
          break;
        case 38: // Up
          if (trackOptions.length > 1) {
            setTracksFocusIndex(0);
            setTracksPanelOpen(true);
          }
          break;
        case 10009: // Back (Tizen remote)
        case 27: // Escape (desktop preview fallback)
          closeAndSave();
          break;
        // Dedicated remote transport buttons - only delivered at all once
        // registered in main.tsx (Tizen doesn't dispatch keydown for these
        // otherwise, which is why Play previously did nothing).
        case 415: // MediaPlay
        case 19: // MediaPause
        case 10252: // MediaPlayPause
          togglePlayPauseWithFlash();
          break;
        case 413: // MediaStop
          closeAndSave();
          break;
        case 417: // MediaFastForward
          handleSeekKey("right", e.repeat);
          break;
        case 412: // MediaRewind
          handleSeekKey("left", e.repeat);
          break;
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player, tmdbId, title, fileToken, onClose, tracksPanelOpen, tracksFocusIndex, trackOptions, selectedAudioTrack, selectedSubtitleTrack]);

  const pct = player.durationMs > 0 ? Math.min(100, Math.max(0, (player.currentMs / player.durationMs) * 100)) : 0;

  return (
    <div>
      <object id="avplayer" className="player-surface" type="application/avplayer" />
      <div className={"player-center-icon" + (centerIcon ? " show" : "")}>{centerIcon}</div>
      {player.subtitleText && <div className="subtitle-cue">{player.subtitleText}</div>}
      <div className={"player-overlay" + (controlsVisible ? "" : " controls-hidden")}>
        <div className="player-title">{title}</div>
        <div className="player-progress-track">
          <div className="player-progress-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="player-time">
          <span>{formatTime(player.currentMs / 1000)}</span>
          <span>{formatTime(player.durationMs / 1000)}</span>
        </div>
        {trackOptions.length > 1 && !tracksPanelOpen ? (
          <div style={{ marginTop: 10, color: "var(--muted)", fontSize: 14 }}>▲ Audio &amp; Subtitles</div>
        ) : null}
      </div>
      {tracksPanelOpen ? (
        <div className="detail-overlay" style={{ background: "rgba(10,10,13,0.92)", padding: "60px 80px" }}>
          <h2 style={{ marginTop: 0 }}>Audio &amp; Subtitles</h2>
          {trackOptions.map((opt, i) => {
            const isSelected = opt.kind === "audio" ? opt.index === selectedAudioTrack : opt.index === selectedSubtitleTrack;
            return (
              <div
                key={`${opt.kind}-${opt.index}`}
                style={{
                  padding: "12px 20px",
                  marginBottom: 6,
                  borderRadius: 8,
                  maxWidth: 500,
                  background: i === tracksFocusIndex ? "var(--bg-elevated)" : "transparent",
                  border: i === tracksFocusIndex ? "2px solid var(--focus-ring)" : "2px solid transparent",
                  fontWeight: isSelected ? 700 : 400,
                }}
              >
                {isSelected ? "✓ " : ""}
                {opt.label}
              </div>
            );
          })}
        </div>
      ) : null}
      {player.error && <div className="player-error">Playback error: {player.error}</div>}
    </div>
  );
}
