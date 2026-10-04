import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import {
	type Browser,
	type BrowserContext,
	expect,
	type Page,
	test,
} from "@playwright/test";
import { type Flow, flows, type State } from "./flows";
import { CACHE, REPORT } from "./grammar.global-setup";
import { type AuditResult, type Finding, grammarAudit } from "./grammar-checks";
import { routerPaths } from "./routes";

// The design grammar, checked on the rendered page: axe (WCAG 2.1 AA) plus the
// rules in grammar-checks.ts, on every page in the flow map (e2e/flows.ts) and
// every state it lists, at 1280 and 390 wide. Run it with `pnpm test:grammar`
// (e2e/grammar.config.ts); it skips itself in the default e2e run and when the
// login below is not set. Settings, all GRAMMAR_E2E_*:
//   EMAIL, PASSWORD, WORKSPACE_ID, PROJECT_ID   the owner and the demo (required)
//   ORG_ID           the demo's organisation (organisation and signing pages)
//   OWN_WORKSPACE_ID a workspace of the login's own for the empty project
//   STAFF_EMAIL, STAFF_PASSWORD   a dembrane admin, for /admin
//   MEMBER_EMAIL, MEMBER_PASSWORD a plain member of the demo workspace
//   ONLY=a,b         only the flows whose path contains one of these
//   REPORT_ONLY=1    write the report without failing any page
//   SHOTS=dir        keep a screenshot of every page and state in dir/<width>/
// Pages whose setting is missing are skipped, and the report says why.

const env = (name: string) => process.env[`GRAMMAR_E2E_${name}`] ?? "";
const LOGINS = {
	member: { email: env("MEMBER_EMAIL"), password: env("MEMBER_PASSWORD") },
	owner: { email: env("EMAIL"), password: env("PASSWORD") },
	staff: { email: env("STAFF_EMAIL"), password: env("STAFF_PASSWORD") },
};
const configured = Boolean(
	LOGINS.owner.email &&
		LOGINS.owner.password &&
		env("WORKSPACE_ID") &&
		env("PROJECT_ID"),
);
// A folder to keep a full-page screenshot of every page and state in (the daily run's artifact).
const SHOTS = env("SHOTS");
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21aa"];
const UUID = "[0-9a-f-]{36}";
const EMPTY_PROJECT = "Grammar check (empty)";

// ---------- fixtures: the ids a flow's params name ----------

// A fixture is set in the environment, or found by opening a page and taking
// the first link that matches (the demo data decides what exists). One that
// can't be found skips the flows that need it, and the report says so.
// A fixture the demo lacks and the API can make (a chat, a presentation) is
// made once, as the owner, the first time a flow needs it.
const FIXTURES: Record<
	string,
	{
		env?: string;
		from?: string;
		link?: RegExp;
		/** Only a link whose text contains this. */
		text?: string;
		/** An API list to take the first item's id from (`{ chats: [...] }`). */
		get?: string;
		make?: { post: string; body?: Record<string, string> };
	}
> = {
	$canvas: {
		from: "/w/$workspace/projects/$project/library",
		link: new RegExp(`/canvases/(${UUID})`),
	},
	// On the empty project, so the shared demo gains no chats.
	$chat: {
		get: "/api/v2/bff/chats?project_id=$emptyProject",
		make: {
			body: { project_id: "$emptyProject" },
			post: "/api/v2/bff/chats",
		},
	},
	$conversation: {
		from: "/w/$workspace/projects/$project/conversations",
		link: new RegExp(`/conversations/(${UUID})`),
	},
	$demo: {
		from: "/admin/accounts",
		link: new RegExp(`/admin/accounts/demos/(${UUID})`),
	},
	$doc: {
		env: "DOC_ID",
		from: "/o/$org/account",
		link: new RegExp(`/documents/(${UUID})`),
	},
	// A project with nothing in it, for the empty states, in the check's own
	// workspace so the demo the other sessions share stays as it is.
	$emptyProject: {
		from: "/w/$ownWorkspace/home",
		link: new RegExp(`/projects/(${UUID})`),
		make: {
			body: { language: "en", name: EMPTY_PROJECT },
			post: "/api/v2/workspaces/$ownWorkspace/projects",
		},
		text: EMPTY_PROJECT,
	},
	$org: { env: "ORG_ID", from: "/o", link: new RegExp(`/o/(${UUID})`) },
	$ownWorkspace: { env: "OWN_WORKSPACE_ID" },
	$presentation: {
		make: { post: "/api/v2/bff/present/projects/$project/default" },
	},
	$project: { env: "PROJECT_ID" },
	$recipe: {
		from: "/w/$workspace/projects/$project/analysis/recipes",
		link: new RegExp(`/analysis/recipes/(${UUID})`),
	},
	$workspace: { env: "WORKSPACE_ID" },
};
const cache: {
	found: Record<string, string | null>;
	sessions: Partial<
		Record<
			"owner" | "staff" | "member",
			Awaited<ReturnType<BrowserContext["storageState"]>>
		>
	>;
} = existsSync(CACHE)
	? JSON.parse(readFileSync(CACHE, "utf8"))
	: { found: {}, sessions: {} };
