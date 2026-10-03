#!/usr/bin/env node
// Checks the WCAG 2.x contrast of every colour pair the design system draws, from the
// tokens alone (no browser). The roles and tag tints come from src/colors.ts; the few
// fixed hexes rules.css uses are listed below.
//
//   node scripts/check-contrast.mjs          table, exit 1 when a required pair fails
//   node scripts/check-contrast.mjs --json   machine output
//
// Text needs 4.5:1. Large text (24px and up) and the edges of controls and graphics
// need 3:1. Pairs marked "advisory" are reported with their ratio but never fail: either
// the theme never draws them (tags always carry graphite text) or they are decorative
// (the faint rule).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inCI = Boolean(process.env.GITHUB_ACTIONS);

// colors.ts is TypeScript; transpile it and import the result.
const source = readFileSync(path.join(root, "src/colors.ts"), "utf8");
const js = ts.transpileModule(source, {
	compilerOptions: {
		module: ts.ModuleKind.ESNext,
		target: ts.ScriptTarget.ES2020,
	},
}).outputText;
const { roles, tagTints } = await import(
	`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`
);

// Fixed hexes from src/styles/rules.css.
const WHITE = "#ffffff";
const FIELD_LINE = "#878785"; // --app-control-rule: fields, switches, checkboxes, radios
const FAINT_RULE = "#e6e3df"; // --app-rule-color: cards, tables, dividers

const TEXT = 4.5;
const LARGE = 3;
const LINE = 3;

/** [foreground, background, minimum, where it is drawn, advisory?] */
const pairs = [];
const add = (fgName, fg, bgName, bg, min, where, advisory = false) =>
	pairs.push({ advisory, bg, bgName, fg, fgName, min, where });

// Text and muted text on the surfaces text sits on.
const surfaces = [
	["bg", roles.bg, "the page (parchment)"],
	["surface", roles.surface, "fields, menus, dialogs, a hovered .app-do card"],
	[
		"quiet",
		roles.quiet,
		"hover rows, menu items, tabs, accordions; the neutral tag",
	],
	[
		"actionTint",
		roles.actionTint,
		"a selected .app-do card, a checked chip, the active segment",
	],
];
for (const [name, hex, where] of surfaces) {
	add("text", roles.text, name, hex, TEXT, `body text on ${where}`);
	add("muted", roles.muted, name, hex, TEXT, `c="dimmed" on ${where}`);
	add(
		"action",
		roles.action,
		name,
		hex,
		TEXT,
		`links, subtle and outline buttons, active tab on ${where}`,
	);
}
add(
	"danger",
	roles.danger,
	"bg",
	roles.bg,
	TEXT,
	"error text, red subtle buttons, the field error on the page",
);
add(
	"danger",
	roles.danger,
	"surface",
	roles.surface,
	TEXT,
	"error text in dialogs and cards",
);
// A red menu item darkens to the on-tint red on hover (rules.css,
// .mantine-Menu-item[style*="color-red"]).
add(
	"dangerOnTint",
	roles.dangerOnTint,
	"quiet",
	roles.quiet,
	TEXT,
	"a red menu item (Delete) while hovered",
);
// Subtle and outline variants hover to the tint, and the text takes the on-tint colour
// (theme.tsx variantColorResolver: hover tint, hoverColor onTint).
add(
	"dangerOnTint",
	roles.dangerOnTint,
	"dangerTint",
	roles.dangerTint,
	TEXT,
	"a red subtle/outline Button while hovered (hover: tint, hoverColor: onTint)",
);
add(
	"warning",
	roles.warning,
	"warningTint",
	roles.warningTint,
	TEXT,
	"yellow subtle/outline Button hovered; light Alert/Badge text on its tint",
);
add(
	"success",
	roles.success,
	"successTint",
	roles.successTint,
	TEXT,
	"green subtle/outline Button hovered; light Alert/Badge text on its tint",
);
add("warning", roles.warning, "bg", roles.bg, TEXT, "warning text on the page");
add(
	"success",
	roles.success,
	"bg",
	roles.bg,
	TEXT,
	"success text on the page, the success toast icon",
);
// Light variant: onTint on tint.
add(
	"dangerOnTint",
	roles.dangerOnTint,
	"dangerTint",
	roles.dangerTint,
	TEXT,
	"the title and text of a red light Alert",
);
add(
	"action",
	roles.action,
	"actionTint",
	roles.actionTint,
	TEXT,
	"a blue light Alert/Badge (onTint = action)",
);
// Tags: graphite on every tint (theme.tsx Badge vars).
for (const [name, hex] of Object.entries(tagTints))
	add(
		"text",
		roles.text,
		`tag.${name}`,
		hex,
		TEXT,
		`a Badge, color → tag tint ${name}`,
	);
