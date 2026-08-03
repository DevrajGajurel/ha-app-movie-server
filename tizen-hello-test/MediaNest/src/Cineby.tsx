import { useEffect, useRef, useState } from "react";
import { getCinebyProxyUrl, reportClientError } from "./api";

interface CinebyProps {
  onBack?: () => void;
  active?: boolean;
}

// Loads Cineby inside MediaNest via the movie-server proxy (strips CSP /
// X-Frame-Options, injects a D-pad cursor). Sandboxed without
// allow-top-navigation so Cineby cannot replace the MediaNest widget.
export function Cineby({ onBack, active = true }: CinebyProps) {
  const [proxyUrl, setProxyUrl] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    reportClientError("cineby", "opening Cineby view");
    getCinebyProxyUrl()
      .then((url) => {
        if (cancelled) return;
        if (!url) {
          const message = "Set cineby_url in the Movie Server config (or CINEBY_URL in .env) to open a page here.";
          setError(message);
          setLoading(false);
          reportClientError("cineby", "cinebyUrl not configured");
          return;
        }
        reportClientError("cineby", "proxy url ready", { proxyUrl: url });
        setProxyUrl(url);
        setLoading(false);
      })
      .catch((err) => {
        if (!cancelled) {
          const message = "Failed to load Cineby: " + err.message;
          setError(message);
          setLoading(false);
          reportClientError("cineby", message, { stack: err?.stack || null });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.data?.type === "medianest-cineby-back") {
        reportClientError("cineby", "back from iframe postMessage");
        onBack?.();
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onBack]);

  // Tizen delivers remote keys to the MediaNest document, not the iframe.
  // Forward D-pad + OK into the proxied page's virtual cursor.
  useEffect(() => {
    if (!active || !proxyUrl) return;
    function onKeyDown(e: KeyboardEvent) {
      if (![37, 38, 39, 40, 13].includes(e.keyCode)) return;
      e.preventDefault();
      e.stopPropagation();
      try {
        iframeRef.current?.contentWindow?.postMessage({ type: "medianest-tv-key", keyCode: e.keyCode }, "*");
      } catch (err) {
        reportClientError("cineby", "failed to forward remote key", {
          keyCode: e.keyCode,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [active, proxyUrl]);

  if (loading) {
    return (
      <div className="cineby-view">
        <div className="cineby-chrome">
          <span className="cineby-chrome-title">MediaNest · Cineby</span>
          <span className="cineby-chrome-hint">Loading…</span>
        </div>
      </div>
    );
  }

  if (error || !proxyUrl) {
    return (
      <div className="cineby-view">
        <div className="cineby-chrome">
          <span className="cineby-chrome-title">MediaNest · Cineby</span>
        </div>
        <p className="status" style={{ paddingLeft: 24 }}>{error || "Cineby URL not configured."}</p>
      </div>
    );
  }

  return (
    <div className="cineby-view cineby-view-frame">
      <div className="cineby-chrome">
        <span className="cineby-chrome-title">MediaNest · Cineby</span>
        <span className="cineby-chrome-hint">Back leaves · arrows move cursor · OK selects</span>
      </div>
      <iframe
        ref={iframeRef}
        className="cineby-frame"
        src={proxyUrl}
        title="Cineby"
        // No allow-top-navigation: Cineby must not replace MediaNest.
        sandbox="allow-scripts allow-same-origin allow-forms allow-presentation"
        allow="fullscreen; autoplay"
        onLoad={() => reportClientError("cineby", "iframe load fired", { proxyUrl })}
        onError={() => reportClientError("cineby", "iframe error event", { proxyUrl })}
      />
    </div>
  );
}
