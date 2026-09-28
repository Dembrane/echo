#!/usr/bin/env node
// Fails when the participant portal's first load grows: the entry chunk and every chunk it
// imports statically (what the browser fetches before the start screen renders), gzipped.
// The start route is bundled into the entry (Router.tsx imports ParticipantStart eagerly);
// if it ever becomes its own chunk, that chunk and its imports are counted too.
//
// Why: the portal serves participants on phones at events, often on poor networks, and the
// CTO's rule is that dashboard work never makes it slower. Dashboard screens are lazy
// routes; this keeps it that way.
//
//   node scripts/check-portal-bundle.mjs              build into a temp dir, then check
//   node scripts/check-portal-bundle.mjs --dist dist  check an existing `vite build --manifest`
//
// Raising the budget is a decision, not a fix: change BASELINE_GZIP_BYTES in the same PR
// and say why in its description.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

/** Measured on feat/bun-migration at c9a3e48c (2026-09-28), before the accounts screens. */
const BASELINE_GZIP_BYTES = 1_603_594;
/** Room for ordinary drift (a few strings, a small fix) before the check objects. */
const MARGIN_BYTES = 8 * 1024;
const START_ROUTE = "src/routes/participant/ParticipantStart.tsx";
/** Code that must only ever load on the screens that use it. */
const FORBIDDEN = [
	["pdf.js", "GlobalWorkerOptions"],
	["the signature script font", "Dancing Script"],
];

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const distArg = process.argv.indexOf("--dist");
let dist;
let cleanup = null;
if (distArg > -1) {
	dist = path.resolve(process.argv[distArg + 1]);
} else {
	dist = mkdtempSync(path.join(tmpdir(), "portal-bundle-"));
	cleanup = dist;
	execFileSync(
		path.join(root, "node_modules/.bin/vite"),
		[
			"build",
			"--manifest",
			"--outDir",
			dist,
			"--emptyOutDir",
			"--logLevel",
			"warn",
		],
		{ cwd: root, stdio: "inherit" },
	);
}

try {
	const manifest = JSON.parse(
		readFileSync(path.join(dist, ".vite/manifest.json"), "utf8"),
	);
	const seen = new Set();
	const visit = (key) => {
		const chunk = manifest[key];
		if (!chunk || seen.has(chunk.file)) return;
		seen.add(chunk.file);
		for (const dep of chunk.imports ?? []) visit(dep);
	};
	visit("index.html");
	if (manifest[START_ROUTE] && !manifest[START_ROUTE].isEntry)
		visit(START_ROUTE);

	let raw = 0;
	let gzip = 0;
	const rows = [];
	const problems = [];
	for (const file of [...seen].filter((f) => f.endsWith(".js"))) {
		const bytes = readFileSync(path.join(dist, file));
		const gz = gzipSync(bytes, { level: 9 }).length;
		raw += bytes.length;
		gzip += gz;
		rows.push(`  ${file}  ${bytes.length} raw, ${gz} gzip`);
		const text = bytes.toString("utf8");
		for (const [what, marker] of FORBIDDEN) {
			if (text.includes(marker))
				problems.push(`${what} is in the first load (${file})`);
		}
	}
	const budget = BASELINE_GZIP_BYTES + MARGIN_BYTES;
	const delta = gzip - BASELINE_GZIP_BYTES;
	console.log("Portal first-load JS:");
	console.log(rows.join("\n"));
	console.log(
		`  total ${raw} raw, ${gzip} gzip (baseline ${BASELINE_GZIP_BYTES}, ${delta >= 0 ? "+" : ""}${delta}; budget ${budget})`,
	);
	if (gzip > budget)
		problems.push(
			`first load is ${gzip} bytes gzipped, over the budget of ${budget}`,
		);
	if (problems.length) {
		for (const p of problems) console.error(`::error::${p}`);
		console.error(
			"Make the new code a lazy route or a dynamic import, so the portal does not load it.",
		);
		process.exitCode = 1;
	}
} finally {
	if (cleanup) rmSync(cleanup, { force: true, recursive: true });
}
