import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  root: "apps/client",
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5180,
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:3001", changeOrigin: true },
      "/ws": { target: "ws://127.0.0.1:3002", ws: true, changeOrigin: true },
    },
  },
  build: { outDir: "../../dist/client", emptyOutDir: true },
});