// Filled: white on the fill (the primary pill, destructive confirm, status fills).
add("white", WHITE, "action", roles.action, TEXT, "the filled primary Button");
add(
	"white",
	WHITE,
	"danger",
	roles.danger,
	TEXT,
	'the destructive confirm (color="red" variant="filled")',
);
add(
	"white",
	WHITE,
	"text",
	roles.text,
	TEXT,
	"a filled neutral Button, and every filled Button on hover",
);
add(
	"white",
	WHITE,
	"success",
	roles.success,
	TEXT,
	"a filled green Button or ThemeIcon",
);
add(
	"white",
	WHITE,
	"warning",
	roles.warning,
	TEXT,
	"a filled yellow Button or ThemeIcon",
);
// Large text: page titles at 33.17 and dialog titles at 24.88 in muted are rare, but the
// royal blue (primary-6) is kept for large and decorative use.
add(
	"primary.6",
	"#4169e1",
	"bg",
	roles.bg,
	LARGE,
	"primary-6 royal blue, large text and decoration only",
);
// Lines (non-text, 3:1).
add(
	"fieldLine",
	FIELD_LINE,
	"surface",
	roles.surface,
	LINE,
	"a field's side rules, a checkbox, radio or switch edge on white",
);
add(
	"fieldLine",
	FIELD_LINE,
	"bg",
	roles.bg,
	LINE,
	"a field's side rules and a control's edge on the page",
);
add(
	"focusLine",
	roles.action,
	"surface",
	roles.surface,
	LINE,
	"a focused field's rules, a selected card's box on white",
);
add(
	"focusLine",
	roles.action,
	"bg",
	roles.bg,
	LINE,
	"a focused field's rules, the selected tab's stretch on the page",
);
add(
	"errorLine",
	roles.danger,
	"surface",
	roles.surface,
	LINE,
	"a field in error on white",
);
add(
	"errorLine",
	roles.danger,
	"bg",
	roles.bg,
	LINE,
	"a field in error on the page",
);
add(
	"faintRule",
	FAINT_RULE,
	"bg",
	roles.bg,
	LINE,
	"card, table and divider rules (decorative: the text carries the structure)",
	true,
);
add(
	"faintRule",
	FAINT_RULE,
	"surface",
	roles.surface,
	LINE,
	"rules inside white surfaces (decorative)",
	true,
);
// Listed in the brief but never drawn: tags always carry graphite text, and muted,
// action and danger text are not set on the accent tints.
for (const [name, hex] of Object.entries(tagTints)) {
	if (name === "blue" || name === "neutral") continue; // same hexes as actionTint / quiet above
	for (const [fgName, fg] of [
		["muted", roles.muted],
		["action", roles.action],
		["danger", roles.danger],
	])
		add(
			fgName,
			fg,
			`tag.${name}`,
			hex,
			TEXT,
			"not drawn: tags carry graphite text",
			true,
		);
}

// WCAG 2.x relative luminance and contrast ratio.
const channel = (c) => {
	const s = c / 255;
	return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex) => {
	const h = hex.replace("#", "");
	const full =
		h.length === 3 ? [...h].map((x) => x + x).join("") : h.slice(0, 6);
	const [r, g, b] = [0, 2, 4].map((i) =>
		Number.parseInt(full.slice(i, i + 2), 16),
	);
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
const ratio = (a, b) => {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
};

const rows = pairs.map((p) => {
	const r = ratio(p.fg, p.bg);
	return { ...p, pass: r >= p.min, ratio: Math.round(r * 100) / 100 };
});
const failing = rows.filter((r) => !r.pass && !r.advisory);

if (process.argv.includes("--json")) {
	console.log(JSON.stringify({ failing: failing.length, rows }, null, 2));
	process.exit(failing.length ? 1 : 0);
}

const pad = (s, n) => String(s).padEnd(n);
console.log(
	`${pad("foreground", 22)}${pad("background", 22)}${pad("ratio", 8)}${pad("needs", 7)}${pad("", 10)}where`,
);
for (const r of rows) {
	const verdict = r.pass ? "ok" : r.advisory ? "advisory" : "FAIL";
	console.log(
		`${pad(`${r.fgName} ${r.fg}`, 22)}${pad(`${r.bgName} ${r.bg}`, 22)}${pad(r.ratio.toFixed(2), 8)}${pad(r.min, 7)}${pad(verdict, 10)}${r.where}`,
	);
}
const required = rows.filter((r) => !r.advisory).length;
console.log(
	`\n${required - failing.length} of ${required} required pairs pass; ${rows.length - required} advisory pairs reported.`,
);
if (failing.length) {
	for (const r of failing)
		console.log(
			`${inCI ? "::error::" : ""}${r.fgName} ${r.fg} on ${r.bgName} ${r.bg} is ${r.ratio}:1, needs ${r.min}:1 (${r.where})`,
		);
	process.exit(1);
}
