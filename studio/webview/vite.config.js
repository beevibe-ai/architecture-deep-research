import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const root = fileURLToPath(new URL(".", import.meta.url));

// Builds the canvas into studio/dist, which the extension host loads into a
// webview panel. base "./" keeps asset URLs relative so the host can rewrite
// them to webview URIs.
export default defineConfig({
  root,
  base: "./",
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("../dist", import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
  },
});
