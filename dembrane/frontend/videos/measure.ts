// Times how fast a project opens on one or more running dembrane environments, so release
// cards can quote before/after numbers from the same synthetic steps. See videos/README.md.
//
//   node videos/measure.ts --target prod=https://dashboard.dembrane.com/w/<ws>/projects/<id> \
//                          --target staging=https://dashboard.staging.dembrane.com/w/<ws>/projects/<id> \
//                          [--runs 20] [--locale en-US]
//
// Login per target from MEASURE_<NAME>_EMAIL / MEASURE_<NAME>_PASSWORD, or MEASURE_EMAIL /
// MEASURE_PASSWORD for all. Use a test account: the script signs in, which may end that
// account's other session. It only reads; it creates nothing.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type Browser, chromium, type Page } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));

const { values: args } = parseArgs({
	options: {
		locale: { default: "en-US", type: "string" },
		runs: { default: "20", type: "string" },
		target: { multiple: true, type: "string" },
	},
});

interface Target {
	name: string;
	origin: string;
	/** The project's path without the locale: /w/<workspace>/projects/<project>. */
	project: string;
	workspace: string;
	email: string;
	password: string;
}

const targets: Target[] = (args.target ?? []).map((t) => {
	const [name, url] = t.split(/=(.*)/s);
	const u = new URL(url);
	const m = u.pathname.match(/(\/w\/[^/]+)(\/projects\/[0-9a-f-]{36})/);
	if (!name || !m) throw new Error(`--target name=<project url>, got ${t}`);
	const env = (k: string) =>
		process.env[`MEASURE_${name.toUpperCase()}_${k}`] ??
		process.env[`MEASURE_${k}`];
	const email = env("EMAIL");
	const password = env("PASSWORD");
	if (!email || !password)
		throw new Error(
			`no login for ${name}: set MEASURE_${name.toUpperCase()}_EMAIL and _PASSWORD`,
		);
	return {
		email,
		name,
		origin: u.origin,
		password,
		project: m[1] + m[2],
		workspace: m[1],
	};
});
if (targets.length === 0) throw new Error("give at least one --target");
const runs = Number(args.runs);

// Analytics and error reporting are not the app's own requests.
const IGNORE = /posthog|sentry|google|gstatic|cloudflareinsights/;

/**
 * Watches the page's own API requests (fetch and XHR; live streams excluded) and resolves
 * with the time the last one finished, once none has been in flight for `quiet` ms.
 */
function apiSettled(page: Page, since: number, quiet = 1000): Promise<number> {
	return new Promise((resolve) => {
		const inFlight = new Set<object>();
		let last = since;
		let timer: NodeJS.Timeout;
		const arm = () => {
			clearTimeout(timer);
			if (inFlight.size === 0)
				timer = setTimeout(() => {
					page.off("request", onRequest);
					page.off("requestfinished", onDone);
					page.off("requestfailed", onDone);
					resolve(last - since);
				}, quiet);
		};
		const ours = (r: import("@playwright/test").Request) =>
			["fetch", "xhr"].includes(r.resourceType()) && !IGNORE.test(r.url());
		const onRequest = (r: import("@playwright/test").Request) => {
			if (!ours(r)) return;
			// A request still open after 10 s is a live stream, not page data.
			if (r.headers().accept?.includes("text/event-stream")) return;
			inFlight.add(r);
			clearTimeout(timer);
		};
		const onDone = (r: import("@playwright/test").Request) => {
			if (!inFlight.delete(r)) return;
			last = performance.now();
			arm();
		};
		page.on("request", onRequest);
		page.on("requestfinished", onDone);
		page.on("requestfailed", onDone);
		arm();
	});
}

async function signIn(browser: Browser, t: Target, state: string) {
	const context = await browser.newContext({
		viewport: { height: 900, width: 1440 },
	});
	const page = await context.newPage();
	await page.goto(`${t.origin}/${args.locale}/login`);
	await page.locator('input[type="email"]').first().fill(t.email);
	await page.locator('input[type="password"]').first().fill(t.password);
	await page.locator('button[type="submit"]').first().click();
	const anyway = page.getByRole("button", { name: /log in anyway/i });
	await anyway.or(page.locator("nav")).first().waitFor({ timeout: 30_000 });
	if (await anyway.isVisible()) await anyway.click();
	await page.waitForURL((u) => !u.pathname.includes("/login"), {
		timeout: 30_000,
	});
	await page.waitForTimeout(2000);
	await page.keyboard.press("Escape");
	await context.storageState({ path: state });
	await context.close();
}

