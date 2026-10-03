#!/usr/bin/env node
// Checks the dashboard's source against the design grammar (PR #1139): the border
// grammar, the Swiss type and spacing rules, colour roles, icons, button flow and
// the word list. It reads the code, not the rendered page; e2e/grammar.spec.ts
// checks what renders.
//
// The app does not pass today, so the check is a ratchet. scripts/grammar-baseline.json
// holds how many findings each file has per rule. A file may only go down. New code in
// a clean file has a baseline of zero, so one new violation fails.
//
//   node scripts/check-grammar.mjs              fail when any (file, rule) count rose
//   node scripts/check-grammar.mjs --update     lower the baseline to today's counts
//                                               (never raises one)
//   node scripts/check-grammar.mjs --list [id]  print every finding, or those whose rule
//                                               id starts with id ("type", "icon.size")
//   node scripts/check-grammar.mjs --summary    counts per rule and the busiest files
//   node scripts/check-grammar.mjs --json       machine output
//   node scripts/check-grammar.mjs --scan f...  check only these files, ignoring the baseline
//
// Soft rules (a judgement the scanner can only approximate) are counted in the baseline
// but a rise warns instead of failing.
//
// Raising a count is a decision, not a fix: edit scripts/grammar-baseline.json by hand in
// the same PR and say why in its description.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = path.join(root, "scripts/grammar-baseline.json");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const inCI = Boolean(process.env.GITHUB_ACTIONS);

const SOFT = new Set(["words.title-case"]);

// ---------------------------------------------------------------------------
// Which files
// ---------------------------------------------------------------------------

const SKIP_DIRS = [
	"src/routes/design/", // the design specimen shows violations on purpose
	"src/fonts/",
];
const SKIP_FILES = new Set([
	"src/colors.ts", // the token source
	"src/theme.tsx", // the theme maps tokens onto Mantine
	"src/styles/rules.css", // the grammar's implementation
	"src/index.css",
	"src/components/canvas/kit.css",
]);
const skipped = (rel) =>
	SKIP_FILES.has(rel) ||
	SKIP_DIRS.some((d) => rel.startsWith(d)) ||
	// every lingui catalog (src/locales, src/lib/errors/locales, src/features/*/locales)
	rel
		.split("/")
		.includes("locales") ||
	/\.(test|spec)\.[tj]sx?$/.test(rel) ||
	rel.endsWith(".d.ts");

function walk(dir, out = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const abs = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(abs, out);
		else out.push(path.relative(root, abs).split(path.sep).join("/"));
	}
	return out;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

const SPACE_SCALE = new Set([0, 4, 8, 16, 24, 32]);
// Mantine resolves a string spacing value through theme.spacing (src/theme.tsx);
// a number is pixels.
const THEME_SPACING = {
	0: 0,
	0.5: 2,
	1: 4,
	1.5: 6,
	2: 8,
	2.5: 10,
	"2xl": 40,
	3: 12,
	3.5: 14,
	4: 16,
	5: 20,
	6: 24,
	7: 28,
	8: 32,
	9: 36,
	10: 40,
	11: 44,
	12: 48,
	14: 56,
	16: 64,
	20: 80,
	24: 96,
	28: 112,
	32: 128,
	36: 144,
	40: 160,
	44: 176,
	48: 192,
	52: 208,
	56: 224,
	60: 240,
	64: 256,
	72: 288,
	80: 320,
	96: 384,
	lg: 24,
	md: 16,
	px: 1,
	sm: 8,
	xl: 32,
	xs: 4,
};
const WEIGHTS = new Set(["240", "320", "600"]);
const FLOAT_LAYERS = new Set([
	"Menu",
	"Popover",
	"Combobox",
	"Modal",
	"HoverCard",
	"Drawer",
	"Tooltip",
]);
// Theme shadows xs, sm, inner and none are "none" (src/theme.tsx), so these draw nothing.
const SHADOWS_THAT_DRAW_NOTHING = new Set(["none", "xs", "sm", "inner", "0"]);
const PALETTE =
	/^(?:bg|text|border(?:-[trblxyse])?|ring|from|via|to|fill|stroke|divide|outline)-(?:gray|slate|blue|red|green|yellow|orange|cyan|teal|purple|pink|indigo|amber|emerald|zinc|neutral|stone|sky|violet|fuchsia|rose|lime)-\d{2,3}(?:\/\d+)?$/;
