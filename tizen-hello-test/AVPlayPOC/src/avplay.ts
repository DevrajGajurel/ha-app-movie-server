// Thin wrapper around Samsung's webapis.avplay singleton (there is no
// per-element API - a single global instance renders into whichever
// <object type="application/avplayer"> currently exists in the DOM). Two
// hard-won facts baked in here, both confirmed against Samsung's own
// SampleWebApps-PlayerAvplayWithSubtitles source after the AVPlayPOC app's
// first attempt got them wrong:
//   1. jumpForward/jumpBackward take MILLISECONDS, not seconds.
//   2. setSelectTrack(type, index) wants the COMBINED index from
//      getTotalTrackInfo() (spanning video+audio+text together), not a
//      per-type index - hence trackIndexMap below.
import type { AVPlayState, AVPlayStreamInfo } from "./tizen-globals";

const DISPLAY_WIDTH = 1920;
const DISPLAY_HEIGHT = 1080;

export interface AVPlayerEvents {
  onStateChange?: (state: AVPlayState) => void;
  onProgress?: (currentMs: number, durationMs: number) => void;
  onBuffering?: (buffering: boolean) => void;
  onSubtitle?: (text: string) => void;
  onError?: (message: string) => void;
  onStreamCompleted?: () => void;
}

interface TrackIndexMap {
  audio: number[];
  text: number[];
}

export class AVPlayer {
  private events: AVPlayerEvents;
  private trackIndexMap: TrackIndexMap = { audio: [], text: [] };
  private ready = false;
  private seekBusy = false;

  constructor(events: AVPlayerEvents = {}) {
    this.events = events;
  }

  private get api() {
    const api = window.webapis?.avplay;
    if (!api) throw new Error("webapis.avplay is not available on this platform");
    return api;
  }

  get isReady(): boolean {
    return this.ready;
  }

  open(url: string): void {
    this.ready = false;
    this.trackIndexMap = { audio: [], text: [] };

    try {
      this.api.stop();
    } catch {
      /* nothing was playing yet - fine */
    }
    try {
      this.api.close();
    } catch {
      /* nothing was open yet - fine */
    }

    this.api.open(url);
    this.api.setDisplayRect(0, 0, DISPLAY_WIDTH, DISPLAY_HEIGHT);
    try {
      this.api.setDisplayMethod("PLAYER_DISPLAY_MODE_FULL_SCREEN");
    } catch {
      /* optional - some firmware doesn't support this call */
    }

    this.api.setListener({
      onbufferingstart: () => this.events.onBuffering?.(true),
      onbufferingprogress: () => {},
      onbufferingcomplete: () => this.events.onBuffering?.(false),
      oncurrentplaytime: (ms) => this.events.onProgress?.(ms, this.getDurationMs()),
      onstreamcompleted: () => this.events.onStreamCompleted?.(),
      onerror: (eventType) => this.events.onError?.(String(eventType)),
      onsubtitlechange: (_duration, text) => this.events.onSubtitle?.(text || ""),
    });

    try {
      this.api.prepareAsync(
        () => {
          this.ready = true;
          this.refreshTrackIndexMap();
          this.notifyState();
        },
        (err) => this.events.onError?.(err?.message || "prepareAsync failed")
      );
    } catch (err) {
      this.events.onError?.(err instanceof Error ? err.message : "prepareAsync threw");
    }
  }

  private notifyState(): void {
    try {
      this.events.onStateChange?.(this.api.getState());
    } catch {
      /* ignore */
    }
  }

  play(): void {
    try {
      this.api.play();
    } catch {
      /* state might not allow it yet */
    }
    this.notifyState();
  }

  pause(): void {
    try {
      this.api.pause();
    } catch {
      /* ignore */
    }
    this.notifyState();
  }

  togglePlayPause(): void {
    const state = this.getState();
    if (state === "PLAYING") this.pause();
    else if (state === "PAUSED" || state === "READY") this.play();
  }

  getState(): AVPlayState {
    try {
      return this.api.getState();
    } catch {
      return "NONE";
    }
  }

  getDurationMs(): number {
    try {
      return this.api.getDuration();
    } catch {
      return 0;
    }
  }

  getCurrentTimeMs(): number {
    try {
      return this.api.getCurrentTime();
    } catch {
      return 0;
    }
  }

  // AVPlay requires waiting for a seek's own callback before issuing
  // another seekTo/jumpForward/jumpBackward - firing them back to back
  // (e.g. holding the remote's seek key) throws otherwise.
  seekBy(deltaSeconds: number): void {
    if (!this.ready || this.seekBusy) return;
    this.seekBusy = true;
    const ms = Math.round(Math.abs(deltaSeconds) * 1000);
    const done = () => {
      this.seekBusy = false;
    };
    try {
      if (deltaSeconds >= 0) this.api.jumpForward(ms, done, done);
      else this.api.jumpBackward(ms, done, done);
    } catch {
      this.seekBusy = false;
    }
  }

  seekToSeconds(seconds: number): void {
    if (!this.ready) return;
    try {
      this.api.seekTo(Math.max(0, Math.round(seconds * 1000)));
    } catch {
      /* ignore */
    }
  }

  private refreshTrackIndexMap(): void {
    let info: AVPlayStreamInfo[] = [];
    try {
      info = this.api.getTotalTrackInfo() || [];
    } catch {
      info = [];
    }
    const audio: number[] = [];
    const text: number[] = [];
    for (const track of info) {
      if (track.type === "AUDIO") audio.push(track.index);
      else if (track.type === "TEXT") text.push(track.index);
    }
    this.trackIndexMap = { audio, text };
  }

  // `trackPosition` is the Nth track of that type (0-based), matching how
  // the backend's ffprobe-derived audioTracks/subtitleTracks arrays are
  // already indexed - translated here to the combined index setSelectTrack
  // actually wants.
  selectAudioTrack(trackPosition: number): void {
    const combinedIndex = this.trackIndexMap.audio[trackPosition];
    if (combinedIndex == null) return;
    try {
      this.api.setSelectTrack("AUDIO", combinedIndex);
    } catch {
      /* ignore */
    }
  }

  selectSubtitleTrack(trackPosition: number | null): void {
    try {
      if (trackPosition == null) {
        this.api.setSilentSubtitle(true);
        this.events.onSubtitle?.("");
        return;
      }
      const combinedIndex = this.trackIndexMap.text[trackPosition];
      if (combinedIndex != null) this.api.setSelectTrack("TEXT", combinedIndex);
      this.api.setSilentSubtitle(false);
    } catch {
      /* ignore */
    }
  }

  stopAndClose(): void {
    try {
      const state = this.api.getState();
      if (state === "PLAYING" || state === "PAUSED") this.api.stop();
    } catch {
      /* ignore */
    }
    try {
      this.api.close();
    } catch {
      /* ignore */
    }
    this.ready = false;
  }
}
