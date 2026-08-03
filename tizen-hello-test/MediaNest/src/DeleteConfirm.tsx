import { useEffect, useState } from "react";

interface DeleteConfirmProps {
  title: string;
  deleting: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

// Same modal pattern as ExitConfirm, but defaults to "Cancel" focused (not
// the destructive action) - unlike exiting the app, deleting a download
// actually loses something, so the safer option should be the default.
export function DeleteConfirm({ title, deleting, error, onCancel, onConfirm }: DeleteConfirmProps) {
  const [focusedIndex, setFocusedIndex] = useState(0); // 0 = Cancel, 1 = Delete

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (deleting) return; // ignore input while the delete request is in flight
      if (e.keyCode === 37) setFocusedIndex(0);
      else if (e.keyCode === 39) setFocusedIndex(1);
      else if (e.keyCode === 13) (focusedIndex === 0 ? onCancel : onConfirm)();
      else if (e.keyCode === 10009 || e.keyCode === 27) onCancel();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [focusedIndex, deleting, onCancel, onConfirm]);

  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-labelledby="delete-confirm-title">
        <h2 id="delete-confirm-title">Delete "{title}"?</h2>
        <p style={{ color: "var(--muted)", marginTop: -8, marginBottom: 20 }}>
          This removes the downloaded file from your library. You can download it again later.
        </p>
        {error && <p style={{ color: "#ff6b6b", marginTop: -12 }}>{error}</p>}
        <div className="modal-actions">
          <button className={focusedIndex === 0 ? "focused" : ""} onClick={onCancel} disabled={deleting}>
            Cancel
          </button>
          <button className={focusedIndex === 1 ? "focused" : ""} onClick={onConfirm} disabled={deleting}>
            {deleting ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}
