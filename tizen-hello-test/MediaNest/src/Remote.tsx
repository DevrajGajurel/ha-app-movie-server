import { useEffect, useMemo, useRef, useState } from "react";
import { listRemoteDirectory, buildRemoteFileUrl, type RemoteItem } from "./api";

const VIDEO_EXTS = new Set([".mkv", ".mp4", ".avi", ".mov", ".webm", ".m4v", ".ts", ".flv"]);
const AUDIO_EXTS = new Set([".mp3", ".flac", ".aac", ".opus", ".m4a", ".wav"]);
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}

function itemTypeLabel(item: RemoteItem): string {
  if (item.type === "directory") return "folder";
  const ext = extOf(item.name);
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (IMAGE_EXTS.has(ext)) return "image";
  return "file";
}

function itemIcon(item: RemoteItem): string {
  if (item.type === "directory") return "📁";
  const ext = extOf(item.name);
  if (VIDEO_EXTS.has(ext)) return "🎬";
  if (AUDIO_EXTS.has(ext)) return "🎵";
  if (IMAGE_EXTS.has(ext)) return "🖼";
  if (ext === ".pdf") return "📄";
  if (ext === ".zip" || ext === ".rar" || ext === ".7z") return "🗜";
  return "📄";
}

function isVideoFile(item: RemoteItem): boolean {
  return VIDEO_EXTS.has(extOf(item.name));
}

// Matches a leading standalone 4-digit release year (e.g. "Movie (2020)")
// without also matching resolution/codec numbers like "1080p" or "x264" -
// the plain /\(?(\d{4})\)?/ this replaced grabbed "1080" out of "1080p" and
// sorted purely by resolution instead of by year.
function extractYear(filename: string): number {
  const match = filename.match(/[([]?(\d{4})[)\]]?(?=[^\d]|$)/);
  if (!match) return 0;
  const year = Number.parseInt(match[1], 10);
  return year >= 1900 && year <= 2100 ? year : 0;
}

interface RemoteProps {
  active: boolean;
  onBack: () => void;
  onRequestSidebar?: () => void;
  onPlayFile?: (url: string, title: string) => void;
}

