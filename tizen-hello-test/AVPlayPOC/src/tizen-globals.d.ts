// Samsung injects `tizen` and `webapis` into the page at runtime on real
// hardware - neither exists in a normal browser, and there's no official
// npm type package for either, so these are hand-written from Samsung's
// own AVPlay API reference + the SampleWebApps-PlayerAvplayWithSubtitles
// sample (github.com/SamsungDForum), covering only what this app uses.

export type AVPlayState = "NONE" | "IDLE" | "READY" | "PLAYING" | "PAUSED";
export type AVPlayStreamType = "VIDEO" | "AUDIO" | "TEXT";

export interface AVPlayStreamInfo {
  index: number;
  type: AVPlayStreamType;
  extra_info: string;
}

export interface AVPlayListener {
  onbufferingstart?: () => void;
  onbufferingprogress?: (percent: number) => void;
  onbufferingcomplete?: () => void;
  onstreamcompleted?: () => void;
  oncurrentplaytime?: (currentTimeMs: number) => void;
  onerror?: (eventType: string) => void;
  onevent?: (eventType: string, eventData: string) => void;
  onsubtitlechange?: (duration: string, text: string, type?: string, attributes?: unknown) => void;
  ondrmevent?: (drmEvent: string, drmData: unknown) => void;
}

export interface AVPlayApi {
  open(url: string): void;
  close(): void;
  prepare(): void;
  prepareAsync(successCallback: () => void, errorCallback?: (error: { message: string }) => void): void;
  play(): void;
  pause(): void;
  stop(): void;
  seekTo(millisecond: number, successCallback?: () => void, errorCallback?: (error: { message: string }) => void): void;
  jumpForward(millisecond: number, successCallback?: () => void, errorCallback?: (error: { message: string }) => void): void;
  jumpBackward(millisecond: number, successCallback?: () => void, errorCallback?: (error: { message: string }) => void): void;
  setDisplayRect(x: number, y: number, width: number, height: number): void;
  setDisplayMethod(method: string): void;
  setListener(listener: AVPlayListener): void;
  setSelectTrack(type: AVPlayStreamType, index: number): void;
  getTotalTrackInfo(): AVPlayStreamInfo[];
  setSilentSubtitle(silent: boolean): void;
  setExternalSubtitlePath(path: string): void;
  getState(): AVPlayState;
  getDuration(): number;
  getCurrentTime(): number;
  suspend(): void;
  restore(): void;
  setStreamingProperty(key: string, value: string): void;
}

export interface TizenApplication {
  exit(): void;
}

declare global {
  interface Window {
    webapis?: {
      avplay: AVPlayApi;
    };
    tizen?: {
      application: {
        getCurrentApplication(): TizenApplication;
      };
      tvinputdevice?: {
        registerKey(key: string): void;
      };
    };
  }

  // Samsung's own samples reference these as bare globals (not
  // window.webapis/window.tizen) - both forms resolve to the same
  // platform-injected objects, so declare both to match real usage.
  const webapis: Window["webapis"];
  const tizen: Window["tizen"];
}

export {};
