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
			// Single source of truth for type sizes: these mirror the Mantine
			// scale, both driven by the --app-font-size-* / --app-heading-* vars
			// set in useAppPreferences.tsx. Keep Tailwind and Mantine in lockstep
			// so text-sm here == size="sm" there. Body3 12 / Body2 15 / Body1 20
			// (base) / H3 24 / H2 28 / H1 32 / Title 36. 4xl+ keep Tailwind's
			// display defaults (this merges via `extend`).
			fontSize: {
				xs: ["var(--app-font-size-xs)", { lineHeight: "var(--app-line-height-xs)" }],
				sm: ["var(--app-font-size-sm)", { lineHeight: "var(--app-line-height-sm)" }],
				base: ["var(--app-font-size-md)", { lineHeight: "var(--app-line-height-md)" }],
				lg: ["var(--app-font-size-lg)", { lineHeight: "var(--app-line-height-lg)" }],
				xl: ["var(--app-font-size-xl)", { lineHeight: "var(--app-line-height-xl)" }],
				"2xl": [
					"var(--app-heading-h2-size)",
					{ lineHeight: "var(--app-heading-h2-line-height)" },
				],
				"3xl": [
					"var(--app-heading-h1-size)",
					{ lineHeight: "var(--app-heading-h1-line-height)" },
				],
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
