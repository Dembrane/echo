#!/usr/bin/env node
// Paths must mean the same file on a Mac (case-insensitive) as on Linux (CI,
// the images). Fails when:
//   1. two tracked paths differ only by case: a Mac checkout keeps one of them;
//   2. two modules in one folder differ only by case, extension aside
//      (TasksPrompt.tsx beside tasksPrompt.ts): an import without an extension
//      can open the wrong one on a Mac;
//   3. an import resolves on a Mac to a different file than on Linux, or only
//      on a Mac (its case differs from the file's).
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const frontend = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], {
	cwd: frontend,
})
	.toString()
	.trim();
// Unique: during a merge, an unresolved file is listed once per stage.
const tracked = [
	...new Set(
		execFileSync("git", ["ls-files", "-z"], { cwd: repo })
			.toString()
			.split("\0")
			.filter(Boolean),
	),
];

const problems = [];

// 1 and 2: the tracked tree.
const byFolded = new Map();
const byModule = new Map();
const MODULE = /\.(m?[jt]sx?|json)$/;
for (const file of tracked) {
	const folded = file.toLowerCase();
	if (byFolded.has(folded)) {
		problems.push(
			`same path but for case: ${byFolded.get(folded)} and ${file}`,
		);
	} else {
		byFolded.set(folded, file);
	}
	if (!MODULE.test(file) || /\.d\.ts$/.test(file)) continue;
	const stem = file.replace(MODULE, "");
	const key = stem.toLowerCase();
	const seen = byModule.get(key) ?? new Set();
	seen.add(stem);
	byModule.set(key, seen);
}
for (const stems of byModule.values()) {
	if (stems.size > 1) {
		problems.push(
			`modules differ only by case: ${[...stems].join(" and ")} (rename one)`,
		);
	}
}

// 3: every import in the frontend, resolved twice. Vite's extension order.
const EXTENSIONS = [".mjs", ".js", ".mts", ".ts", ".jsx", ".tsx", ".json"];
const listing = new Map();
const entries = (dir) => {
	if (!listing.has(dir)) {
		let names = [];
		try {
			names = readdirSync(dir);
		} catch {}
		listing.set(dir, names);
	}
	return listing.get(dir);
};
// The real path of `p` on a case-insensitive disk, or null.
const matchFolded = (p) => {
	const parts = path.relative(repo, p).split(path.sep);
	let at = repo;
	for (const part of parts) {
		const hit = entries(at).find((n) => n.toLowerCase() === part.toLowerCase());
		if (!hit) return null;
		at = path.join(at, hit);
	}
	return at;
};
const isFile = (p) => {
	try {
		return statSync(p).isFile();
	} catch {
		return false;
	}
};
const resolve = (base, folded) => {
	const exists = folded
		? (p) => {
				const real = matchFolded(p);
				return real && isFile(real) ? real : null;
			}
		: (p) =>
				entries(path.dirname(p)).includes(path.basename(p)) && isFile(p)
					? p
					: null;
	const tries = [
		base,
		...EXTENSIONS.map((e) => base + e),
		...EXTENSIONS.map((e) => path.join(base, `index${e}`)),
	];
	for (const t of tries) {
		const hit = exists(t);
		if (hit) return hit;
	}
	return null;
};

const SPECIFIER =
	/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bvi\.mock\(\s*|\brequire\(\s*)["']([^"'\n]+)["']/g;
const src = path.join(frontend, "src");
for (const file of tracked) {
	const abs = path.join(repo, file);
	if (!abs.startsWith(src + path.sep) || !/\.(m?[jt]sx?)$/.test(file)) continue;
	const text = readFileSync(abs, "utf8");
	for (const m of text.matchAll(SPECIFIER)) {
		const spec = m[1].split("?")[0];
		let base;
		if (spec.startsWith("./") || spec.startsWith("../"))
			base = path.resolve(path.dirname(abs), spec);
		else if (spec.startsWith("@/")) base = path.join(src, spec.slice(2));
		else continue;
		const linux = resolve(base, false);
		const mac = resolve(base, true);
		if (!mac) continue; // unresolved everywhere: tsc and the build report that
		const line = text.slice(0, m.index).split("\n").length;
		const where = `${path.relative(repo, abs)}:${line}`;
		if (!linux) {
			problems.push(
				`${where}: "${m[1]}" only resolves on a Mac (${path.relative(repo, mac)})`,
			);
		} else if (linux !== mac) {
			problems.push(
				`${where}: "${m[1]}" opens ${path.relative(repo, mac)} on a Mac but ${path.relative(repo, linux)} on Linux`,
			);
		}
	}
}

if (problems.length) {
	console.error(
		`Path case: ${problems.length} problem(s) a Mac and Linux would disagree on:`,
	);
	for (const p of problems) console.error(`  ${p}`);
	process.exit(1);
}
console.log(
	`Path case: ${tracked.length} paths, every import means the same file on a Mac and on Linux.`,
);