const save = () => writeFileSync(CACHE, JSON.stringify(cache));
const { found, sessions } = cache;
// Fixtures are looked up signed in as the owner, whoever the visit is for.
let finder: Page | null = null;

async function fixture(page: Page, name: string): Promise<string | null> {
	if (name in found) return found[name];
	const def = FIXTURES[name];
	let id: string | null = def?.env ? env(def.env) || null : null;
	if (!id && def?.from && def.link) {
		const from = await fillWith(page, def.from);
		if (from) {
			await page.goto(`/en-US${from}`);
			await settle(page);
			id = await page.evaluate(
				({ src, text }) =>
					[...document.querySelectorAll("a[href]")]
						.filter((a) => !text || a.textContent?.includes(text))
						.map((a) => a.getAttribute("href") ?? "")
						.map((h) => new RegExp(src).exec(h)?.[1])
						.find(Boolean) ?? null,
				{ src: def.link.source, text: def.text },
			);
		}
	}
	// fetch needs the app's origin and its session cookie.
	const atApp = async () => {
		if (!page.url().startsWith("http")) await page.goto("/en-US/o");
	};
	if (!id && def?.get) {
		const url = await fillWith(page, def.get);
		await atApp();
		if (url)
			id = await page.evaluate(async (url) => {
				const res = await fetch(url, { credentials: "include" });
				if (!res.ok) return null;
				const body = await res.json();
				const list = Array.isArray(body)
					? body
					: (Object.values(body).find(Array.isArray) ?? []);
				return list[0]?.id ?? null;
			}, url);
	}
	if (!id && def?.make) {
		const post = await fillWith(page, def.make.post);
		const body: Record<string, string> = {};
		for (const [k, v] of Object.entries(def.make.body ?? {}))
			body[k] = (await fillWith(page, v)) ?? v;
		await atApp();
		if (post)
			id = await page.evaluate(
				async ({ post, body }) => {
					const res = await fetch(post, {
						body: JSON.stringify(body),
						credentials: "include",
						headers: { "Content-Type": "application/json" },
						method: "POST",
					});
					return res.ok ? ((await res.json()).id ?? null) : null;
				},
				{ body, post },
			);
	}
	found[name] = id;
	save();
	return id;
}

// "$name" fixtures in a path, filled; null when one can't be found.
async function fillWith(page: Page, path: string): Promise<string | null> {
	let out = path;
	for (const name of path.match(/\$\w+/g) ?? []) {
		const id = await fixture(page, name);
		if (!id) return null;
		out = out.replace(name, id);
	}
	return out;
}

async function fill(browser: Browser, baseURL: string, path: string) {
	if (!path.includes("$")) return path;
	if (!finder) {
		if (!sessions.owner) await logIn(browser, "owner", baseURL);
		const ctx = await browser.newContext({
			baseURL,
			storageState: sessions.owner,
		});
		finder = await ctx.newPage();
	}
	return fillWith(finder, path);
}

// ---------- visits: a flow, one value per list param ----------

type Visit = {
	key: string;
	flow: Flow;
	/** The route with its params as fixture names or literals. */
	path: string;
	portal: boolean;
	role: "owner" | "staff" | "member";
	name: string;
};

function visits(): Visit[] {
	const portal = new Set(
		routerPaths()
			.filter((r) => r.router === "portal")
			.map((r) => r.path),
	);
	const only = env("ONLY");
	const out: Visit[] = [];
	for (const [key, flow] of Object.entries(flows)) {
		if (only && !only.split(",").some((o) => key.includes(o))) continue;
		for (const variant of [
			{ name: "", params: {} },
			...(flow.variants ?? []),
		]) {
			let paths = [key];
			const params = { ...flow.params, ...variant.params };
			for (const [param, value] of Object.entries(params)) {
				const token = param === "*" ? "*" : `:${param}`;
				paths = paths.flatMap((p) =>
					(Array.isArray(value) ? value : [value]).map((v) =>
						p.replace(token, v),
					),
				);
			}
			// The empty project is in the owner's own workspace: owner only.
			for (const role of variant.name
				? ["owner" as const]
				: (flow.roles ?? ["owner"]))
				for (const path of paths)
					out.push({
						flow,
						key,
						name: `${path}${role === "owner" ? "" : ` as ${role}`}${variant.name ? ` (${variant.name})` : ""}`,
						path: path.replace(/\/$/, "") || "/",
						portal: portal.has(key),
						role,
					});
		}
	}
	return out;
}

