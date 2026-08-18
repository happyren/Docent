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
    // Same paths nginx proxies in deployments. Run the services locally
    // with `pnpm store` and `pnpm mcp`.
    proxy: {
      "/api": "http://127.0.0.1:3400",
      "/mcp": "http://127.0.0.1:3001",
      "/bridge": "http://127.0.0.1:3001",
    },
  },
  preview: {
    port: 3000,
    proxy: {
      "/api": "http://127.0.0.1:3400",
      "/mcp": "http://127.0.0.1:3001",
      "/bridge": "http://127.0.0.1:3001",
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
