import { useEffect, useRef, useState } from "react";
import { getJobs, redownloadJob, cancelJob, type DownloadJob } from "./api";

interface DownloadsProps {
  active: boolean;
  onLeaveToSidebar: () => void;
}

function formatStatus(job: DownloadJob): string {
  if (job.status === "queued") return "Queued…";
  if (job.status === "downloading") {
    if (job.totalBytes > 0) return `Downloading… ${Math.round((job.receivedBytes / job.totalBytes) * 100)}%`;
    return "Downloading…";
  }
  if (job.status === "completed") return "Saved";
  if (job.status === "failed") return `Failed: ${job.error || "unknown error"}`;
  return job.status;
}

export function Downloads({ active, onLeaveToSidebar }: DownloadsProps) {
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [redownloading, setRedownloading] = useState<Set<number>>(new Set());
  const [cancelling, setCancelling] = useState<Set<number>>(new Set());
  const [focusedIndex, setFocusedIndex] = useState(0);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    let cancelled = false;
    function poll() {
      getJobs().then((j) => {
        if (!cancelled) setJobs(j);
      });
    }
    poll();
    const timer = window.setInterval(poll, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    setFocusedIndex((i) => (jobs.length ? Math.min(i, jobs.length - 1) : 0));
  }, [jobs.length]);

  useEffect(() => {
    if (!active || !jobs.length) return;
    itemRefs.current[focusedIndex]?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [focusedIndex, active, jobs.length]);

  async function handleRedownload(jobId: number) {
    setRedownloading((prev) => new Set(prev).add(jobId));
    try {
      await redownloadJob(jobId);
      getJobs().then(setJobs);
    } catch {
      // Surfaced implicitly - the job list just won't show a new queued entry.
    } finally {
      setRedownloading((prev) => {
        const next = new Set(prev);
        next.delete(jobId);
        return next;
      });
    }
  }

  async function handleCancel(jobId: number) {
    setCancelling((prev) => new Set(prev).add(jobId));
    try {
      await cancelJob(jobId);
      getJobs().then(setJobs);
    } catch {
      // Surfaced implicitly - the job just keeps showing its current status.
    } finally {
      setCancelling((prev) => {
        const next = new Set(prev);
        next.delete(jobId);
        return next;
      });
    }
  }

  useEffect(() => {
    if (!active) return;
    function onKeyDown(e: KeyboardEvent) {
      if (!jobs.length) {
        if (e.keyCode === 37) onLeaveToSidebar();
        return;
      }
      switch (e.keyCode) {
        case 37: // Left - single-column list, always back to sidebar
          onLeaveToSidebar();
          break;
        case 38: // Up
          setFocusedIndex((i) => Math.max(0, i - 1));
          break;
        case 40: // Down
          setFocusedIndex((i) => Math.min(jobs.length - 1, i + 1));
          break;
        case 13: { // Enter/OK
          const job = jobs[focusedIndex];
          if (!job) break;
          if ((job.status === "completed" || job.status === "failed") && !redownloading.has(job.id)) {
            handleRedownload(job.id);
          } else if ((job.status === "queued" || job.status === "downloading") && !cancelling.has(job.id)) {
            handleCancel(job.id);
          }
          break;
        }
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, jobs, focusedIndex, redownloading, cancelling, onLeaveToSidebar]);

  return (
    <div className="rows" style={{ marginTop: 0, paddingTop: 48 }}>
      <h1 className="hero-title" style={{ fontSize: 32 }}>Downloads</h1>
      {!jobs.length ? <p className="status" style={{ paddingLeft: 0 }}>No downloads yet.</p> : null}
      {jobs.map((job, i) => (
        <div
          key={job.id}
          ref={(el) => {
            itemRefs.current[i] = el;
          }}
          className={"download-row" + (active && i === focusedIndex ? " focused" : "")}
        >
          <div style={{ fontWeight: 600 }}>{job.movieTitle}</div>
          <div style={{ color: "var(--muted)", fontSize: 15 }}>{job.label} — {formatStatus(job)}</div>
          {job.status === "downloading" && job.totalBytes > 0 ? (
            <div className="player-progress-track" style={{ marginTop: 6, height: 4 }}>
              <div className="player-progress-fill" style={{ width: `${Math.round((job.receivedBytes / job.totalBytes) * 100)}%` }} />
            </div>
          ) : null}
          {job.status === "completed" || job.status === "failed" ? (
            <button
              type="button"
              className="redownload-btn"
              disabled={redownloading.has(job.id)}
              onClick={() => handleRedownload(job.id)}
            >
              {redownloading.has(job.id) ? "Starting…" : "Redownload"}
            </button>
          ) : null}
          {job.status === "queued" || job.status === "downloading" ? (
            <button
              type="button"
              className="redownload-btn"
              disabled={cancelling.has(job.id)}
              onClick={() => handleCancel(job.id)}
            >
              {cancelling.has(job.id) ? "Cancelling…" : "Cancel"}
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
