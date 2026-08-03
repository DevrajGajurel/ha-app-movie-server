import { useEffect, useState } from "react";
import { getCinebyProxyUrl } from "./api";

interface CinebyProps {
  onBack?: () => void;
}

// Loads Cineby through the movie-server proxy (strips CSP frame-ancestors /
// X-Frame-Options and injects a D-pad virtual cursor). Direct iframes are
// blocked by cineby.*; top-level navigation leaves MediaNest with no
// remote handling. Back is posted from the injected cursor script.
export function Cineby({ onBack }: CinebyProps) {
  const [proxyUrl, setProxyUrl] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

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

  if (loading) {
    return (
      <div className="cineby-view">
        <p className="status" style={{ paddingLeft: 0 }}>Loading…</p>
      </div>
    );
  }

  if (error || !proxyUrl) {
    return (
      <div className="cineby-view">
        <h1 className="hero-title" style={{ fontSize: 32 }}>Cineby</h1>
        <p className="status" style={{ paddingLeft: 0 }}>{error || "Cineby URL not configured."}</p>
      </div>
    );
  }

  return (
    <div className="cineby-view cineby-view-frame">
      <iframe className="cineby-frame" src={proxyUrl} title="Cineby" allow="fullscreen; autoplay" />
    </div>
  );
}
