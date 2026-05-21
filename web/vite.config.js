import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root,
  base: "./",
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("./dist", import.meta.url)),
    emptyOutDir: true,
    sourcemap: false
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:4173"
    }
  }
});