interface Sample {
	/** Full page load of the project URL, until its name shows. */
	coldShown: number;
	/** ...and until the page's API requests have also finished. */
	coldReady: number;
	/** Clicking the project in the workspace's project list, until its name shows. */
	openShown: number;
	openReady: number;
}

async function sample(
	browser: Browser,
	t: Target,
	state: string,
): Promise<Sample> {
	// A fresh context each run: no cache, like opening a link in a new browser.
	const context = await browser.newContext({
		storageState: state,
		viewport: { height: 900, width: 1440 },
	});
	const page = await context.newPage();
	const projectUrl = `${t.origin}/${args.locale}${t.project}`;
	const id = t.project.split("/").pop() as string;

	let start = performance.now();
	let data = apiSettled(page, start);
	await page.goto(projectUrl);
	const heading = page.locator("main h1, main h2").first();
	await heading.waitFor({ timeout: 60_000 });
	const name = (await heading.textContent())?.trim() ?? "";
	const coldShown = performance.now() - start;
	const coldReady = Math.max(coldShown, await data);

	await page.goto(`${t.origin}/${args.locale}${t.workspace}/home`);
	const row = page.locator(`a[href*="/projects/${id}"]`).first();
	await row.waitFor({ timeout: 60_000 });
	await page.waitForTimeout(1500);
	start = performance.now();
	data = apiSettled(page, start);
	await row.click();
	await page
		.locator("main h1, main h2", { hasText: name })
		.first()
		.waitFor({ timeout: 60_000 });
	const openShown = performance.now() - start;
	const openReady = Math.max(openShown, await data);
	await context.close();
	return { coldReady, coldShown, openReady, openShown };
}

const pct = (xs: number[], p: number) => {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

const browser = await chromium.launch({
	executablePath:
		process.env.VIDEO_CHROMIUM ??
		(existsSync("/opt/pw-browsers/chromium")
			? "/opt/pw-browsers/chromium"
			: undefined),
});
const results: Record<string, Sample[]> = {};
try {
	const outDir = join(here, "out", "measure");
	mkdirSync(outDir, { recursive: true });
	for (const t of targets) {
		const state = join(outDir, `${t.name}.session.json`);
		await signIn(browser, t, state);
		results[t.name] = [];
		// One warm-up run, not counted: the first request can wake a sleeping server.
		await sample(browser, t, state);
		for (let i = 0; i < runs; i++) {
			const s = await sample(browser, t, state);
			results[t.name].push(s);
			console.log(
				`${t.name} ${i + 1}/${runs}: load ${Math.round(s.coldShown)}/${Math.round(s.coldReady)} ms, open ${Math.round(s.openShown)}/${Math.round(s.openReady)} ms`,
			);
		}
	}
	const metrics: [keyof Sample, string][] = [
		["coldShown", "Load the project page: name shown"],
		["coldReady", "Load the project page: fully loaded"],
		["openShown", "Open from the project list: name shown"],
		["openReady", "Open from the project list: fully loaded"],
	];
	const stamp = new Date().toISOString();
	const lines = [
		`# Project open times, ${stamp.slice(0, 10)}`,
		"",
		`${runs} runs per environment from one machine, after one uncounted warm-up run. Times in ms, p50 / p90.`,
		"",
		`| Step | ${targets.map((t) => t.name).join(" | ")} |`,
		`|---|${targets.map(() => "---").join("|")}|`,
		...metrics.map(
			([k, label]) =>
				`| ${label} | ${targets
					.map((t) => {
						const xs = results[t.name].map((s) => s[k]);
						return `${Math.round(pct(xs, 50))} / ${Math.round(pct(xs, 90))}`;
					})
					.join(" | ")} |`,
		),
		"",
		...targets.map((t) => `- ${t.name}: ${t.origin}${t.project}`),
	];
	const file = join(outDir, `${stamp.slice(0, 19).replace(/:/g, "")}.md`);
	writeFileSync(file, lines.join("\n"));
	writeFileSync(
		file.replace(/\.md$/, ".json"),
		JSON.stringify(
			{
				results,
				stamp,
				targets: targets.map(({ email: _e, password: _p, ...t }) => t),
			},
			null,
			"\t",
		),
	);
	console.log(`\n${lines.join("\n")}\n\n${file}`);
} finally {
	await browser.close();
}
