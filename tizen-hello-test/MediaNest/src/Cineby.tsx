import { useEffect, useRef, useState } from "react";
import { getCinebyProxyUrl } from "./api";

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
    getCinebyProxyUrl()
      .then((url) => {
        if (cancelled) return;
        if (!url) {
          setError("Set cineby_url in the Movie Server config (or CINEBY_URL in .env) to open a page here.");
          setLoading(false);
          return;
        }
        setProxyUrl(url);
        setLoading(false);
      })
      .catch((err) => {
        if (!cancelled) {
          setError("Failed to load Cineby: " + err.message);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.data?.type === "medianest-cineby-back") onBack?.();
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
      iframeRef.current?.contentWindow?.postMessage({ type: "medianest-tv-key", keyCode: e.keyCode }, "*");
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
      />
    </div>
  );
}
