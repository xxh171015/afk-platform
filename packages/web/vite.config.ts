import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The page only listens on this machine: no login, one person (docs/specs/m1-platform.md「页面」).
export default defineConfig({
  plugins: [react()],
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  preview: { host: "127.0.0.1", port: 4173, strictPort: true },
});
