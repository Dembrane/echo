import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { lingui } from "@lingui/vite-plugin";

const ReactCompilerConfig = {};

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react({
      babel: {
        plugins: ["macros", ["babel-plugin-react-compiler"]],
      },
    }),
    lingui(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // reddit fix lol: https://www.reddit.com/r/reactjs/comments/1g3tsiy/trouble_with_vite_tablericons_5600_requests/
      "@tabler/icons-react": "@tabler/icons-react/dist/esm/icons/index.mjs",
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ["react", "react-dom", "react-router"],
          ui: ["@mantine/core", "@mantine/hooks"],
        },
      },
    },
  },
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:8001/",
        changeOrigin: true,
        rewrite: (path) => {
          console.log("Proxying request to", path);
          return path;
        },
      },
      "/directus": {
        target: "http://localhost:8055",
        changeOrigin: true,
        rewrite: (path) => {
          const newPath = path.replace(/^\/directus/, "/");
          console.log("Proxying request to", newPath);
          return newPath;
        },
      },
    },
  },
});
