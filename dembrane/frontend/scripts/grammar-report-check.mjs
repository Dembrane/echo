#!/usr/bin/env node
// The daily run's ratchet over test-results/grammar-report.json (e2e/grammar.spec.ts).
// The app does not pass the rendered check today, so, as scripts/check-grammar.mjs does
// for the source, this holds the number of hard findings per page, state, width and rule
// in e2e/grammar-baseline.json. A page may only go down; one that rises fails.
//
//   node scripts/grammar-report-check.mjs           fail when a page's findings rose; writes
//                                                   test-results/grammar-alert.txt for Slack
//   node scripts/grammar-report-check.mjs --update  lower the baseline to this report (never
//                                                   raises one); --write takes it as it is
//
// Without a baseline it writes test-results/grammar-baseline.proposed.json and passes: commit
// that file as e2e/grammar-baseline.json to start the ratchet.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPORT = path.join(root, "test-results/grammar-report.json");
const BASELINE = path.join(root, "e2e/grammar-baseline.json");
const ALERT = path.join(root, "test-results/grammar-alert.txt");
const args = process.argv.slice(2);

// How to fix the rules a rise is most often made of (the canon, in a line).
const FIX = {
	"axe.": "an accessibility failure: see the axe link in the report",
	"flow.": "one filled primary per view, first in its row (canon: Buttons and order)",
	"grammar.": "border shapes and line colours come from rules.css; drop local borders",
	"icon.size": "Phosphor at 20 in buttons and ActionIcons, 16 inline",
	rule05: "4 label to field, 16 field to field, 24 to the submit row, 32 between sections",
	"shape.radius": "square corners; only the primary pill and avatars are round",
	"type.size": "Mantine sizes only (xs 14, sm 16, md 18.66 ...), nothing under 14",
	"type.tracking": "no letter-spacing",
	"type.transform": "no CSS case: write the words in sentence case",
	"type.weight": "320 for text, 240 muted, 600 only inside a sentence",
};
const fixFor = (rule) =>
	Object.entries(FIX).find(([k]) => rule.startsWith(k))?.[1] ?? "";

const report = JSON.parse(readFileSync(REPORT, "utf8"));
const now = {};
const example = {};
for (const row of report.rows) {
	if (row.skipped) continue;
	const key = `${row.project.replace("grammar-", "")} · ${row.visit} · ${row.state}`;
	for (const f of row.hard) {
		now[key] ??= {};
		now[key][f.rule] = (now[key][f.rule] ?? 0) + 1;
		example[`${key} ${f.rule}`] ??= `${f.target} — ${f.detail}`.slice(0, 160);
	}
}
const write = (file, data) =>
	writeFileSync(file, `${JSON.stringify(data, null, "\t")}\n`);

if (!existsSync(BASELINE)) {
	const proposed = path.join(root, "test-results/grammar-baseline.proposed.json");
	write(proposed, now);
	console.log(`No baseline yet: wrote ${path.relative(root, proposed)}. Commit it as e2e/grammar-baseline.json.`);
	process.exit(0);
}
const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));

if (args.includes("--write") || args.includes("--update")) {
	const next = {};
	for (const key of new Set([...Object.keys(baseline), ...Object.keys(now)]))
		for (const rule of new Set([
			...Object.keys(baseline[key] ?? {}),
			...Object.keys(now[key] ?? {}),
		])) {
			const n = now[key]?.[rule] ?? 0;
			const b = baseline[key]?.[rule];
			const v = args.includes("--write") ? n : Math.min(n, b ?? n);
			if (v > 0) (next[key] ??= {})[rule] = v;
		}
	write(BASELINE, next);
	console.log("Baseline written.");
	process.exit(0);
}

const rises = [];
for (const [key, rules] of Object.entries(now))
	for (const [rule, n] of Object.entries(rules)) {
		const b = baseline[key]?.[rule] ?? 0;
		if (n > b) rises.push({ b, key, n, rule });
	}
const total = (o) =>
	Object.values(o).reduce(
		(sum, r) => sum + Object.values(r).reduce((a, n) => a + n, 0),
		0,
	);
console.log(
	`Rendered grammar: ${total(now)} hard findings, baseline ${total(baseline)}; ${rises.length} rose.`,
);
if (!rises.length) process.exit(0);

const lines = rises.slice(0, 15).map(({ b, key, n, rule }) => {
	const fix = fixFor(rule);
	return `• ${key}: *${rule}* ${b} → ${n}\n    ${example[`${key} ${rule}`]}${fix ? `\n    fix: ${fix}` : ""}`;
});
if (rises.length > 15) lines.push(`… and ${rises.length - 15} more (grammar-report.json)`);
const flows = [...new Set(rises.map((r) => r.key.split(" · ")[1]))].slice(0, 5);
const text = [
	`*Rendered grammar check rose* on ${rises.length} page states.`,
	...lines,
	`Reproduce: \`GRAMMAR_E2E_ONLY="${flows.join(",")}" pnpm test:grammar\` (settings at the top of e2e/grammar.spec.ts). If a rise is intended, \`node scripts/grammar-report-check.mjs --write\` on that report and commit the baseline.`,
].join("\n");
writeFileSync(ALERT, `${text}\n`);
console.log(text);
process.exit(1);
