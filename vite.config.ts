import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Excalidraw's published bundle reads process.env.IS_PREACT; define it so
  // the browser build doesn't reference a bare `process`.
  define: {
    "process.env.IS_PREACT": JSON.stringify("false"),
  },
  server: {
    port: 3000,
    // Portfolio store (S12) — same path nginx proxies in deployments.
    // Run it locally with: node server/docent-store.mjs
    proxy: {
      "/api": "http://127.0.0.1:3400",
    },
  },
  preview: {
    port: 3000,
    proxy: {
      "/api": "http://127.0.0.1:3400",
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
