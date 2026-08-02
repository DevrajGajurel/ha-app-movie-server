import { useEffect, useMemo, useRef, useState } from "react";
import { usePlayer } from "./usePlayer";
import { buildPlayUrl, getProgress, saveProgress, reportClientError, getVersions, type MediaVersion } from "./api";

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

function trackLabel(t: { language: string | null; title: string | null; index: number }): string {
  return t.title || (t.language ? t.language.toUpperCase() : `Track ${t.index + 1}`);
}

export function Player({ tmdbId, title, fileToken, onClose }: PlayerProps) {
  const player = usePlayer();
  const lastSaveAtRef = useRef(0);
  const rememberedAppliedRef = useRef(false);

  const [version, setVersion] = useState<MediaVersion | null>(null);
  const [selectedAudioTrack, setSelectedAudioTrack] = useState(0);
  const [selectedSubtitleTrack, setSelectedSubtitleTrack] = useState<number | null>(null);
  const [tracksPanelOpen, setTracksPanelOpen] = useState(false);
  const [tracksFocusIndex, setTracksFocusIndex] = useState(0);

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
    getProgress(tmdbId, title, fileToken).then((progress) => {
      if (progress && progress.positionSeconds >= RESUME_MIN_SECONDS) {
        player.seekToSeconds(progress.positionSeconds);
      }
      if (progress && Number.isInteger(progress.audioTrack) && progress.audioTrack !== 0) {
        setSelectedAudioTrack(progress.audioTrack);
        player.selectAudioTrack(progress.audioTrack);
      }
      if (progress && progress.subtitleTrack != null) {
        setSelectedSubtitleTrack(progress.subtitleTrack);
        player.selectSubtitleTrack(progress.subtitleTrack);
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
          player.togglePlayPause();
          break;
        case 37: // Left
          player.seekBy(-10);
          break;
        case 39: // Right
          player.seekBy(10);
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
