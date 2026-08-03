import { useEffect, useRef, useState } from "react";
import { getDownloadOptions, startDownload, getJobs, type DownloadOption, type DownloadJob } from "./api";

interface DownloadModalProps {
  pageUrl: string;
  movieTitle: string;
  tmdbId: string | null;
  onClose: () => void;
  onDownloadStarted: () => void;
}

type Stage = { kind: "loading" } | { kind: "quality"; options: DownloadOption[] } | { kind: "direct"; options: DownloadOption[]; parentLabel: string } | { kind: "error"; message: string };

export function DownloadModal({ pageUrl, movieTitle, tmdbId, onClose, onDownloadStarted }: DownloadModalProps) {
  const [stage, setStage] = useState<Stage>({ kind: "loading" });
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [jobStatus, setJobStatus] = useState<Record<string, string>>({});
  const pollTimer = useRef<number | null>(null);

  useEffect(() => {
    getDownloadOptions(pageUrl)
      .then((data) => setStage(data.options.length ? { kind: "quality", options: data.options } : { kind: "error", message: "No download links found on this page." }))
      .catch((err) => setStage({ kind: "error", message: err.message }));
  }, [pageUrl]);

  useEffect(() => {
    return () => {
      if (pollTimer.current) window.clearInterval(pollTimer.current);
    };
  }, []);

  function pickQuality(option: DownloadOption) {
    setStage({ kind: "loading" });
    getDownloadOptions(option.href, "direct")
      .then((data) =>
        setStage(
          data.options.length
            ? { kind: "direct", options: data.options, parentLabel: option.label }
            : { kind: "error", message: "No direct download links found." }
        )
      )
      .catch((err) => setStage({ kind: "error", message: err.message }));
    setFocusedIndex(0);
  }

  function pickDirect(option: DownloadOption) {
    setJobStatus((prev) => ({ ...prev, [option.href]: "Starting…" }));
    startDownload({ url: option.href, label: option.label, movieTitle, tmdbId })
      .then((job) => {
        setJobStatus((prev) => ({ ...prev, [option.href]: "Queued…" }));
        pollJob(job.id, option.href);
        onDownloadStarted();
      })
      .catch((err) => setJobStatus((prev) => ({ ...prev, [option.href]: "Failed: " + err.message })));
  }

  function pollJob(jobId: number, key: string) {
    if (pollTimer.current) window.clearInterval(pollTimer.current);
    pollTimer.current = window.setInterval(async () => {
      const jobs = await getJobs();
      const job = jobs.find((j: DownloadJob) => j.id === jobId);
      if (!job) return;
      if (job.status === "completed") {
        setJobStatus((prev) => ({ ...prev, [key]: "Saved" }));
        if (pollTimer.current) window.clearInterval(pollTimer.current);
      } else if (job.status === "failed") {
        setJobStatus((prev) => ({ ...prev, [key]: "Failed: " + (job.error || "unknown error") }));
        if (pollTimer.current) window.clearInterval(pollTimer.current);
      } else if (job.totalBytes > 0) {
        const pct = Math.round((job.receivedBytes / job.totalBytes) * 100);
        setJobStatus((prev) => ({ ...prev, [key]: `Downloading… ${pct}%` }));
      } else {
        setJobStatus((prev) => ({ ...prev, [key]: "Downloading…" }));
      }
    }, 1500);
  }

  const options = stage.kind === "quality" ? stage.options : stage.kind === "direct" ? stage.options : [];

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.keyCode === 10009 || e.keyCode === 27) {
        if (stage.kind === "direct") {
          setStage({ kind: "loading" });
          getDownloadOptions(pageUrl).then((data) => setStage({ kind: "quality", options: data.options }));
          setFocusedIndex(0);
        } else {
          onClose();
        }
        return;
      }
      if (!options.length) return;
      if (e.keyCode === 40) setFocusedIndex((i) => Math.min(options.length - 1, i + 1));
      else if (e.keyCode === 38) setFocusedIndex((i) => Math.max(0, i - 1));
      else if (e.keyCode === 13) {
        const option = options[focusedIndex];
        if (!option) return;
        if (stage.kind === "quality") pickQuality(option);
        else pickDirect(option);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, focusedIndex, options.length]);

  return (
    <div className="detail-overlay" style={{ padding: "60px 80px", overflowY: "auto" }}>
      <h1 className="hero-title" style={{ fontSize: 32 }}>{movieTitle}</h1>
      {stage.kind === "loading" && <p className="status" style={{ paddingLeft: 0 }}>Loading…</p>}
      {stage.kind === "error" && <p className="status" style={{ paddingLeft: 0 }}>{stage.message}</p>}
      {(stage.kind === "quality" || stage.kind === "direct") && (
        <ul style={{ listStyle: "none", padding: 0, maxWidth: 900 }}>
          {stage.kind === "direct" && <p style={{ color: "var(--muted)" }}>{stage.parentLabel}</p>}
          {options.map((option, i) => (
            <li key={option.href} style={{ marginBottom: 10 }}>
              <div
                className={"poster-card" + (i === focusedIndex ? " focused" : "")}
                style={{ width: "auto" }}
              >
                <div
                  style={{
                    padding: "14px 20px",
                    borderRadius: 8,
                    background: i === focusedIndex ? "var(--bg-elevated)" : "transparent",
                    border: i === focusedIndex ? "2px solid var(--focus-ring)" : "2px solid transparent",
                  }}
                >
                  {option.label}
                  {jobStatus[option.href] ? <span style={{ marginLeft: 12, color: "var(--muted)" }}> — {jobStatus[option.href]}</span> : null}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
