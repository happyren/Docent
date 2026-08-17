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
  },
  preview: {
    port: 3000,
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
