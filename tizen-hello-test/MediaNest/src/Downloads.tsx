import { useEffect, useState } from "react";
import { getJobs, redownloadJob, type DownloadJob } from "./api";

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

export function Downloads() {
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [redownloading, setRedownloading] = useState<Set<number>>(new Set());

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

  return (
    <div className="rows" style={{ marginTop: 0, paddingTop: 48 }}>
      <h1 className="hero-title" style={{ fontSize: 32 }}>Downloads</h1>
      {!jobs.length ? <p className="status" style={{ paddingLeft: 0 }}>No downloads yet.</p> : null}
      {jobs.map((job) => (
        <div key={job.id} style={{ marginBottom: 14, maxWidth: 800 }}>
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
        </div>
      ))}
    </div>
  );
}
