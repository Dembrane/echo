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
	// Neutral: graphite over parchment. Shade 1 is the quiet grey (hairlines,
	// hover), 6 is muted text (cool slate, AA on parchment, white and hover).
	gray: [
		"#f1efec",
		"#e6e3df",
		"#dcdad7",
		"#c6c4c2",
		"#aeacaa",
		"#878785",
		"#5f646f",
		"#5d5d5b",
		"#4b4b4a",
		"#2d2d2c",
	],
	green: [
		"#effcf6",
		"#c6f6df",
		"#9cf5cb",
		"#1effa1",
		"#2fae78",
		"#1b8a5b",
		"#0e6e47",
		"#0b5d3c",
		"#084c31",
		"#063a25",
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
	// Status ramps. Shades 6 and 7 (text and fills) pass AA on parchment;
	// shades 1 and 3 are the brand tints (cotton candy, golden pollen, spring green).
	red: [
		"#fdf2f3",
		"#f9dbdb",
		"#f5c4c7",
		"#ff9aa2",
		"#d9646e",
		"#c04a55",
		"#c0434e",
		"#b43a45",
		"#7a232b",
		"#5f1b21",
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
	yellow: [
		"#fffbef",
		"#f9e7bc",
		"#ffe09a",
		"#ffd166",
		"#c89a2c",
		"#9a7210",
		"#7a5200",
		"#6b4800",
		"#5a3c00",
		"#432d00",
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
export const mantineColors: Record<string, MantineColorTuple> = {
	...(brandColors as Record<string, MantineColorTuple>),
	// The Mantine names the app passes land on the brand ramps.
	blue: brandColors.primary,
	// Mantine draws its dark scheme from this ramp (text 0, dimmed 2,
	// placeholder 3, borders 4, hover 5, inputs 6, body 7): the AMOLED roles.
	dark: [
		"#f6f4f1",
		"#d6d4d0",
		"#b5b3af",
		"#8f8d89",
		"#333332",
		"#262625",
		"#161615",
		"#000000",
		"#000000",
		"#000000",
	],
	orange: brandColors.yellow,
	teal: brandColors.green,
};

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
	// Tailwind's gray and slate utilities land on the brand neutral.
	gray: toTailwindPalette(brandColors.gray),
	green: toTailwindPalette(brandColors.green),
	institutionBlue: toTailwindPalette(brandColors.institutionBlue),
	limeYellow: toTailwindPalette(brandColors.limeYellow),
	mauve: toTailwindPalette(brandColors.mauve),
	parchment: toTailwindPalette(brandColors.parchment),
	peach: toTailwindPalette(brandColors.peach),
	primary: toTailwindPalette(brandColors.primary),
	red: toTailwindPalette(brandColors.red),
	salmon: toTailwindPalette(brandColors.salmon),
	slate: toTailwindPalette(brandColors.gray),
	springGreen: toTailwindPalette(brandColors.springGreen),
	yellow: toTailwindPalette(brandColors.yellow),
};

export const stateColors = {
	errorBorder: "#c0434e",
	errorMark: "#c0434e",
	errorSurface: "#f9dbdb",
} as const;

/**
 * Roles. Contrast on parchment (WCAG 2.2): text 12.56, muted 5.41 (4.64 on
 * the quiet hover grey), action 5.43, danger 4.60 (on its tint use dangerOnTint,
 * 5.08), warning 6.30, success 5.73.
 *
 * A fill is the colour a filled Button or a checked control paints; in light it
 * equals its text role. Every filled thing hovers to graphite (fillHover).
 */
export const lightRoles = {
	action: "#2957df",
	actionFill: "#2957df",
	actionTint: "#e9f1ff",
	bg: "#f6f4f1",
	control: "#878785",
	danger: "#c0434e",
	dangerFill: "#c0434e",
	dangerOnTint: "#a8323c",
	dangerTint: "#f9dbdb",
	fillHover: "#2d2d2c",
	muted: "#5f646f",
	onFill: "#ffffff",
	onFillHover: "#ffffff",
	pressed: "#dcdad7",
	quiet: "#e6e3df",
	success: "#0e6e47",
	successFill: "#0e6e47",
	successTint: "#c6f6df",
	surface: "#ffffff",
	text: "#2d2d2c",
	warning: "#7a5200",
	warningFill: "#7a5200",
	warningTint: "#f9e7bc",
} as const;

/**
 * AMOLED dark (October 2026): a true black ground, warmth in the raised
 * surface and the parchment ink. Fills keep their light colours under
 * parchment text; as text, action and the statuses lighten (brand blue is
 * 3.5:1 on black). The filled hover inverts to parchment with black text.
 */
export const darkRoles: Record<keyof typeof lightRoles, string> = {
	action: "#7c9bff",
	actionFill: "#2957df",
	actionTint: "#1a2140",
	bg: "#000000",
	control: "#7d7b78",
	danger: "#f58a93",
	dangerFill: "#c0434e",
	dangerOnTint: "#ffb3b9",
	dangerTint: "#3d1f23",
	fillHover: "#f6f4f1",
	muted: "#b5b3af",
	onFill: "#f6f4f1",
	onFillHover: "#000000",
	pressed: "#333332",
	quiet: "#262625",
	success: "#4fcf97",
	successFill: "#0e6e47",
	successTint: "#14301f",
	surface: "#161615",
	text: "#f6f4f1",
	warning: "#e9bd5c",
	warningFill: "#7a5200",
	warningTint: "#332a16",
};

/** Tag tints: accent colours as surfaces, always with the text colour. */
export const lightTagTints = {
	amber: "#f9e7bc",
	blue: "#e9f1ff",
	coral: "#f9dbdb",
	cyan: "#c0f6f4",
	green: "#c6f6df",
	lime: "#f5fab3",
	mauve: "#fadef7",
	neutral: "#e6e3df",
} as const;

export const darkTagTints: Record<keyof typeof lightTagTints, string> = {
	amber: "#332a16",
	blue: "#1a2140",
	coral: "#3d1f23",
	cyan: "#123030",
	green: "#14301f",
	lime: "#2c2f18",
	mauve: "#352833",
	neutral: "#262625",
};

// The CSS variable each role is drawn from. rules.css and index.css already
// name the page ground --app-background and the field line --app-control-rule.
const roleVarName = (role: string) =>
	role === "bg"
		? "--app-background"
		: role === "control"
			? "--app-control-rule"
			: `--app-${role.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
const tagVarName = (tint: string) => `--app-tag-${tint}`;

const toVars = <K extends string>(
	values: Record<K, string>,
	name: (key: string) => string,
): Record<string, string> =>
	Object.fromEntries(
		Object.entries(values).map(([key, value]) => [name(key), value as string]),
	);

/** The role variables per scheme, for the theme's cssVariablesResolver. */
export const lightRoleVars = {
	...toVars(lightRoles, roleVarName),
	...toVars(lightTagTints, tagVarName),
};
export const darkRoleVars = {
	...toVars(darkRoles, roleVarName),
	...toVars(darkTagTints, tagVarName),
};

const toRefs = <K extends string>(
	values: Record<K, string>,
	name: (key: string) => string,
) =>
	Object.fromEntries(
		Object.keys(values).map((key) => [key, `var(${name(key)})`]),
	) as Record<K, string>;

/**
 * Roles as CSS variables, so whatever draws them follows the colour scheme.
 * Where a canvas needs a real colour (a QR code), use lightRoles.
 */
export const roles = toRefs(lightRoles, roleVarName);
export const tagTints = toRefs(lightTagTints, tagVarName);

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
