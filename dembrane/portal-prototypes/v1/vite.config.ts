import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), cloudflare(), tailwindcss()],
  server: {
    // Not 5173 or 5174, the dashboard's and the portal's.
    port: 8804,
    strictPort: true,
  },
});
