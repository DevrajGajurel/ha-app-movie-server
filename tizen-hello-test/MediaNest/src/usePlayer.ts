import { useCallback, useEffect, useRef, useState } from "react";
import { AVPlayer } from "./avplay";
import type { AVPlayState } from "./tizen-globals";

export interface PlayerState {
  state: AVPlayState;
  currentMs: number;
  durationMs: number;
  buffering: boolean;
  subtitleText: string;
  error: string | null;
}

const INITIAL_STATE: PlayerState = {
  state: "NONE",
  currentMs: 0,
  durationMs: 0,
  buffering: false,
  subtitleText: "",
  error: null,
};

// One AVPlayer per mounted <Player> screen - webapis.avplay is a process-
// wide singleton, so this hook (and the screen using it) must never be
// mounted more than once at a time.
export function usePlayer() {
  const playerRef = useRef<AVPlayer | null>(null);
  const [state, setState] = useState<PlayerState>(INITIAL_STATE);

  if (!playerRef.current) {
    playerRef.current = new AVPlayer({
      onStateChange: (s) => setState((prev) => ({ ...prev, state: s })),
      onProgress: (currentMs, durationMs) => setState((prev) => ({ ...prev, currentMs, durationMs })),
      onBuffering: (buffering) => setState((prev) => ({ ...prev, buffering })),
      onSubtitle: (subtitleText) => setState((prev) => ({ ...prev, subtitleText })),
      onError: (error) => setState((prev) => ({ ...prev, error })),
      onStreamCompleted: () => setState((prev) => ({ ...prev, state: "NONE" })),
    });
  }

  useEffect(() => {
    return () => {
      playerRef.current?.stopAndClose();
    };
  }, []);

  const open = useCallback((url: string) => {
    setState(INITIAL_STATE);
    playerRef.current?.open(url);
  }, []);

  const togglePlayPause = useCallback(() => playerRef.current?.togglePlayPause(), []);
  const seekBy = useCallback((deltaSeconds: number) => playerRef.current?.seekBy(deltaSeconds), []);
  const seekToSeconds = useCallback((seconds: number) => playerRef.current?.seekToSeconds(seconds), []);
  const selectAudioTrack = useCallback((trackPosition: number) => playerRef.current?.selectAudioTrack(trackPosition), []);
  const selectSubtitleTrack = useCallback(
    (trackPosition: number | null) => playerRef.current?.selectSubtitleTrack(trackPosition),
    []
  );
  const close = useCallback(() => playerRef.current?.stopAndClose(), []);

  return {
    ...state,
    isReady: playerRef.current?.isReady ?? false,
    open,
    togglePlayPause,
    seekBy,
    seekToSeconds,
    selectAudioTrack,
    selectSubtitleTrack,
    close,
  };
}