// ---------- the page ----------

// Logs in once per role. A new browser meets the one-browser rule: when the
// account is signed in elsewhere, log in here anyway.
async function logIn(browser: Browser, role: Visit["role"], baseURL?: string) {
	// One browser per account: a second login as the same person would sign the
	// first one out (a preview's admin is both owner and staff).
	const same = (Object.keys(sessions) as Visit["role"][]).find(
		(r) => sessions[r] && LOGINS[r].email === LOGINS[role].email,
	);
	if (same) {
		sessions[role] = sessions[same];
		return;
	}
	const ctx = await browser.newContext({ baseURL });
	const page = await ctx.newPage();
	await page.goto("/en-US/login");
	await page.getByTestId("auth-login-email-input").fill(LOGINS[role].email);
	await page
		.getByTestId("auth-login-password-input")
		.fill(LOGINS[role].password);
	await page.getByTestId("auth-login-submit-button").click();
	const elsewhere = page.getByTestId("auth-login-elsewhere-confirm");
	const signedIn = /\/(o|onboarding|w|admin)\b/;
	await Promise.race([
		page.waitForURL(signedIn, { timeout: 20_000 }),
		elsewhere.waitFor({ timeout: 20_000 }).then(() => elsewhere.click()),
	]).catch(() => {});
	await page.waitForURL(signedIn, { timeout: 20_000 });
	sessions[role] = await ctx.storageState();
	save();
	await ctx.close();
}

// Let the page finish loading: network quiet, loaders and skeletons gone.
async function settle(page: Page) {
	// Pages that poll never go quiet; the loaders below are the real signal.
	await page
		.waitForLoadState("networkidle", { timeout: 4_000 })
		.catch(() => {});
	await page
		.waitForFunction(
			() =>
				!document.querySelector(
					'.mantine-Skeleton-root, .mantine-Loader-root, .mantine-LoadingOverlay-root, [aria-busy="true"], [class*="stageHost"]',
				),
			undefined,
			{ timeout: 10_000 },
		)
		.catch(() => {});
	await page.evaluate(() => document.fonts.ready);
	await page.waitForTimeout(300);
}

type Check = {
	hard: Finding[];
	soft: Finding[];
	counts: Record<string, number>;
	axe: { id: string; impact: string | null; nodes: number; help: string }[];
};

