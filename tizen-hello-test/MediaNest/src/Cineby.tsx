import { useEffect, useState } from "react";
import { getConfig } from "./api";

export function Cineby() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    getConfig()
      .then((config) => {
        if (cancelled) return;
        setUrl((config.cinebyUrl || "").trim());
        setLoading(false);
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

  if (loading) {
    return (
      <div className="cineby-view">
        <p className="status" style={{ paddingLeft: 0 }}>Loading…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="cineby-view">
        <p className="status" style={{ paddingLeft: 0 }}>{error}</p>
      </div>
    );
  }

  if (!url) {
    return (
      <div className="cineby-view">
        <h1 className="hero-title" style={{ fontSize: 32 }}>Cineby</h1>
        <p className="status" style={{ paddingLeft: 0 }}>
          Set <code>cineby_url</code> in the Movie Server config (or <code>CINEBY_URL</code> in .env) to load a page here.
        </p>
      </div>
    );
  }

  return (
    <div className="cineby-view cineby-view-frame">
      <iframe className="cineby-frame" src={url} title="Cineby" allow="fullscreen; autoplay" />
    </div>
  );
}
