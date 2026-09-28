#!/usr/bin/env node
// Checks the lingui catalogs after `messages:extract` and `messages:compile` have run.
//
// 1. Stale catalogs fail. If extract or compile changed a catalog, source strings moved
//    without the catalogs being regenerated, and a dotted id that was never extracted
//    renders as the raw id in the UI.
// 2. Missing translations are listed per locale: every message English has that a locale
//    leaves empty. A natural-language msgid falls back to English; a dotted id does not.
//    Without --strict this only warns, because the catalogs carry a backlog today.
//
//   node scripts/check-translations.mjs            stale fails, missing warns
//   node scripts/check-translations.mjs --strict   missing fails too
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import config from "../lingui.config.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const strict = process.argv.includes("--strict");
const inCI = Boolean(process.env.GITHUB_ACTIONS);
const { sourceLocale, locales } = config;

// "<rootDir>/src/locales/{locale}" -> "src/locales"
const catalogs = config.catalogs.map((c) => {
	const dir = path.dirname(c.path.replace("<rootDir>/", ""));
	return { dir, file: (locale) => path.join(root, dir, `${locale}.po`) };
});

// 1. Stale catalogs.
const dirs = catalogs.map((c) => c.dir);
const changed = execFileSync(
	"git",
	["status", "--porcelain", "--untracked-files=all", "--", ...dirs],
	{ cwd: root, encoding: "utf8" },
).trim();
if (changed) {
	console.log(changed);
	console.log(
		`${inCI ? "::error::" : ""}The catalogs are stale: source strings changed without re-running extract and compile.`,
	);
	console.log(
		"Fix: cd dembrane/frontend && pnpm messages:extract && pnpm messages:compile, then commit the catalogs.",
	);
	process.exit(1);
}
console.log(`Catalogs are up to date (${dirs.join(", ")}).`);

// 2. Missing translations.
// Reads the live entries of a lingui .po file into Map<key, { text, ref }>. Obsolete
// entries (#~) are skipped; msgctxt, when present, is part of the key.
function readPo(file) {
	const entries = new Map();
	if (!existsSync(file)) return entries;
	let entry = { ref: "" };
	let field = null;
	const flush = () => {
		if (entry.msgid) {
			const key = entry.msgctxt
				? `${entry.msgctxt}\u0004${entry.msgid}`
				: entry.msgid;
			entries.set(key, { ref: entry.ref, text: entry.msgstr ?? "" });
		}
		entry = { ref: "" };
		field = null;
	};
	const unquote = (s) => JSON.parse(s);
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (line.trim() === "") {
			flush();
		} else if (line.startsWith("#:")) {
			entry.ref ||= line.slice(2).trim().split(" ")[0];
		} else if (line.startsWith("#")) {
			// comments, flags and obsolete entries
		} else {
			const m = line.match(/^(msgctxt|msgid|msgstr)\s+(".*")$/);
			if (m) {
				field = m[1];
				entry[field] = unquote(m[2]);
			} else if (field && line.startsWith('"')) {
				entry[field] += unquote(line);
			}
		}
	}
	flush();
	return entries;
}

const clip = (s) => {
	const one = s.replace(/\s+/g, " ");
	return one.length > 100 ? `${one.slice(0, 97)}...` : one;
};

const totals = new Map(
	locales.filter((l) => l !== sourceLocale).map((l) => [l, 0]),
);
for (const catalog of catalogs) {
	const source = readPo(catalog.file(sourceLocale));
	for (const locale of totals.keys()) {
		const target = readPo(catalog.file(locale));
		const missing = [];
		for (const [key, { text, ref }] of source) {
			if (!text) continue;
			if (!target.get(key)?.text) missing.push({ key, ref });
		}
		totals.set(locale, totals.get(locale) + missing.length);
		if (missing.length === 0) continue;
		const title = `${locale}: ${missing.length} missing in ${catalog.dir}`;
		console.log(inCI ? `::group::${title}` : `\n${title}`);
		for (const { key, ref } of missing) {
			console.log(`  ${clip(key)}${ref ? `  (${ref})` : ""}`);
		}
		if (inCI) console.log("::endgroup::");
	}
}

const incomplete = [...totals].filter(([, n]) => n > 0);
console.log("\nMissing translations per locale:");
for (const [locale, n] of totals) console.log(`  ${locale.padEnd(6)} ${n}`);
if (incomplete.length === 0) {
	console.log("Every locale has every message English has.");
	process.exit(0);
}
const summary = `Missing translations: ${incomplete.map(([l, n]) => `${l} ${n}`).join(", ")}.`;
if (strict) {
	console.log(`${inCI ? "::error::" : ""}${summary}`);
	process.exit(1);
}
console.log(`${inCI ? "::warning::" : ""}${summary}`);
