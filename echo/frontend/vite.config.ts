import { lingui } from "@lingui/vite-plugin";
import react from "@vitejs/plugin-react";
import path from "path";
import { defineConfig } from "vite";

// https://vitejs.dev/config/
export default defineConfig({
	build: {
		rollupOptions: {
			output: {
				manualChunks: {
					ui: ["@mantine/core", "@mantine/hooks"],
					vendor: ["react", "react-dom", "react-router"],
				},
			},
		},
	},
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
	server: {
		proxy: {
			"/api": {
				changeOrigin: true,
				rewrite: (path) => {
					console.log("Proxying request to", path);
					return path;
				},
				target: "http://localhost:8000/",
			},
			"/directus": {
				changeOrigin: true,
				rewrite: (path) => {
					const newPath = path.replace(/^\/directus/, "/");
					console.log("Proxying request to", newPath);
					return newPath;
				},
				target: "http://localhost:8055",
			},
		},
	},
});
