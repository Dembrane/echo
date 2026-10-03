import { existsSync, readFileSync, writeFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import {
	type Browser,
	type BrowserContext,
	expect,
	type Page,
	test,
} from "@playwright/test";
import { REPORT } from "./grammar.global-setup";
import { type AuditResult, type Finding, grammarAudit } from "./grammar-checks";

// The design grammar, checked on the rendered page: axe (WCAG 2.1 AA) plus the
// rules in grammar-checks.ts, on ten routes at 1280 and 390 wide. Run it with
// `pnpm test:grammar` (e2e/grammar.config.ts); it skips itself in the default
// e2e run and when the GRAMMAR_E2E_* login is not set.

const EMAIL = process.env.GRAMMAR_E2E_EMAIL ?? "";
const PASSWORD = process.env.GRAMMAR_E2E_PASSWORD ?? "";
const WS = process.env.GRAMMAR_E2E_WORKSPACE_ID ?? "";
const PID = process.env.GRAMMAR_E2E_PROJECT_ID ?? "";
const configured = Boolean(EMAIL && PASSWORD && WS && PID);

type Route = {
	name: string;
	path: string;
	auth: boolean;
	/** Open this route, then follow the first link matching the pattern. */
	follow?: RegExp;
};
const project = `/en-US/w/${WS}/projects/${PID}`;
const ROUTES: Route[] = [
	{ auth: false, name: "login", path: "/en-US/login" },
	{ auth: true, name: "projects home", path: `/en-US/w/${WS}/home` },
	{ auth: true, name: "project home", path: `${project}/home` },
	{ auth: true, name: "conversations", path: `${project}/conversations` },
	{
		auth: true,
		follow: /\/conversations\/[0-9a-f-]{8,}/,
		name: "one conversation",
		path: `${project}/conversations`,
	},
	{ auth: true, name: "new chat", path: `${project}/chats/new` },
	{ auth: true, name: "portal editor", path: `${project}/portal-editor` },
	{ auth: true, name: "create project", path: `/en-US/w/${WS}/projects/new` },
	{ auth: true, name: "report", path: `${project}/report` },
	{ auth: true, name: "map", path: `${project}/map` },
];
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21aa"];

type RouteReport = {
	project: string;
	route: string;
	url: string;
	hard: Finding[];
	soft: Finding[];
	counts: Record<string, number>;
	axe: { id: string; impact: string | null; nodes: number; help: string }[];
	skipped?: string;
};
const reports: RouteReport[] = [];

let storageState: Awaited<ReturnType<BrowserContext["storageState"]>> | null =
	null;

async function logIn(browser: Browser) {
	const ctx = await browser.newContext();
	const page = await ctx.newPage();
	await page.goto("/en-US/login");
	await page.getByTestId("auth-login-email-input").fill(EMAIL);
	await page.getByTestId("auth-login-password-input").fill(PASSWORD);
	await page.getByTestId("auth-login-submit-button").click();
	await page.waitForURL(/\/(o|onboarding|w)\b/, { timeout: 20_000 });
	storageState = await ctx.storageState();
	await ctx.close();
}

// Let the route finish loading: network quiet, skeletons and loaders gone.
async function settle(page: Page) {
	await page
		.waitForLoadState("networkidle", { timeout: 15_000 })
		.catch(() => {});
	await page
		.waitForFunction(
			() =>
				!document.querySelector(
					".mantine-Skeleton-root, .mantine-Loader-root, .mantine-LoadingOverlay-root",
				),
			undefined,
			{ timeout: 10_000 },
		)
		.catch(() => {});
	await page.evaluate(() => document.fonts.ready);
	await page.waitForTimeout(300);
}

test.describe("design grammar", () => {
	// biome-ignore lint/correctness/noEmptyPattern: Playwright needs a destructured fixtures argument.
	test.beforeEach(({}, info) => {
		test.skip(
			!info.project.name.startsWith("grammar"),
			"runs only under e2e/grammar.config.ts",
		);
		test.skip(
			!configured,
			"set GRAMMAR_E2E_EMAIL, GRAMMAR_E2E_PASSWORD, GRAMMAR_E2E_WORKSPACE_ID and GRAMMAR_E2E_PROJECT_ID",
		);
	});

	test.afterAll(() => {
		if (!reports.length) return;
		const previous: RouteReport[] = existsSync(REPORT)
			? JSON.parse(readFileSync(REPORT, "utf8")).routes
			: [];
		const routes = [...previous, ...reports];
		const totals: Record<string, number> = {};
		for (const r of routes)
			for (const [rule, n] of Object.entries(r.counts))
				totals[rule] = (totals[rule] ?? 0) + n;
		writeFileSync(REPORT, `${JSON.stringify({ routes, totals }, null, 2)}\n`);
		reports.length = 0;
	});

	for (const route of ROUTES) {
		test(route.name, async ({ browser }, info) => {
			const phone = info.project.name.endsWith("phone");
			if (route.auth && !storageState) await logIn(browser);
			const viewport = info.project.use.viewport ?? {
				height: 800,
				width: 1280,
			};
			const ctx = await browser.newContext({
				baseURL: info.project.use.baseURL,
				hasTouch: info.project.use.hasTouch,
				isMobile: info.project.use.isMobile,
				storageState: route.auth ? (storageState ?? undefined) : undefined,
				viewport,
			});
			const page = await ctx.newPage();
			const report: RouteReport = {
				axe: [],
				counts: {},
				hard: [],
				project: info.project.name,
				route: route.name,
				soft: [],
				url: "",
			};
			try {
				await page.goto(route.path);
				await settle(page);
				if (route.follow) {
					const pattern = route.follow.source;
					const href = await page.evaluate(
						(src) =>
							[...document.querySelectorAll("a[href]")]
								.map((a) => a.getAttribute("href") ?? "")
								.find((h) => new RegExp(src).test(h)) ?? null,
						pattern,
					);
					if (!href) {
						report.skipped = "no conversation row to open";
						reports.push(report);
						test.skip(true, "no conversation row to open in this project");
						return;
					}
					await page.goto(href);
					await settle(page);
				}
				report.url = page.url();

				// Accessibility: serious and critical fail, the rest are reported.
				const axe = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
				for (const v of axe.violations) {
					report.axe.push({
						help: v.help,
						id: v.id,
						impact: v.impact ?? null,
						nodes: v.nodes.length,
					});
					const finding = {
						detail: `${v.help} (${v.nodes.length} nodes): ${v.nodes
							.slice(0, 3)
							.map((n) => n.target.join(" "))
							.join(", ")}`,
						rule: `axe.${v.id}`,
						target: v.helpUrl,
					};
					if (v.impact === "serious" || v.impact === "critical")
						report.hard.push(finding);
					else report.soft.push(finding);
				}

				// The grammar.
				const audit: AuditResult = await page.evaluate(grammarAudit, {
					phone,
					portal: !/\/w\//.test(new URL(page.url()).pathname),
				});
				report.hard.push(...audit.hard);
				report.soft.push(...audit.soft);
				report.counts = audit.counts;
				for (const f of report.hard.concat(report.soft))
					if (f.rule.startsWith("axe."))
						report.counts[f.rule] = (report.counts[f.rule] ?? 0) + 1;

				// Rule 03 (soft, a taste call): hover lifts a pressable card to white.
				if (!phone) {
					const card = page
						.locator(".app-do:not([data-selected]):visible")
						.first();
					if (await card.count()) {
						await card.hover();
						await page.waitForTimeout(250);
						const bg = await card.evaluate(
							(el) => getComputedStyle(el).backgroundColor,
						);
						if (bg !== "rgb(255, 255, 255)") {
							report.soft.push({
								detail: `hovered .app-do is ${bg}, not white`,
								rule: "rule03",
								target: ".app-do",
							});
							report.counts.rule03 = (report.counts.rule03 ?? 0) + 1;
						}
					}
				}
			} finally {
				if (!report.skipped) reports.push(report);
				await ctx.close();
			}

			for (const f of report.soft)
				info.annotations.push({
					description: `${f.rule} ${f.target}: ${f.detail}`,
					type: "soft",
				});
			const listing = report.hard
				.map((f) => `  ${f.rule}  ${f.target}  ${f.detail}`)
				.join("\n");
			expect(
				report.hard,
				`${route.name} at ${viewport.width}px:\n${listing}`,
			).toEqual([]);
		});
	}
});
