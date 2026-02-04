/**
 * Brand Color Palettes
 * Single source of truth for colors used in both Mantine and Tailwind
 *
 * Mantine uses 10-shade arrays (index 0-9, base at index 6)
 * Tailwind uses object with keys 50-900 (base at 500)
 */

// Mantine-style color arrays (10 shades, base at index 6)
export const brandColors = {
	// Cyan (base: #00FFFF)
	cyan: [
		"#f0ffff",
		"#e5ffff",
		"#ccffff",
		"#99ffff",
		"#66ffff",
		"#33ffff",
		"#00FFFF", // base at position 6
		"#00e6e6",
		"#00cccc",
		"#00b3b3",
	],
	// Graphite (solid - same across all shades)
	graphite: [
		"#2D2D2C",
		"#2D2D2C",
		"#2D2D2C",
		"#2D2D2C",
		"#2D2D2C",
		"#2D2D2C",
		"#2D2D2C",
		"#2D2D2C",
		"#2D2D2C",
		"#2D2D2C",
	],
	// Institution Blue (alias for primary)
	institutionBlue: [
		"#f0f5ff",
		"#e9f1ff",
		"#d4dffe",
		"#a8bbf4",
		"#7996eb",
		"#5176e4",
		"#4169e1", // base at position 6
		"#2957df",
		"#1a48c6",
		"#1040b2",
	],
	// Lime Yellow (base: #F4FF81)
	limeYellow: [
		"#fefff5",
		"#fdfff0",
		"#fbffe1",
		"#f8ffc3",
		"#f6ffa5",
		"#f5ff93",
		"#F4FF81", // base at position 6
		"#dce674",
		"#c4cc67",
		"#acb35a",
	],
	// Mauve (base: #FFC2FF)
	mauve: [
		"#fffaff",
		"#fff5ff",
		"#ffe8ff",
		"#ffd6ff",
		"#ffc8ff",
		"#ffc5ff",
		"#FFC2FF", // base at position 6
		"#e6aee6",
		"#cc9acc",
		"#b386b3",
	],
	// Parchment (solid - same across all shades)
	parchment: [
		"#F6F4F1",
		"#F6F4F1",
		"#F6F4F1",
		"#F6F4F1",
		"#F6F4F1",
		"#F6F4F1",
		"#F6F4F1",
		"#F6F4F1",
		"#F6F4F1",
		"#F6F4F1",
	],
	// Peach (base: #FFD166)
	peach: [
		"#fffcf5",
		"#fff8ec",
		"#fff1d9",
		"#ffe3b3",
		"#ffd68c",
		"#ffc866",
		"#FFD166", // base at position 6
		"#e6bc5c",
		"#cca752",
		"#b39248",
	],
	// Primary / Institution Blue (base: #4169E1)
	primary: [
		"#f0f5ff",
		"#e9f1ff",
		"#d4dffe",
		"#a8bbf4",
		"#7996eb",
		"#5176e4",
		"#4169e1", // base at position 6
		"#2957df",
		"#1a48c6",
		"#1040b2",
	],
	// Salmon (base: #FF9AA2)
	salmon: [
		"#fffafc",
		"#fff5f6",
		"#ffebec",
		"#ffd7da",
		"#ffc3c7",
		"#ffafb5",
		"#FF9AA2", // base at position 6
		"#e68b92",
		"#cc7c82",
		"#b36d72",
	],
	// Spring Green (base: #1EFFA1)
	springGreen: [
		"#f0fffb",
		"#e8fff5",
		"#d1ffeb",
		"#a3ffd7",
		"#75ffc3",
		"#47ffaf",
		"#1EFFA1", // base at position 6
		"#1be691",
		"#18cc81",
		"#15b371",
	],
} as const;

// Type for Mantine color tuple (10 shades)
export type MantineColorTuple = readonly [
	string,
	string,
	string,
	string,
	string,
	string,
	string,
	string,
	string,
	string,
];

// Mantine-compatible colors export
export const mantineColors: Record<string, MantineColorTuple> =
	brandColors as Record<string, MantineColorTuple>;

/**
 * Helper to convert Mantine array (10 shades) to Tailwind object (50-900 keys)
 */
function toTailwindPalette(
	colors: readonly string[],
): Record<string | number, string> {
	const tailwindKeys = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900];
	const palette: Record<string | number, string> = {};

	colors.forEach((color, index) => {
		if (index < tailwindKeys.length) {
			palette[tailwindKeys[index]] = color;
		}
	});

	// Add DEFAULT as the base color (index 6 = key 500 in Tailwind)
	palette.DEFAULT = colors[6];

	return palette;
}

// Tailwind-compatible colors export
export const tailwindColors = {
	cyan: toTailwindPalette(brandColors.cyan),
	graphite: toTailwindPalette(brandColors.graphite),
	institutionBlue: toTailwindPalette(brandColors.institutionBlue),
	limeYellow: toTailwindPalette(brandColors.limeYellow),
	mauve: toTailwindPalette(brandColors.mauve),
	parchment: toTailwindPalette(brandColors.parchment),
	peach: toTailwindPalette(brandColors.peach),
	primary: toTailwindPalette(brandColors.primary),
	salmon: toTailwindPalette(brandColors.salmon),
	springGreen: toTailwindPalette(brandColors.springGreen),
};

// Base color values for quick access (e.g., in CSS-in-JS or inline styles)
export const baseColors = {
	cyan: "#00FFFF",
	graphite: "#2D2D2C",
	institutionBlue: "#4169E1",
	limeYellow: "#F4FF81",
	mauve: "#FFC2FF",
	parchment: "#F6F4F1",
	peach: "#FFD166",
	primary: "#4169E1",
	salmon: "#FF9AA2",
	springGreen: "#1EFFA1",
} as const;
