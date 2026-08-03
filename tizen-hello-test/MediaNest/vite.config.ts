import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tizen loads the packaged app straight off the local filesystem (no web
// server), so every asset reference must be a relative path - base: "./"
// is the difference between this working on-device and every script/CSS
// request 404ing because it resolved against "/" (the device's actual
// filesystem root) instead of the app's own install directory.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist",
    target: "es2019", // Tizen 6.5's WebKit doesn't support the newest syntax
  },
});
