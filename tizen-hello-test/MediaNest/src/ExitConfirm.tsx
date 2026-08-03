import { useEffect, useState } from "react";

interface ExitConfirmProps {
  onCancel: () => void;
}

// Matches HelloTV's exit-confirm-modal: Back on the top-level browse
// screen (nothing else open) asks before quitting, so an accidental extra
// Back press doesn't kick the user out of the app.
export function ExitConfirm({ onCancel }: ExitConfirmProps) {
  // Matches HelloTV exactly: defaults to "Exit App" focused, not Cancel.
  const [focusedIndex, setFocusedIndex] = useState(1); // 0 = Cancel, 1 = Exit

  function exitApp() {
    try {
      window.tizen?.application.getCurrentApplication().exit();
    } catch {
      // Dev/browser fallback: nothing meaningful to do outside Tizen.
      console.info("[exit] exit requested (no-op outside Tizen)");
    }
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.keyCode === 37) setFocusedIndex(0);
      else if (e.keyCode === 39) setFocusedIndex(1);
      else if (e.keyCode === 13) (focusedIndex === 0 ? onCancel : exitApp)();
      else if (e.keyCode === 10009 || e.keyCode === 27) onCancel();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [focusedIndex, onCancel]);

  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-labelledby="exit-confirm-title">
        <h2 id="exit-confirm-title">Exit Movie Server?</h2>
        <div className="modal-actions">
          <button className={focusedIndex === 0 ? "focused" : ""} onClick={onCancel}>
            Cancel
          </button>
          <button className={focusedIndex === 1 ? "focused" : ""} onClick={exitApp}>
            Exit App
          </button>
        </div>
      </div>
    </div>
  );
}