const HEX =
	/(^|[^\w&/#])#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![\w-])/g;
const SPACE_PROPS = new Set([
	"gap",
	"rowGap",
	"columnGap",
	"p",
	"m",
	"px",
	"py",
	"pt",
	"pb",
	"pl",
	"pr",
	"ps",
	"pe",
	"mt",
	"mb",
	"ml",
	"mr",
	"mx",
	"my",
	"ms",
	"me",
]);
const STYLE_SPACE_KEYS =
	/^(gap|rowGap|columnGap|padding|margin)(Top|Bottom|Left|Right|Inline|Block|InlineStart|InlineEnd|BlockStart|BlockEnd)?$/;
// Rule 07: flags that say whether a dependent setting applies, and flags that say
// it applies but cannot run yet (those may disable).
const DEPENDENT_FLAG = /^(watched|is[A-Z].*Enabled|.*Enabled$|show[A-Z]|.*On$)/;
const DEPENDENT_EXCLUDE =
	/(pending|loading|saving|submitting|readOnly|canEdit|can[A-Z]|isValid|dirty)/i;
const CLASS_FNS = new Set([
	"cn",
	"clsx",
	"cx",
	"classNames",
	"twMerge",
	"twJoin",
	"cva",
]);

// Words that start upper case mid-label and are still sentence case.
const PROPER = new Set([
	"dembrane",
	"ECHO",
	"Popcorn",
	"Present",
	"Map",
	"MCP",
	"PostHog",
	"Google",
	"Verify",
	"Explore",
	"LocalMAP",
	"Directus",
	"I",
	// English names of languages
	"English",
	"Dutch",
	"German",
	"French",
	"Spanish",
	"Italian",
	"Czech",
	"Ukrainian",
	"Portuguese",
	"Polish",
	"Danish",
	"Swedish",
	"Norwegian",
	"Finnish",
	"Greek",
	"Turkish",
	"Arabic",
	"Chinese",
	"Japanese",
	"Korean",
	"Hindi",
	"Russian",
	"Hungarian",
	"Romanian",
	"Bulgarian",
	"Croatian",
	"Slovak",
	"Slovenian",
	"Estonian",
	"Latvian",
	"Lithuanian",
	"Irish",
	"Welsh",
	"Catalan",
	"Basque",
	"Galician",
	"Hebrew",
	"Indonesian",
	"Vietnamese",
	"Thai",
	"Malay",
	"Persian",
	"Urdu",
	"Bengali",
	"Swahili",
	"Frisian",
	"Flemish",
]);

// The CSS hexes that are tokens: roles and tag tints from colors.ts plus the fixed
// greys and states rules.css uses.
const CSS_TOKENS = (() => {
	const src = readFileSync(path.join(root, "src/colors.ts"), "utf8");
	const block = (name) =>
		src.match(new RegExp(`export const ${name} = \\{([\\s\\S]*?)\\}`))?.[1] ??
		"";
	const hexes = [
		...`${block("roles")}${block("tagTints")}`.matchAll(/#[0-9a-fA-F]{3,8}/g),
	].map((m) => m[0]);
	return new Set(
		[
			...hexes,
			"#e6e3df",
			"#878785",
			"#2957df",
			"#c0434e",
			"#a8323c",
			"#e9f1ff",
			"#dcdad7",
			"#ffffff",
			"#2d2d2c",
			"#5f646f",
			"#f6f4f1",
		].map(normHex),
	);
})();
function normHex(h) {
	let x = h.toLowerCase();
	if (x.length === 4) x = `#${x[1]}${x[1]}${x[2]}${x[2]}${x[3]}${x[3]}`;
	return x;
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

const findings = [];
function report(rule, file, line, message) {
	findings.push({ file, line, message, rule });
}

// Pixels for a spacing value, or null when it is not a length we can judge.
function spacePx(value) {
	if (typeof value === "number") return Math.abs(value);
	const v = String(value).trim();
	if (v in THEME_SPACING) return THEME_SPACING[v];
	const m = v.match(/^-?(\d*\.?\d+)(px|rem)?$/);
	if (!m) return null;
	const n = Number.parseFloat(m[1]);
	if (m[2] === "rem") return n * 16;
	return n;
}
function offScale(value) {
	if (typeof value === "string") {
		const parts = value.trim().split(/\s+/);
		if (parts.length > 1) return parts.some((p) => offScale(p));
		if (
			/^-?(var|calc|min|max|clamp)\(|%|auto|(^|[^r])em$|vh|vw|inherit|unset/.test(
				value,
			)
		)
			return false;
	}
	const px = spacePx(value);
	if (px === null) return false;
	return !SPACE_SCALE.has(Math.round(px * 100) / 100);
}
function fontPx(value) {
	if (typeof value === "number") return value;
	const m = String(value)
		.trim()
		.match(/^(\d*\.?\d+)px$/);
	return m ? Number.parseFloat(m[1]) : null;
}

// ---------------------------------------------------------------------------
// Class strings
// ---------------------------------------------------------------------------

function checkClasses(text, file, line) {
	for (const raw of text.split(/\s+/)) {
		if (!raw) continue;
		const cls = raw.replace(/^!/, "");
		const variants = cls.split(":");
		const util = variants.pop().replace(/^!/, "").replace(/^-/, "");
		const prefix = variants.join(":");
		if (/^font-(bold|semibold|medium|light|extrabold|black|thin)$/.test(util))
			report(
				"type.weight-class",
				file,
				line,
				`class ${raw}: weight comes from the one 320 cut; use <b> for emphasis`,
			);
		if (util === "uppercase")
			report("type.uppercase", file, line, `class ${raw}: no uppercase`);
		if (/^tracking-/.test(util))
			report("type.tracking", file, line, `class ${raw}: no letter-spacing`);
		const px = util.match(/^text-\[(\d*\.?\d+)px\]$/);
		if (px) {
			report(
				"type.px-size",
				file,
				line,
				`class ${raw}: use a size on the ladder (xs..xl)`,
			);
			if (Number(px[1]) < 14)
				report(
					"type.below-floor",
					file,
					line,
					`class ${raw}: ${px[1]}px is under the 14px floor`,
				);
		}
		if (PALETTE.test(util))
			report(
				"color.palette-class",
				file,
				line,
				`class ${raw}: raw palette colour; use a role (c="dimmed", c="primary", a status colour)`,
			);
		if (/^shadow(-|$)/.test(util) && util !== "shadow-none")
			report(
				"shape.shadow",
				file,
				line,
				`class ${raw}: no shadows on things that do not float`,
			);
		if (
			/^scale-/.test(util) ||
			(/(^|:)hover$/.test(prefix) && /^scale/.test(util))
		)
			report("shape.scale", file, line, `class ${raw}: no scaling`);
		if (
			/^bg-gradient-/.test(util) ||
			/^bg-\[(linear|radial)-gradient/.test(util)
		)
			report("shape.gradient", file, line, `class ${raw}: no gradients`);
		if (/^rounded(-|$)/.test(util) && !/(^|-)(full|none)$/.test(util))
			report("shape.rounded", file, line, `class ${raw}: square corners`);
	}
}

// Every token is utility-shaped and at least one has a dash ("flex", "text-sm").
const looksLikeClassList = (s) => {
	const toks = s.trim().split(/\s+/);
	return (
		toks.length > 0 &&
		toks.every((t) => /^!?[a-z0-9:[\]/.#%()_,!&>*=+-]+$/.test(t)) &&
		toks.some((t) => t.includes("-"))
	);
};

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

function checkWords(text, file, line, { lead = false } = {}) {
	const s = text.replace(/\s+/g, " ").trim();
	if (!s) return;
	const hits = [];
	if (/\bRetry\b/.test(s)) hits.push('"Retry" (say "Try again")');
	if (/^Next\s*[→›»>]?$/.test(s)) hits.push('"Next" (say "Continue")');
	if (/\bLogin\b/.test(s)) hits.push('"Login" (say "Log in")');
	if (/\bLogout\b/.test(s)) hits.push('"Logout" (say "Log out")');
	if (/\bsign in\b/i.test(s)) hits.push('"Sign in" (say "Log in")');
	if (/organiz/i.test(s)) hits.push('"organiz-" (spell "organis-")');
	// A "•" that opens an element is a hand-built bullet, not a meta separator.
	if (/(^|\s)•(\s|$)/.test(lead ? s.replace(/^•/, "") : s))
		hits.push('" • " (the meta separator is "·")');
	if (s.endsWith("!") && s.split(" ").length <= 4)
		hits.push("trailing ! on a short label");
	for (const h of hits)
		report("words.denylist", file, line, `${h}: ${clip(s)}`);
}

function checkTitleCase(text, file, line) {
	const words = text
		.replace(/\{[^}]*\}/g, " ")
		.replace(/<\/?\d+>/g, " ")
		.split(/\s+/)
		.map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
		.filter(Boolean);
	if (words.length < 2 || words.length > 6) return;
	// Placeholder examples ("e.g. Client Alpha, Q1 Research") name things.
	if (/^e\.g\./i.test(text.trim())) return;
	const capped = words.slice(1).filter(
		(w) =>
			/^\p{Lu}/u.test(w) &&
			!PROPER.has(w) &&
			!/^[\p{Lu}\d]{2,}s?$/u.test(w) && // acronyms: PDF, AI, URLs
			!/\d/.test(w),
	);
	if (capped.length >= 2)
		report("words.title-case", file, line, `sentence case: ${clip(text)}`);
}

const clip = (s) => {
	const one = s.replace(/\s+/g, " ").trim();
	return one.length > 70 ? `"${one.slice(0, 67)}..."` : `"${one}"`;
};

// ---------------------------------------------------------------------------
// TSX / TS
// ---------------------------------------------------------------------------

function scanSource(rel) {
	const text = readFileSync(path.join(root, rel), "utf8");
	const isTsx = rel.endsWith(".tsx");
	const sf = ts.createSourceFile(
		rel,
		text,
		ts.ScriptTarget.Latest,
		true,
		isTsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);
	const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
	const at = (node) => lineOf(node.getStart(sf));

	// react-pdf documents are a print medium with their own point sizes.
	const isPdf = /from\s+["']@react-pdf\/renderer["']/.test(text);

	const phosphor = new Set();
	const foreignIcons = new Set();
	const customIcons = new Set();
	for (const st of sf.statements) {
		if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier))
			continue;
		const mod = st.moduleSpecifier.text;
		const names = [];
		const clause = st.importClause;
		if (clause?.name) names.push(clause.name.text);
		if (clause?.namedBindings) {
			if (ts.isNamedImports(clause.namedBindings))
				for (const el of clause.namedBindings.elements)
					names.push(el.name.text);
			else names.push(clause.namedBindings.name.text);
		}
		if (
			mod === "@phosphor-icons/react" ||
			mod.startsWith("@phosphor-icons/react/")
		) {
			for (const n of names)
				if (/^[A-Z]/.test(n) && n !== "IconContext") phosphor.add(n);
		} else if (mod === "lucide-react" || mod === "@tabler/icons-react") {
			for (const n of names) foreignIcons.add(n);
			report(
				"icon.library",
				rel,
				at(st),
				`imports from ${mod}: use Phosphor (light)`,
			);
		} else if (/(^|\/)icons(\/index)?$/.test(mod) && names.includes("Icons")) {
			customIcons.add("Icons");
		}
	}

	const classSeen = new Set();
	const scanClassStrings = (node) => {
		const visit = (n) => {
			if (classSeen.has(n.pos)) return;
			if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
				classSeen.add(n.pos);
				checkClasses(n.text, rel, at(n));
			} else if (ts.isTemplateExpression(n)) {
				classSeen.add(n.pos);
				checkClasses(n.head.text, rel, at(n));
				for (const span of n.templateSpans) {
					visit(span.expression);
					checkClasses(span.literal.text, rel, at(span));
				}
				return;
			}
			ts.forEachChild(n, visit);
		};
		visit(node);
	};

	const attrValue = (attr) => {
		// string, number, boolean, or undefined when not a literal
		const init = attr.initializer;
		if (!init) return true;
		if (ts.isStringLiteral(init)) return init.text;
		if (ts.isJsxExpression(init) && init.expression) {
			let e = init.expression;
			if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e))
				return e.text;
			let sign = 1;
			if (
				ts.isPrefixUnaryExpression(e) &&
				e.operator === ts.SyntaxKind.MinusToken
			) {
				sign = -1;
				e = e.operand;
			}
			if (ts.isNumericLiteral(e)) return sign * Number(e.text);
		}
		return undefined;
	};

	const tagName = (n) => n.tagName.getText(sf);

	// Text of a <Trans> element as lingui would extract it, nested tags inlined.
	const transText = (el) => {
		let out = "";
		const walkKids = (kids) => {
			for (const k of kids) {
				if (ts.isJsxText(k)) out += k.text;
				else if (ts.isJsxExpression(k)) {
					if (k.expression && ts.isStringLiteral(k.expression))
						out += k.expression.text;
					else if (k.expression) out += "{x}";
				} else if (ts.isJsxElement(k)) walkKids(k.children);
				else if (ts.isJsxSelfClosingElement(k)) out += " ";
			}
		};
		walkKids(el.children);
		return out;
	};

	const jsxTextLine = (node) => {
		const lead = node.text.match(/^\s*/)[0].length;
		return lineOf(node.pos + lead);
	};

	// Rule 07, show what applies: a control that depends on a switch is hidden
	// while it is off, not disabled or faded. Returns the flag's text when the
	// expression is such a flag (optionally negated), else null.
	const dependentFlag = (expr) => {
		let e = expr;
		while (
			ts.isParenthesizedExpression(e) ||
			(ts.isPrefixUnaryExpression(e) &&
				e.operator === ts.SyntaxKind.ExclamationToken)
		)
			e = ts.isParenthesizedExpression(e) ? e.expression : e.operand;
		if (!ts.isIdentifier(e) && !ts.isPropertyAccessExpression(e)) return null;
		const full = e.getText(sf);
		const last = ts.isIdentifier(e) ? e.text : e.name.text;
		if (DEPENDENT_EXCLUDE.test(full)) return null;
		return DEPENDENT_FLAG.test(full) || DEPENDENT_FLAG.test(last) ? full : null;
	};

	const checkStyleObject = (obj, spacing) => {
		for (const prop of obj.properties) {
			if (!ts.isPropertyAssignment(prop)) continue;
			const key =
				prop.name &&
				(ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
					? prop.name.text
					: null;
			if (!key) continue;
			let v = prop.initializer;
			let sign = 1;
			if (
				ts.isPrefixUnaryExpression(v) &&
				v.operator === ts.SyntaxKind.MinusToken
			) {
				sign = -1;
				v = v.operand;
			}
			const lit = ts.isNumericLiteral(v)
				? sign * Number(v.text)
				: ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v)
					? v.text
					: undefined;
			const line = at(prop);
			if (ts.isObjectLiteralExpression(v)) continue; // nested objects are visited on their own
			if (key === "opacity" && ts.isConditionalExpression(v)) {
				const f = dependentFlag(v.condition);
				if (f)
					report(
						"flow.dependent-disabled",
						rel,
						line,
						`opacity follows ${f}: show what applies, hide the rest`,
					);
			}
			if (lit === undefined) continue;
			if (
				key === "fontWeight" &&
				!WEIGHTS.has(String(lit)) &&
				!/^(inherit|var\()/.test(String(lit))
			)
				report(
					"type.font-weight-style",
					rel,
					line,
					`fontWeight ${lit}: only 240, 320 or 600`,
				);
			if (key === "textTransform" && lit === "uppercase")
				report("type.uppercase", rel, line, "textTransform uppercase");
			if (
				key === "letterSpacing" &&
				!["0", "normal", "0px", "inherit"].includes(String(lit)) &&
				lit !== 0
			)
				report("type.tracking", rel, line, `letterSpacing ${lit}: no tracking`);
			if (key === "fontSize") {
				const px = fontPx(lit);
				if (px !== null) {
					report(
						"type.px-size",
						rel,
						line,
						`fontSize ${lit}: use a size on the ladder`,
					);
					if (px < 14)
						report(
							"type.below-floor",
							rel,
							line,
							`fontSize ${lit} is under the 14px floor`,
						);
				}
			}
			if (
				/^border(Top|Bottom)?(Left|Right)?(Start|End)?(Start|End)?Radius$/.test(
					key,
				) &&
				!["0", "0px", "50%", "9999px", "inherit"].includes(String(lit)) &&
				lit !== 0 &&
				lit !== 9999
			)
				report("shape.rounded", rel, line, `${key} ${lit}: square corners`);
			if (
				typeof lit === "string" &&
				/(linear|radial|conic)-gradient\(/.test(lit)
			)
				report("shape.gradient", rel, line, `${key}: no gradients`);
			if (spacing && STYLE_SPACE_KEYS.test(key) && offScale(lit))
				report("space.off-scale", rel, line, `${key} ${lit}: use 4/8/16/24/32`);
		}
	};

	const styleAttrSeen = new Set();
	const visit = (node, ctx) => {
		// Imports and type positions carry no UI.
		if (ts.isImportDeclaration(node) || ts.isTypeNode(node)) return;

		if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
			const tag = tagName(node);
			const attrs = new Map();
			let hasSpread = false;
			for (const a of node.attributes.properties) {
				if (ts.isJsxSpreadAttribute(a)) hasSpread = true;
				else attrs.set(a.name.getText(sf), a);
			}
			const val = (n) => (attrs.has(n) ? attrValue(attrs.get(n)) : undefined);
			const line = at(node);

			if (attrs.has("fw"))
				report(
					"type.fw-prop",
					rel,
					line,
					`<${tag} fw>: weight comes from the one 320 cut`,
				);
			if (val("tt") === "uppercase")
				report("type.uppercase", rel, line, `<${tag} tt="uppercase">`);
			if (attrs.has("lts"))
				report("type.tracking", rel, line, `<${tag} lts>: no letter-spacing`);
			for (const p of ["size", "fz"]) {
				const v = val(p);
				const px =
					p === "fz"
						? v === undefined
							? null
							: fontPx(v)
						: typeof v === "string"
							? fontPx(v)
							: null;
				if (px !== null) {
					report(
						"type.px-size",
						rel,
						line,
						`<${tag} ${p}=${JSON.stringify(v)}>: use xs..xl`,
					);
					if (px < 14)
						report(
							"type.below-floor",
							rel,
							line,
							`<${tag} ${p}=${JSON.stringify(v)}> is under the 14px floor`,
						);
				}
			}
			if (tag === "Title" && (val("order") === 1 || val("order") === 3))
				report(
					"type.title-order",
					rel,
					line,
					`Title order={${val("order")}}: pages are 2, cards 4, groups 5`,
				);

			for (const p of ["color", "c"]) {
				const v = val(p);
				if (v === "blue")
					report(
						"color.blue-prop",
						rel,
						line,
						`<${tag} ${p}="blue">: action colour is c="primary"`,
					);
				if (
					typeof v === "string" &&
					/^[a-zA-Z]+\.\d$/.test(v) &&
					!v.startsWith("dimmed")
				)
					report(
						"color.raw-mantine-shade",
						rel,
						line,
						`<${tag} ${p}="${v}">: the role picks the shade`,
					);
			}
			if (val("variant") === "light") {
				if (tag === "Button")
					report(
						"color.button-light",
						rel,
						line,
						`<Button variant="light">: secondary is the plain (outline) Button`,
					);
				else if (
					/^(ActionIcon|CloseButton|UnstyledButton|Anchor)$/.test(tag) ||
					/Button$/.test(tag)
				)
					report(
						"action.light-variant",
						rel,
						line,
						`<${tag} variant="light">: something you press is outline, subtle or the filled primary`,
					);
			}
			if (attrs.has("shadow") && !FLOAT_LAYERS.has(tag.split(".")[0])) {
				const v = val("shadow");
				if (!SHADOWS_THAT_DRAW_NOTHING.has(String(v)) && v !== 0)
					report(
						"shape.shadow",
						rel,
						line,
						`<${tag} shadow>: only floating layers cast a shadow`,
					);
			}
			if (val("variant") === "gradient")
				report("shape.gradient", rel, line, `<${tag} variant="gradient">`);
			if (attrs.has("radius") && !/^Avatar/.test(tag)) {
				const v = val("radius");
				if (
					(typeof v === "number" && v > 0) ||
					v === "full" ||
					v === "100%" ||
					v === "50%" ||
					(typeof v === "string" &&
						/^\d+(\.\d+)?(px|rem)$/.test(v) &&
						Number.parseFloat(v) > 0)
				)
					report(
						"shape.rounded",
						rel,
						line,
						`<${tag} radius=${JSON.stringify(v)}>: square corners`,
					);
			}

			// Icons
			if (phosphor.has(tag)) {
				if (!attrs.has("size") && !hasSpread)
					report(
						"icon.no-size",
						rel,
						line,
						`<${tag}> without size: 20 in buttons, 16 inline`,
					);
				const s = val("size");
				if (s !== undefined && s !== true && !["16", "20"].includes(String(s)))
					report(
						"icon.size",
						rel,
						line,
						`<${tag} size=${JSON.stringify(s)}>: 16 or 20`,
					);
				if (attrs.has("weight") && val("weight") !== "light")
					report(
						"icon.weight",
						rel,
						line,
						`<${tag} weight=${JSON.stringify(val("weight") ?? "…")}>: light only; show state with colour`,
					);
			}
			if (customIcons.size && /^Icons\./.test(tag))
				report("icon.library", rel, line, `<${tag}>: use the Phosphor icon`);

			// Actions pushed to the right
			if (
				ts.isJsxOpeningElement(node) &&
				/^(Group|Flex)$/.test(tag) &&
				["flex-end", "space-between"].includes(val("justify"))
			) {
				const el = node.parent;
				const kids = [];
				let opaque = false;
				const collect = (k) => {
					if (ts.isJsxText(k)) {
						if (k.text.trim()) opaque = true;
					} else if (ts.isJsxElement(k)) kids.push(k.openingElement);
					else if (ts.isJsxSelfClosingElement(k)) kids.push(k);
					else if (ts.isJsxExpression(k) && k.expression) {
						let e = k.expression;
						while (ts.isParenthesizedExpression(e)) e = e.expression;
						if (
							ts.isBinaryExpression(e) &&
							e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
						)
							collect(e.right);
						else if (ts.isConditionalExpression(e)) {
							collect(e.whenTrue);
							collect(e.whenFalse);
						} else if (ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e))
							collect(e);
						else if (ts.isParenthesizedExpression(e)) collect(e.expression);
						else if (e.kind !== ts.SyntaxKind.NullKeyword) opaque = true;
					} else if (ts.isJsxFragment(k))
						for (const c of k.children) collect(c);
					else if (ts.isParenthesizedExpression(k)) collect(k.expression);
					else if (
						k.kind !== ts.SyntaxKind.NullKeyword &&
						!ts.isJsxExpression(k)
					)
						opaque = true;
				};
				for (const k of el.children) collect(k);
				if (
					!opaque &&
					kids.length &&
					kids.every((k) => tagName(k) === "Button")
				)
					report(
						"action.right-aligned",
						rel,
						line,
						`<${tag} justify="${val("justify")}"> of buttons: actions sit at the left, primary first`,
					);
			}

			// Rule 07: disabled={!flag} on a setting that depends on a switch.
			{
				const d = attrs.get("disabled");
				const e =
					d?.initializer && ts.isJsxExpression(d.initializer)
						? d.initializer.expression
						: null;
				let inner = e;
				while (inner && ts.isParenthesizedExpression(inner))
					inner = inner.expression;
				if (
					inner &&
					ts.isPrefixUnaryExpression(inner) &&
					inner.operator === ts.SyntaxKind.ExclamationToken
				) {
					const f = dependentFlag(inner);
					if (f)
						report(
							"flow.dependent-disabled",
							rel,
							line,
							`<${tag} disabled={!${f}}>: a setting that does not apply is hidden, not disabled`,
						);
				}
			}

			// Spacing props
			for (const [name, a] of attrs) {
				if (!SPACE_PROPS.has(name)) continue;
				const v = attrValue(a);
				if (v === undefined || v === true) continue;
				if (offScale(v))
					report(
						"space.off-scale",
						rel,
						line,
						`<${tag} ${name}=${JSON.stringify(v)}>: use xs/sm/md/lg/xl (4/8/16/24/32)`,
					);
			}

			// Class strings
			for (const name of ["className", "classNames"]) {
				const a = attrs.get(name);
				if (a?.initializer) scanClassStrings(a.initializer);
			}
			// Spacing inside style objects (typography and shape keys are checked on
			// every object literal below).
			for (const name of ["style", "styles"]) {
				const a = attrs.get(name);
				if (!a?.initializer) continue;
				const v = (n) => {
					if (ts.isObjectLiteralExpression(n)) styleAttrSeen.add(n.pos);
					ts.forEachChild(n, v);
				};
				v(a.initializer);
			}
		}

		if (ts.isCallExpression(node)) {
			const callee = node.expression;
			if (ts.isIdentifier(callee) && CLASS_FNS.has(callee.text))
				for (const arg of node.arguments) scanClassStrings(arg);
			if (
				ts.isPropertyAccessExpression(callee) &&
				callee.name.text === "openConfirmModal"
			)
				report(
					"action.confirm-modal",
					rel,
					at(node),
					"modals.openConfirmModal: use openConfirm from @/lib/openConfirm or ConfirmModal",
				);
			// t({ message: "..." })
			if (
				ts.isIdentifier(callee) &&
				callee.text === "t" &&
				node.arguments[0] &&
				ts.isObjectLiteralExpression(node.arguments[0])
			) {
				for (const p of node.arguments[0].properties)
					if (
						ts.isPropertyAssignment(p) &&
						p.name.getText(sf) === "message" &&
						ts.isStringLiteral(p.initializer)
					) {
						checkWords(p.initializer.text, rel, at(p));
						checkTitleCase(p.initializer.text, rel, at(p));
					}
			}
		}

		// Class lists kept in constants (const ADDED = "bg-green-100 ...") or under a
		// class-named key ({ className: "..." }) outside a className attribute.
		if (isTsx && ts.isVariableDeclaration(node) && node.initializer) {
			let e = node.initializer;
			while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e))
				e = e.expression;
			const strings = [];
			const grab = (n) => {
				if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n))
					strings.push(n);
				else if (ts.isConditionalExpression(n)) {
					grab(n.whenTrue);
					grab(n.whenFalse);
				} else if (ts.isArrayLiteralExpression(n)) n.elements.forEach(grab);
			};
			grab(e);
			for (const s of strings)
				if (looksLikeClassList(s.text) && !classSeen.has(s.pos)) {
					classSeen.add(s.pos);
					checkClasses(s.text, rel, at(s));
				}
		}
		if (ts.isPropertyAssignment(node) && /class/i.test(node.name.getText(sf)))
			scanClassStrings(node.initializer);

		if (ts.isObjectLiteralExpression(node) && !isPdf)
			checkStyleObject(node, styleAttrSeen.has(node.pos));

		if (
			ts.isTaggedTemplateExpression(node) &&
			ts.isIdentifier(node.tag) &&
			(node.tag.text === "t" || node.tag.text === "msg")
		) {
			const tpl = node.template;
			const s = ts.isNoSubstitutionTemplateLiteral(tpl)
				? tpl.text
				: tpl.head.text +
					tpl.templateSpans.map((sp) => `{x}${sp.literal.text}`).join("");
			checkWords(s, rel, at(node));
			checkTitleCase(s, rel, at(node));
		}

		if (ts.isJsxElement(node) && tagName(node.openingElement) === "Trans") {
			checkTitleCase(transText(node), rel, at(node));
			for (const k of node.children)
				if (
					ts.isJsxExpression(k) &&
					k.expression &&
					ts.isStringLiteral(k.expression)
				)
					checkWords(k.expression.text, rel, at(k));
		}

		if (ts.isJsxText(node) && !ctx.code) {
			const first = node.parent.children?.find(
				(k) => !(ts.isJsxText(k) && !k.text.trim()),
			);
			checkWords(node.text, rel, jsxTextLine(node), { lead: first === node });
		}

		if (
			isTsx &&
			(ts.isStringLiteral(node) ||
				ts.isNoSubstitutionTemplateLiteral(node) ||
				ts.isTemplateHead(node) ||
				ts.isTemplateMiddle(node) ||
				ts.isTemplateTail(node))
		)
			for (const m of node.text.matchAll(HEX))
				report(
					"color.hex-literal",
					rel,
					at(node),
					`#${m[2]}: use a role or a CSS variable`,
				);

		let next = ctx;
		if (
			ts.isJsxElement(node) &&
			/^(code|pre|Code)$/.test(tagName(node.openingElement))
		)
			next = { ...ctx, code: true };
		ts.forEachChild(node, (c) => visit(c, next));
	};
	visit(sf, { code: false });
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

