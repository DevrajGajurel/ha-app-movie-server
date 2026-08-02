import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";

// tizenhwkey is Samsung's own back-button event on top of (sometimes
// instead of) a normal keydown - handled once here at the app root so
// every screen gets consistent Back behavior without wiring it per-screen.
document.addEventListener("tizenhwkey", (e: Event) => {
  const key = (e as CustomEvent & { keyName?: string }).keyName;
  if (key === "back") {
    document.dispatchEvent(new KeyboardEvent("keydown", { keyCode: 10009 } as KeyboardEventInit));
  }
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