async function check(page: Page, phone: boolean, portal: boolean) {
	const out: Check = { axe: [], counts: {}, hard: [], soft: [] };
	// Accessibility: serious and critical fail, the rest are reported.
	const axe = await new AxeBuilder({ page })
		.withTags(AXE_TAGS)
		// The audience deck's own look, previewed in the present editor.
		.exclude('[data-testid="present-preview-stage"]')
		.analyze();
	for (const v of axe.violations) {
		out.axe.push({
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
		(v.impact === "serious" || v.impact === "critical"
			? out.hard
			: out.soft
		).push(finding);
		out.counts[finding.rule] = (out.counts[finding.rule] ?? 0) + 1;
	}

	// The grammar.
	const audit: AuditResult = await page.evaluate(grammarAudit, {
		phone,
		portal,
	});
	out.hard.push(...audit.hard);
	out.soft.push(...audit.soft);
	for (const [rule, n] of Object.entries(audit.counts))
		out.counts[rule] = (out.counts[rule] ?? 0) + n;

	// Rule 03 (soft, a taste call): hover lifts a pressable card to white.
	if (!phone) {
		const card = page.locator(".app-do:not([data-selected]):visible").first();
		// A dialog over the page takes the pointer; then there is nothing to hover.
		if (
			(await card.count()) &&
			(await card
				.hover({ timeout: 2_000 })
				.then(() => true)
				.catch(() => false))
		) {
			await page.waitForTimeout(250);
			const bg = await card.evaluate(
				(el) => getComputedStyle(el).backgroundColor,
			);
			if (bg !== "rgb(255, 255, 255)") {
				out.soft.push({
					detail: `hovered .app-do is ${bg}, not white`,
					rule: "rule03",
					target: ".app-do",
				});
				out.counts.rule03 = (out.counts.rule03 ?? 0) + 1;
			}
		}
	}
	return out;
}

// ---------- the report: one row per flow, state and viewport ----------

type Row = Check & {
	flow: string;
	visit: string;
	state: string;
	project: string;
	url: string;
	skipped?: string;
};
const rows: Row[] = [];
const empty = (): Check => ({ axe: [], counts: {}, hard: [], soft: [] });

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
		if (!rows.length) return;
		const previous: Row[] = existsSync(REPORT)
			? JSON.parse(readFileSync(REPORT, "utf8")).rows
			: [];
		const all = [...previous, ...rows];
		const totals: Record<string, number> = {};
		for (const r of all)
			for (const [rule, n] of Object.entries(r.counts))
				totals[rule] = (totals[rule] ?? 0) + n;
		const skipped = all.filter((r) => r.skipped).length;
		writeFileSync(
			REPORT,
			`${JSON.stringify({ checked: all.length - skipped, rows: all, skipped, totals }, null, 2)}\n`,
		);
		rows.length = 0;
	});

	for (const visit of visits()) {
		test(visit.name, async ({ browser }, info) => {
			test.setTimeout(60_000 + 30_000 * (visit.flow.states?.length ?? 0));
			const phone = info.project.name.endsWith("phone");
			const viewport = info.project.use.viewport ?? {
				height: 800,
				width: 1280,
			};
			const row = (state: string, url: string, c: Check, skipped?: string) =>
				rows.push({
					...c,
					flow: visit.key,
					project: info.project.name,
					skipped,
					state,
					url,
					visit: visit.name,
				});
			if (visit.flow.skip) {
				row("page", "", empty(), visit.flow.skip);
				test.skip(true, visit.flow.skip);
				return;
			}
			if (
				visit.flow.viewports &&
				!visit.flow.viewports.includes(phone ? "phone" : "desktop")
			) {
				test.skip(true, "not at this width");
				return;
			}
			if (!LOGINS[visit.role].email) {
				row("page", "", empty(), `no ${visit.role} login configured`);
				test.skip(true, `set GRAMMAR_E2E_${visit.role.toUpperCase()}_EMAIL`);
				return;
			}
			const signedIn = !visit.portal && visit.flow.auth !== false;
			const base = info.project.use.baseURL ?? "http://localhost:5189";
			if (signedIn && !sessions[visit.role])
				await logIn(browser, visit.role, base);
			const ctx = await browser.newContext({
				baseURL: base,
				hasTouch: info.project.use.hasTouch,
				isMobile: info.project.use.isMobile,
				storageState: signedIn ? sessions[visit.role] : undefined,
				viewport,
			});
			const page = await ctx.newPage();
			const checks: [string, Check][] = [];
			try {
				const path = await fill(browser, base, visit.path);
				if (!path) {
					const missing = visit.path.match(/\$\w+/g)?.join(", ");
					row("page", "", empty(), `no ${missing} in the demo data`);
					test.skip(true, `no ${missing} in the demo data`);
					return;
				}
				// The portal answers on a portal.* host.
				const origin = visit.portal ? base.replace("://", "://portal.") : base;
				const url = `${origin}/en-US${path === "/" ? "" : path}`;
				const states: State[] = [
					{ clicks: [], name: "page" },
					...(visit.flow.states ?? []),
				];
				eachState: for (const state of states) {
					await page.goto(url);
					await settle(page);
					for (const id of state.clicks) {
						// A trigger can be missing (no data, no permission, a narrow
						// layout); the report says so and the next state runs.
						const trigger = page.getByTestId(id).first();
						if (
							!(await trigger
								.waitFor({ timeout: 5_000 })
								.then(() => true)
								.catch(() => false))
						) {
							row(state.name, page.url(), empty(), `no ${id} on the page`);
							continue eachState;
						}
						await trigger.click();
						await settle(page);
					}
					if (SHOTS) {
						const file = join(
							SHOTS,
							info.project.name.replace("grammar-", ""),
							`${visit.name.replace(/[^\w$-]+/g, "_").replace(/^_|_$/g, "") || "root"}--${state.name.replace(/\W+/g, "-")}.png`,
						);
						mkdirSync(dirname(file), { recursive: true });
						await page.screenshot({ fullPage: true, path: file });
					}
					const c = await check(page, phone, visit.portal);
					row(state.name, page.url(), c);
					checks.push([state.name, c]);
				}
			} finally {
				await ctx.close();
			}

			for (const [state, c] of checks)
				for (const f of c.soft)
					info.annotations.push({
						description: `${state}: ${f.rule} ${f.target}: ${f.detail}`,
						type: "soft",
					});
			const listing = checks
				.flatMap(([state, c]) =>
					c.hard.map((f) => `  ${state}  ${f.rule}  ${f.target}  ${f.detail}`),
				)
				.join("\n");
			// A survey run records everything and fails nothing, so Playwright
			// keeps one worker instead of starting a new one per failing page.
			if (env("REPORT_ONLY")) return;
			expect(
				checks.flatMap(([, c]) => c.hard),
				`${visit.name} at ${viewport.width}px:\n${listing}`,
			).toEqual([]);
		});
	}
});
