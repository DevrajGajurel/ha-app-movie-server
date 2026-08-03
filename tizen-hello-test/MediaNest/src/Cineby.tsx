import { useEffect, useState } from "react";
import { openCinebyUrl } from "./api";

// Setup / error screen only. Opening the configured URL is done from
// Home (sidebar Enter/click) via openCinebyUrl() so we don't depend on
// an iframe — cineby.at/tech both send X-Frame-Options: DENY.
export function Cineby() {
  const [status, setStatus] = useState("Opening…");

  useEffect(() => {
    let cancelled = false;
    openCinebyUrl()
      .then((opened) => {
        if (cancelled) return;
        if (!opened) {
          setStatus(
            'Set cineby_url in the Movie Server config (or CINEBY_URL in .env) to open a page here.',
          );
        }
      })
      .catch((err) => {
        if (!cancelled) setStatus("Failed to load Cineby URL: " + err.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="cineby-view">
      <h1 className="hero-title" style={{ fontSize: 32 }}>Cineby</h1>
      <p className="status" style={{ paddingLeft: 0 }}>{status}</p>
    </div>
  );
}