export function Remote({ active, onBack, onRequestSidebar, onPlayFile }: RemoteProps) {
  const [base, setBase] = useState<string>("");
  const [currentPath, setCurrentPath] = useState<string>("/");
  const [items, setItems] = useState<RemoteItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [focusedIndex, setFocusedIndex] = useState(0);

  const gridRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  // Kept outside React state so the capture-phase Back handler (added
  // below) can read the live path without depending on stale closures.
  const currentPathRef = useRef("/");

  useEffect(() => {
    if (active) navigateRemote(currentPathRef.current);
    // Deliberately NOT clearing state when `active` goes false (losing
    // sidebar focus, e.g.) - only a real navigation should reset the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  async function navigateRemote(path: string): Promise<void> {
    setLoading(true);
    setError(null);
    setCurrentPath(path);
    currentPathRef.current = path;
    setFocusedIndex(0);

    try {
      const data = await listRemoteDirectory(path);
      setBase(data.base || "");
      setItems(data.items || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load directory");
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  function parentPath(path: string): string {
    const parts = path.replace(/^\//, "").replace(/\/$/, "").split("/").filter(Boolean);
    parts.pop();
    return parts.length ? "/" + parts.join("/") + "/" : "/";
  }

  function buildBreadcrumb(path: string): JSX.Element {
    const parts = path.replace(/^\//, "").replace(/\/$/, "").split("/").filter(Boolean);
    let cumulative = "";

    return (
      <div className="remote-breadcrumb">
        <button className="remote-crumb-btn" onClick={() => navigateRemote("/")}>
          Root
        </button>
        {parts.map((part) => {
          cumulative += "/" + part;
          const p = cumulative + "/";
          return (
            <button key={part} className="remote-crumb-btn secondary" onClick={() => navigateRemote(p)}>
              {part}
            </button>
          );
        })}
      </div>
    );
  }

  function fileUrl(item: RemoteItem): string {
    return buildRemoteFileUrl(base, item);
  }

  const sortedItems = useMemo(() => {
    return [...items].sort((a, b) => extractYear(b.name) - extractYear(a.name));
  }, [items]);

  function activateItem(item: RemoteItem | undefined) {
    if (!item) return;
    if (item.type === "directory") {
      navigateRemote(item.path);
    } else if (isVideoFile(item) && onPlayFile) {
      onPlayFile(fileUrl(item), item.name);
    }
  }

  // Row membership by shared offsetTop, same technique Row.tsx uses for its
  // own scroll math - the grid is CSS `auto-fill`, so the actual column
  // count depends on rendered width and can't be assumed.
  function columnsInGrid(): number {
    const track = gridRef.current;
    if (!track || !track.children.length) return 1;
    const firstTop = (track.children[0] as HTMLElement).offsetTop;
    let cols = 0;
    for (const child of Array.from(track.children)) {
      if ((child as HTMLElement).offsetTop === firstTop) cols++;
      else break;
    }
    return Math.max(1, cols);
  }

  useEffect(() => {
    if (focusedIndex < 0) return;
    itemRefs.current[focusedIndex]?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  }, [focusedIndex]);

  // Bubble-phase grid navigation: Left/Right/Up/Down move focus, Enter
  // opens a folder or plays a video, Left at column 0 hands focus to the
  // sidebar (matching Streams.tsx's onRequestSidebar pattern).
  useEffect(() => {
    if (!active) return;
    function onKeyDown(e: KeyboardEvent) {
      if (!sortedItems.length) return;
      const cols = columnsInGrid();
      switch (e.keyCode) {
        case 39: // Right
          setFocusedIndex((i) => Math.min(sortedItems.length - 1, i + 1));
          break;
        case 37: // Left
          setFocusedIndex((i) => {
            if (i % cols === 0) {
              onRequestSidebar?.();
              return i;
            }
            return Math.max(0, i - 1);
          });
          break;
        case 40: // Down
          setFocusedIndex((i) => Math.min(sortedItems.length - 1, i + cols));
          break;
        case 38: // Up
          setFocusedIndex((i) => Math.max(0, i - cols));
          break;
        case 13: // Enter/OK
          activateItem(sortedItems[focusedIndex]);
          break;
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, sortedItems, focusedIndex, onRequestSidebar]);

  // Capture-phase Back: go up one directory level instead of leaving the
  // Remote view entirely, same idea as Cineby's capture listener for D-pad
  // forwarding. Only intercepts (stopPropagation) when there's actually
  // somewhere to go up TO - at root, Back falls through to Home's own
  // document-level listener, which returns to Browse.
  useEffect(() => {
    if (!active) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.keyCode !== 10009 && e.keyCode !== 27) return;
      if (currentPathRef.current === "/") return;
      e.stopPropagation();
      navigateRemote(parentPath(currentPathRef.current));
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [active]);

  function renderRemoteGrid(): JSX.Element {
    return (
      <div className="remote-grid" ref={gridRef}>
        {sortedItems.map((item, index) => {
          const typeLabel = itemTypeLabel(item);
          const icon = itemIcon(item);
          const isDir = item.type === "directory";
          const isVideo = isVideoFile(item);
          const hasTmdb = !!item.tmdbId && (item.poster || item.backdrop);
          const focused = active && index === focusedIndex;

          return (
            <div
              key={item.path + index}
              ref={(el) => {
                itemRefs.current[index] = el;
              }}
              className={"remote-card" + (focused ? " focused" : "")}
              onClick={() => {
                setFocusedIndex(index);
                activateItem(item);
              }}
            >
              <div className="remote-card-thumb">
                {hasTmdb && item.poster ? (
                  <img src={item.poster} alt="" loading="lazy" />
                ) : (
                  <span className="remote-card-icon">{icon}</span>
                )}
                {isDir && <span className="remote-card-type">{typeLabel}</span>}
                {!hasTmdb && !isDir && <span className="remote-card-type">{typeLabel}</span>}
                {isVideo && !isDir && !hasTmdb && <span className="remote-card-type">{typeLabel}</span>}
              </div>
              <div className="remote-card-body">
                <div className="remote-card-name">{item.name}</div>
                <div className="remote-card-meta">
                  {[item.year, item.size].filter(Boolean).join(" ")}
                </div>
                <div className="remote-card-actions">
                  {isDir ? (
                    <span className="remote-card-hint">Open</span>
                  ) : (
                    <>
                      <a
                        href={fileUrl(item)}
                        target="_blank"
                        rel="noopener noreferrer"
                        download
                        className="remote-download-link"
                        onClick={(e) => e.stopPropagation()}
                      >
                        Download
                      </a>
                      {isVideo && <span className="remote-card-hint">Play</span>}
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  function renderContent(): JSX.Element {
    if (loading) {
      return (
        <div className="remote-empty">
          <div className="remote-empty-icon">⏳</div>
          <p>Loading directory...</p>
        </div>
      );
    }

    if (error) {
      return (
        <div className="remote-empty">
          <div className="remote-empty-icon">⚠️</div>
          <p>Failed to load directory: {error}</p>
        </div>
      );
    }

    if (sortedItems.length === 0) {
      return (
        <div className="remote-empty">
          <div className="remote-empty-icon">📂</div>
          <p>This directory is empty.</p>
        </div>
      );
    }

    return (
      <div>
        {buildBreadcrumb(currentPath)}
        <div className="remote-count">
          {sortedItems.length} item{sortedItems.length !== 1 ? "s" : ""}
        </div>
        {renderRemoteGrid()}
      </div>
    );
  }

  return (
    <div className="remote-view">
      <div className="remote-page">
        <div className="remote-header">
          <button className="remote-back-btn" onClick={onBack}>
            ← Back
          </button>
          <h1 className="remote-title">Remote Index</h1>
        </div>
        {renderContent()}
      </div>
    </div>
  );
}
