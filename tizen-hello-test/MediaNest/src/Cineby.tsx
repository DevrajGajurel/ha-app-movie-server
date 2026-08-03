import { useEffect, useState } from "react";
import { getConfig } from "./api";

// Sites like cineby.tech set CSP frame-ancestors 'none', which blocks iframes
// in every browser. Loading as a top-level navigation (not a frame) is the
// only reliable approach — remote Back returns here via history.
export function Cineby() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    getConfig()
      .then((config) => {
        if (cancelled) return;
        const next = (config.cinebyUrl || "").trim();
        if (!next) {
          setUrl("");
          setLoading(false);
          return;
        }
        setUrl(next);
        window.location.assign(next);
      })
      .catch((err) => {
        if (!cancelled) {
          setError("Failed to load Cineby URL: " + err.message);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="cineby-view">
        <p className="status" style={{ paddingLeft: 0 }}>{error}</p>
      </div>
    );
  }

  if (loading || url) {
    return (
      <div className="cineby-view">
        <h1 className="hero-title" style={{ fontSize: 32 }}>Cineby</h1>
        <p className="status" style={{ paddingLeft: 0 }}>{url ? "Opening…" : "Loading…"}</p>
      </div>
    );
  }

  return (
    <div className="cineby-view">
      <h1 className="hero-title" style={{ fontSize: 32 }}>Cineby</h1>
      <p className="status" style={{ paddingLeft: 0 }}>
        Set <code>cineby_url</code> in the Movie Server config (or <code>CINEBY_URL</code> in .env) to open a page here.
      </p>
    </div>
  );
}
