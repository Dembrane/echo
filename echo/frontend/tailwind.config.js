import typography from "@tailwindcss/typography";
import { tailwindColors } from "./src/colors";

/** @type {import('tailwindcss').Config} */
export default {
	content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
	plugins: [typography],
	theme: {
		extend: {
			colors: {
				...tailwindColors,
				// Legacy aliases (kept for backward compatibility)
				blue: tailwindColors.primary,
			},
			fontFamily: {
				sans: ["var(--app-font-family)", "'DM Sans Variable'", "sans-serif"],
			},
			height: {
				"base-layout-height": "var(--base-layout-height, calc(100% - 60px))",
				"project-layout-height": "var(--project-layout-height, calc(100vh - 60px))",
			},
			screens: {
				xs: "320px",
			},
			spacing: {
				"base-layout-padding": "var(--base-layout-padding, 60px)",
			},
		},
	},
};
