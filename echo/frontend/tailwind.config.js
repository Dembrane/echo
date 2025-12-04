import typography from "@tailwindcss/typography";

/** @type {import('tailwindcss').Config} */
export default {
	content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
	plugins: [typography],
	theme: {
		extend: {
			colors: {
				// from mantine primary
				//   [
				// "#e2f6ff",
				// "#cbe9ff",
				// "#99cfff",
				// "#62b5ff",
				// "#369eff",
				// "#1890ff",
				// "#0089ff",
				// "#0076e5",
				// "#0069ce",
				// "#005ab7",
				// ]
				// Royal blue based palette (matching Mantine theme)
				primary: {
					50: "#eef2fc",
					100: "#dce4f9",
					200: "#b9c9f3",
					300: "#96aeec",
					400: "#6d8be5",
					500: "#4169E1", // royal blue
					600: "#3a5eca",
					700: "#3354b3",
					800: "#2c499c",
					900: "#253f85",
				},
				blue: {
					50: "#eef2fc",
					100: "#dce4f9",
					200: "#b9c9f3",
					300: "#96aeec",
					400: "#6d8be5",
					500: "#4169E1", // royal blue
					600: "#3a5eca",
					700: "#3354b3",
					800: "#2c499c",
					900: "#253f85",
				},
				parchment: "#F6F4F1",
				graphite: "#2D2D2C",
			},
			fontFamily: "'Space Grotesk', sans-serif",
			height: {
				"base-layout-height": "var(--base-layout-height, calc(100% - 60px))",
				"project-layout-height":
					"var(--project-layout-height, calc(100vh - 60px))",
			},
			screens: {
				// => @media (min-width: 1280px) { ... }
				"2xl": "1536px",
				// => @media (min-width: 768px) { ... }
				lg: "1024px",
				// => @media (min-width: 640px) { ... }
				md: "768px",
				sm: "640px",
				// => @media (min-width: 1024px) { ... }
				xl: "1280px",
				xs: "320px",
				// => @media (min-width: 1536px) { ... }
			},
			spacing: {
				"base-layout-padding": "var(--base-layout-padding, 60px)",
			},
		},
	},
};