function scanCss(rel) {
	const text = readFileSync(path.join(root, rel), "utf8").replace(
		/\/\*[\s\S]*?\*\//g,
		(c) => c.replace(/[^\n]/g, " "),
	);
	let buf = "";
	let bufStart = 0;
	let line = 1;
	const declaration = (decl, startLine) => {
		const i = decl.indexOf(":");
		if (i < 0) return;
		const prop = decl.slice(0, i).trim().toLowerCase();
		const value = decl
			.slice(i + 1)
			.replace(/!important/, "")
			.trim();
		const lines =
			decl.slice(0, decl.length - decl.trimStart().length).split("\n").length -
			1;
		const at = startLine + lines;
		if (prop.startsWith("--")) return; // custom properties are checked where they are used
		if (
			prop === "font-weight" &&
			!WEIGHTS.has(value) &&
			!/^(inherit|var\()/.test(value)
		)
			report(
				"css.font-weight",
				rel,
				at,
				`font-weight: ${value}: only 240, 320 or 600`,
			);
		if (
			/^border(-(top|bottom)-(left|right)|-(start|end)-(start|end))?-radius$/.test(
				prop,
			) &&
			!value
				.split(/\s+/)
				.every((v) => ["0", "0px", "9999px", "50%", "inherit"].includes(v)) &&
			!/^var\(/.test(value)
		)
			report("css.radius", rel, at, `${prop}: ${value}: square corners`);
		if (prop === "text-transform" && value === "uppercase")
			report("css.uppercase", rel, at, "text-transform: uppercase");
		if (
			prop === "letter-spacing" &&
			!["normal", "0", "0px", "inherit"].includes(value)
		)
			report("css.tracking", rel, at, `letter-spacing: ${value}`);
		for (const m of value.matchAll(HEX)) {
			const h = normHex(`#${m[2]}`);
			if (!CSS_TOKENS.has(h))
				report("css.hex", rel, at, `#${m[2]} is not a token colour`);
		}
	};
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === "{") {
			buf = "";
			bufStart = line;
		} else if (ch === ";" || ch === "}") {
			if (buf.includes(":")) declaration(buf, bufStart);
			buf = "";
			bufStart = line;
		} else {
			if (!buf.trim() && ch !== "\n" && !/\s/.test(ch)) bufStart = line;
			buf += ch;
		}
		if (ch === "\n") line++;
	}
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const started = Date.now();
// --scan <file...> checks only the named files and prints what it finds (no baseline).
const scanAt = args.indexOf("--scan");
const scanOnly =
	scanAt > -1
		? args.slice(scanAt + 1).filter((a) => !a.startsWith("--"))
		: null;
const files = scanOnly
	? scanOnly.map((f) =>
			path.relative(root, path.resolve(f)).split(path.sep).join("/"),
		)
	: walk(path.join(root, "src")).filter((f) => !skipped(f));
for (const f of files) {
	if (/\.tsx?$/.test(f)) scanSource(f);
	else if (f.endsWith(".css")) scanCss(f);
}

// The grammar's stylesheets take every colour from the tokens on rules.css's
// :root, so a theme (dark) redefines the tokens and nothing else. A hex anywhere
// else in them is a finding.
for (const rel of scanOnly
	? []
	: ["src/styles/rules.css", "src/styles/button.module.css"]) {
	const css = readFileSync(path.join(root, rel), "utf8").replace(
		/\/\*[\s\S]*?\*\//g,
		(c) => c.replace(/[^\n]/g, " "),
	);
	for (const m of css.matchAll(/#[0-9a-f]{3,8}\b/gi)) {
		const before = css.slice(0, m.index);
		const open = before.lastIndexOf("{");
		const selector = before
			.slice(before.lastIndexOf("}", open) + 1, open)
			.trim();
		if (selector !== ":root")
			report(
				"color.rules-token",
				rel,
				before.split("\n").length,
				`${m[0]}: use a token from the :root in rules.css`,
			);
	}
}
findings.sort(
	(a, b) =>
		a.file.localeCompare(b.file) ||
		a.line - b.line ||
		a.rule.localeCompare(b.rule),
);

const counts = {};
for (const f of findings) {
	counts[f.file] ??= {};
	counts[f.file][f.rule] = (counts[f.file][f.rule] ?? 0) + 1;
}
// Keys in the order biome's useSortedKeys wants (letters case-insensitive, an
// upper-case letter before its lower-case twin, digit runs by value), so
// `biome check` passes on the baseline as written.
const keyOrder = (a, b) => {
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		const da = a.slice(i).match(/^\d+/)?.[0];
		const db = b.slice(j).match(/^\d+/)?.[0];
		if (da && db) {
			if (Number(da) !== Number(db)) return Number(da) - Number(db);
			i += da.length;
			j += db.length;
			continue;
		}
		const ca = a[i];
		const cb = b[j];
		if (ca !== cb) {
			const la = ca.toLowerCase();
			const lb = cb.toLowerCase();
			if (la === lb) return ca === la ? 1 : -1;
			return la < lb ? -1 : 1;
		}
		i++;
		j++;
	}
	return a.length - i - (b.length - j);
};
const sortObj = (o) =>
	Object.fromEntries(
		Object.keys(o)
			.sort(keyOrder)
			.map((k) => [k, typeof o[k] === "object" ? sortObj(o[k]) : o[k]]),
	);
const ruleTotals = (c) => {
	const t = {};
	for (const rules of Object.values(c))
		for (const [r, n] of Object.entries(rules)) t[r] = (t[r] ?? 0) + n;
	return t;
};
const fmt = (f) => `  ${f.rule.padEnd(24)} ${f.file}:${f.line}  ${f.message}`;
const writeBaseline = (c) =>
	writeFileSync(
		BASELINE,
		`${JSON.stringify(
			{
				_: "Findings per file per rule from scripts/check-grammar.mjs. Counts only go down: run `pnpm check:grammar --update` after fixing. Raising one is a decision; edit it by hand in the PR and say why.",
				files: sortObj(c),
			},
			null,
			"\t",
		)}\n`,
	);

if (scanOnly) {
	for (const f of findings) console.log(fmt(f));
	console.log(`\n${findings.length} findings in ${files.length} files.`);
	process.exit(findings.length ? 1 : 0);
}

if (flag("--list")) {
	const i = args.indexOf("--list");
	const filter =
		args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : "";
	const shown = findings.filter((f) => f.rule.startsWith(filter));
	for (const f of shown) console.log(fmt(f));
	console.log(`\n${shown.length} findings${filter ? ` for ${filter}` : ""}.`);
	process.exit(0);
}

const baseline = existsSync(BASELINE)
	? JSON.parse(readFileSync(BASELINE, "utf8")).files
	: null;

if (!baseline) {
	writeBaseline(counts);
	console.log(
		`No baseline yet: wrote ${path.relative(root, BASELINE)} with ${findings.length} findings in ${Object.keys(counts).length} files.`,
	);
	process.exit(0);
}

const rises = [];
const drops = [];
for (const file of new Set([
	...Object.keys(counts),
	...Object.keys(baseline),
])) {
	const cur = counts[file] ?? {};
	const base = baseline[file] ?? {};
	for (const rule of new Set([...Object.keys(cur), ...Object.keys(base)])) {
		const c = cur[rule] ?? 0;
		const b = base[rule] ?? 0;
		if (c > b)
			rises.push({ base: b, current: c, file, rule, soft: SOFT.has(rule) });
		else if (c < b) drops.push({ base: b, current: c, file, rule });
	}
}
const hard = rises.filter((r) => !r.soft);
const soft = rises.filter((r) => r.soft);

if (flag("--json")) {
	console.log(
		JSON.stringify(
			{
				counts: sortObj(counts),
				drops,
				findings,
				rises,
				totals: sortObj(ruleTotals(counts)),
			},
			null,
			2,
		),
	);
	process.exit(hard.length && !flag("--update") ? 1 : 0);
}

if (flag("--summary")) {
	const totals = Object.entries(ruleTotals(counts)).sort((a, b) => b[1] - a[1]);
	console.log("Findings per rule:");
	for (const [r, n] of totals)
		console.log(
			`  ${String(n).padStart(5)}  ${r}${SOFT.has(r) ? " (soft)" : ""}`,
		);
	const perFile = Object.entries(counts)
		.map(([f, rules]) => [f, Object.values(rules).reduce((a, b) => a + b, 0)])
		.sort((a, b) => b[1] - a[1]);
	console.log("\nBusiest files:");
	for (const [f, n] of perFile.slice(0, 15))
		console.log(`  ${String(n).padStart(5)}  ${f}`);
	console.log(
		`\n${findings.length} findings in ${perFile.length} of ${files.length} files.`,
	);
}

if (flag("--update")) {
	const next = {};
	for (const file of Object.keys(baseline)) {
		for (const [rule, b] of Object.entries(baseline[file])) {
			const c = counts[file]?.[rule] ?? 0;
			const n = Math.min(b, c);
			if (n > 0) {
				next[file] ??= {};
				next[file][rule] = n;
			}
		}
	}
	writeBaseline(next);
	const lowered = drops.reduce((a, d) => a + d.base - d.current, 0);
	console.log(
		`Baseline updated: ${drops.length} counts lowered (${lowered} findings fewer).`,
	);
	if (rises.length) {
		console.log(
			`\nRefused to raise ${rises.length} counts. The baseline only goes down; fix these, or raise the number by hand in the PR and say why:`,
		);
		for (const r of rises)
			console.log(
				`  ${r.rule.padEnd(24)} ${r.file}  baseline ${r.base}, now ${r.current}`,
			);
	}
	process.exit(0);
}

const byKey = (r) =>
	findings.filter((f) => f.file === r.file && f.rule === r.rule);
if (soft.length) {
	console.log(
		`${inCI ? "::warning::" : ""}Soft findings rose in ${soft.length} places (warning only):`,
	);
	for (const r of soft) {
		console.log(
			`  ${r.rule} in ${r.file}: baseline ${r.base}, now ${r.current}`,
		);
		for (const f of byKey(r)) console.log(`  ${fmt(f)}`);
	}
}
const ms = Date.now() - started;
if (hard.length) {
	console.log(
		`${inCI ? "::error::" : ""}Design grammar: ${hard.length} counts rose above the baseline.`,
	);
	for (const r of hard) {
		console.log(
			`\n${r.rule} in ${r.file}: baseline ${r.base}, now ${r.current}. Findings of this rule in the file (the new ones are among them):`,
		);
		for (const f of byKey(r)) console.log(fmt(f));
	}
	console.log(
		"\nFix them (the grammar: src/styles/rules.css, src/theme.tsx, PR #1139). A renamed or moved file starts at a baseline of zero; carry its counts over to the new path in scripts/grammar-baseline.json in the same PR.",
	);
	process.exit(1);
}
const total = findings.length;
const baseTotal = Object.values(ruleTotals(baseline)).reduce(
	(a, b) => a + b,
	0,
);
console.log(
	`Design grammar: ${total} findings, baseline ${baseTotal}; nothing rose (${files.length} files, ${ms} ms).`,
);
if (drops.length) {
	console.log(`${drops.length} counts dropped below the baseline:`);
	for (const d of drops.slice(0, 20))
		console.log(`  ${d.rule.padEnd(24)} ${d.file}  ${d.base} -> ${d.current}`);
	if (drops.length > 20) console.log(`  ... and ${drops.length - 20} more`);
	console.log("Run `pnpm check:grammar --update` to lock them in.");
}
