import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = process.env.API_PROXY_TARGET ?? "http://localhost:4000";

// SPA. Dev proxies /api to the server so the pm_session cookie stays first-party
// (SameSite=Lax) — no CORS/credentials dance. Production sits behind one origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: false,
        ws: true, // forward the /api/live WebSocket upgrade (live collaboration) to the server
      },
      "/mcp": {
        target: apiTarget,
        changeOrigin: false,
      },
      "/llms.txt": {
        target: apiTarget,
        changeOrigin: false,
      },
      "/.well-known": {
        target: apiTarget,
        changeOrigin: false,
      },
    },
  },
});
