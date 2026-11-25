import { appendFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { grammarAudit } from "./grammar-checks";

// A support access request seen from both sides. The customer: the consent dialog over
// Home with and without a note, with a long note and a long workspace name, the request in
// the inbox, and the approve confirmation in workspace settings it sits beside. Staff:
// "Support access" on the account page, under Tasks, with a workspace in each state, a
// row's menu, the note modal, and an organisation without workspaces. At desktop and phone
// width. E2E_SHOTS=<dir> saves screenshots as <screen>-<state>-<width>-<locale>.png.
const shots = process.env.E2E_SHOTS;
// E2E_GRAMMAR=<file> also runs the rendered design-grammar audit on every screen shot here
// and appends its findings to that file, one JSON line per screen.
const grammarLog = process.env.E2E_GRAMMAR;
const sizes = [
	{ height: 900, name: "desktop", width: 1280 },
	{ height: 844, name: "phone", width: 390 },
];
const LANGS = ["en-US", "nl-NL"];

const NOTE =
	"We would like to look at why the report of your residents evening does not load.";
// About 400 characters, ending on a full sentence: the dialog shows a note whole.
const LONG_NOTE = `${"We saw the report for the residents evening fail to load three times this week, and your colleague asked us to look. ".repeat(3)}Could we open it with you tomorrow morning? Thank you.`;
const LONG_WORKSPACE =
	"Wijkpanels Lindenwijk, Oosterpark en Havenkwartier 2026-2027".slice(0, 60);

const hoursAgo = (h: number) =>
	new Date(Date.now() - h * 3_600_000).toISOString();

async function shoot(
	page: Page,
	name: string,
	size: (typeof sizes)[number],
	lang: string,
) {
	if (shots)
		await page.screenshot({
			path: `${shots}/${name}-${size.width}-${lang}.png`,
		});
	if (grammarLog) {
		const audit = await page.evaluate(grammarAudit, {
			phone: size.name === "phone",
			portal: false,
		});
		appendFileSync(
			grammarLog,
			`${JSON.stringify({ lang, name, size: size.name, ...audit })}\n`,
		);
	}
}

const noSideScroll = async (page: Page) =>
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth,
		),
	).toBe(true);

/** The customer's side: Home, the inbox and the request, with the given note and name. */
async function answerCustomerApi(
	page: Page,
	opts: { message: string | null; workspaceName: string },
) {
	const requests = [
		{
			created_at: hoursAgo(2),
			expires_at: new Date(Date.now() + 6 * 86_400_000).toISOString(),
			id: "r1",
			message: opts.message,
			requested_by_name: "Robin de Vries",
		},
	];
	await page.route("**/v2/workspaces/w1/support-access/requests", (route) =>
		route.fulfill({ json: { requests } }),
	);
	await page.route("**/v2/workspaces/w1/support-access/events**", (route) =>
		route.fulfill({
			json: {
				events: [
					{
						actor_name: "Robin de Vries",
						created_at: hoursAgo(2),
						event_code: "request_created",
						id: "e1",
						params: {},
						staff_name: "Robin de Vries",
					},
				],
				has_more: false,
			},
		}),
	);
	await page.route("**/v2/me/notifications", (route) =>
		route.fulfill({
			json: [
				{
					action: "NAVIGATE_WORKSPACE_SETTINGS",
					actor_avatar: null,
					actor_name: null,
					actor_user_id: null,
					created_at: hoursAgo(2),
					event_code: "SUPPORT_ACCESS_REQUESTED",
					expires_at: null,
					id: "n1",
					message: opts.message,
					params: { request_id: "r1", workspace_name: opts.workspaceName },
					read: false,
					refs: {
						chat_id: null,
						conversation_id: null,
						invite_id: null,
						org_id: "o1",
						project_id: null,
						report_id: null,
						workspace_id: "w1",
					},
					scope: `Gemeente Lindenwijk › ${opts.workspaceName}`,
					severity: "action_required",
					title: `dembrane staff requested access to ${opts.workspaceName}`,
				},
			],
		}),
	);
	await page.route("**/v2/me/notifications/unread-count", (route) =>
		route.fulfill({ json: { unread: 1 } }),
	);
	await page.route("**/v2/me/announcements**", (route) =>
		route.fulfill({ json: { announcements: [], has_more: false } }),
	);
	await page.route("**/v2/workspaces", (route) =>
		route.fulfill({
			json: {
				organisations: [
					{
						id: "o1",
						logo_url: null,
						name: "Gemeente Lindenwijk",
						role: "owner",
						total_members: 4,
						workspace_count: 1,
					},
				],
				recent_removals: [],
				workspaces: [
					{
						id: "w1",
						name: opts.workspaceName,
						org_id: "o1",
						org_logo_url: null,
						org_name: "Gemeente Lindenwijk",
						role: "admin",
					},
				],
			},
		}),
	);
	await page.route("**/v2/me/invites**", (route) =>
		route.fulfill({ json: [] }),
	);
	await page.route("**/user-settings/me", (route) =>
		route.fulfill({ json: {} }),
	);
}

const harness = (lang: string, path: string, workspaceName: string) =>
	`/e2e/support-access-harness.html?path=/${lang}${path}&workspace=${encodeURIComponent(workspaceName)}`;

for (const size of sizes)
	for (const lang of LANGS)
		test(`support access, the customer's side, ${size.name}, ${lang}`, async ({
			page,
		}) => {
			test.setTimeout(90_000);
			const nl = lang === "nl-NL";
			await page.setViewportSize({ height: size.height, width: size.width });
			await page.addInitScript((l) => {
				localStorage.setItem("dembrane-language", l);
			}, lang);
			const dialog = page.getByTestId("support-access-request-prompt");
			const approve = nl ? "Goedkeuren voor 24 uur" : "Approve for 24 hours";

			const cases = [
				{ message: NOTE, name: "Neighbourhood panels", state: "note" },
				{ message: null, name: "Neighbourhood panels", state: "no-note" },
				{ message: LONG_NOTE, name: LONG_WORKSPACE, state: "long" },
			];
			for (const c of cases) {
				await page.unrouteAll({ behavior: "ignoreErrors" });
				await answerCustomerApi(page, {
					message: c.message,
					workspaceName: c.name,
				});
				await page.goto(harness(lang, "/o", c.name));
				await expect(dialog.getByRole("dialog")).toBeVisible();
				await expect(dialog).toContainText("Robin de Vries");
				await expect(dialog).toContainText(c.name);
				if (c.message) await expect(dialog).toContainText(c.message);
				await expect(
					dialog.getByRole("button", { name: approve }),
				).toBeVisible();
				await page.waitForTimeout(400);
				await shoot(page, `dialog-${c.state}`, size, lang);
				await noSideScroll(page);
			}

			// Closed, it stays away; the inbox still has the request and opens it again.
			await page.unrouteAll({ behavior: "ignoreErrors" });
			await answerCustomerApi(page, {
				message: NOTE,
				workspaceName: "Neighbourhood panels",
			});
			await page.goto(harness(lang, "/inbox", "Neighbourhood panels"));
			await expect(dialog.getByRole("dialog")).toBeVisible();
			await page.keyboard.press("Escape");
			await expect(dialog.getByRole("dialog")).toHaveCount(0);
			const row = page.getByRole("button", {
				name: /dembrane staff requested access to Neighbourhood panels/,
			});
			await expect(row).toBeVisible();
			await expect(row).toContainText(nl ? "Actie nodig" : "Action needed");
			await page.waitForTimeout(300);
			await shoot(page, "inbox-request", size, lang);
			await noSideScroll(page);
			await row.click();
			await expect(dialog.getByRole("dialog")).toBeVisible();
			await expect(dialog).toContainText("Robin de Vries");

			// For comparison: the approve confirmation in workspace settings.
			await page.goto(
				harness(lang, "/w/w1/settings/general", "Neighbourhood panels"),
			);
			await page.keyboard.press("Escape");
			await expect(dialog.getByRole("dialog")).toHaveCount(0);
			await page
				.getByRole("button", {
					exact: true,
					name: nl ? "Goedkeuren" : "Approve",
				})
				.click();
			await expect(
				page.getByTestId("support-access-approve-modal").getByRole("dialog"),
			).toBeVisible();
			await page.waitForTimeout(400);
			await shoot(page, "settings-approve", size, lang);
		});

// ── Staff: the account page ──

const ORG = "5f1a2b3c-0d4e-4f60-8a71-92b3c4d5e6f7";
const inADay = () => new Date(Date.now() + 20 * 3_600_000).toISOString();
const inDays = (days: number) =>
	new Date(Date.now() + days * 86_400_000).toISOString();
const NO_VISIT = {
	active: false,
	can_change: false,
	change_until: null,
	expires_at: null,
};
const READ_VISIT = {
	active: true,
	can_change: false,
	change_until: null,
	expires_at: inADay(),
};
const waiting = (id: string) => ({
	created_at: hoursAgo(3),
	expires_at: inDays(6),
	id,
});
/** One workspace in each row of the state table, as the organisation's list answers it. */
const WORKSPACES = [
	{
		name: "Neighbourhood panels",
		on: false,
		request: null,
		visit: NO_VISIT,
		workspace_id: "ws-none",
	},
	{
		name: "Youth council",
		on: false,
		request: waiting("rq1"),
		visit: NO_VISIT,
		workspace_id: "ws-request",
	},
	{
		name: "Research",
		on: true,
		request: null,
		visit: NO_VISIT,
		workspace_id: "ws-on",
	},
	{
		name: "Mobility lab",
		on: true,
		request: waiting("rq2"),
		visit: NO_VISIT,
		workspace_id: "ws-on-request",
	},
	{
		name: "Climate assembly",
		on: true,
		request: null,
		visit: READ_VISIT,
		workspace_id: "ws-read",
	},
	{
		name: "Green roofs",
		on: true,
		request: waiting("rq3"),
		visit: READ_VISIT,
		workspace_id: "ws-read-request",
	},
	{
		name: "Wijkpanels Lindenwijk, Oosterpark en Havenkwartier 2026-2027",
		on: false,
		request: null,
		visit: {
			active: true,
			can_change: true,
			change_until: inADay(),
			expires_at: inADay(),
		},
		workspace_id: "ws-change",
	},
	{
		demo: true,
		name: "Demo for the council",
		on: false,
		request: null,
		visit: NO_VISIT,
		workspace_id: "ws-demo",
	},
];

async function answerStaffApi(page: Page, workspaces = WORKSPACES) {
	await page.route(`**/v2/admin/orgs/${ORG}/workspaces`, (route) =>
		route.fulfill({
			json: {
				workspaces: workspaces.map((w) => ({
					held_for_demo: "demo" in w,
					name: w.name,
					request: w.request,
					support_access_enabled: w.on,
					visit: w.visit,
					workspace_id: w.workspace_id,
				})),
			},
		}),
	);
}

for (const size of sizes)
	for (const lang of LANGS)
		test(`support access, the staff account page, ${size.name}, ${lang}`, async ({
			page,
		}) => {
			test.setTimeout(90_000);
			const nl = lang === "nl-NL";
			await page.setViewportSize({ height: size.height, width: size.width });
			await page.addInitScript((l) => {
				localStorage.setItem("dembrane-language", l);
			}, lang);
			await answerStaffApi(page);
			const account = `/e2e/account-harness.html?path=/${lang}/admin/accounts/${ORG}`;
			await page.goto(account);
			const section = page.getByTestId("staff-support-access");
			await expect(section.getByTestId("staff-support-workspace")).toHaveCount(
				WORKSPACES.length,
			);
			// Tasks above, the whole section below it, in one view.
			await page
				.getByTestId("staff-tasks")
				.evaluate((el) => el.scrollIntoView({ block: "start" }));
			await page.waitForTimeout(300);
			await shoot(page, "account-support", size, lang);
			await noSideScroll(page);

			// The two modes, explained beside the title.
			await page.getByTestId("staff-support-info").focus();
			await expect(page.getByTestId("staff-support-info-tip")).toBeVisible();
			await page.waitForTimeout(300);
			await shoot(page, "account-support-info", size, lang);
			await page.getByTestId("staff-support-info").blur();

			// The rest of a row's steps sit under its menu: a read-only visit can still ask.
			await section
				.locator("[data-state=read]")
				.first()
				.getByTestId("staff-support-menu")
				.click();
			await expect(page.getByRole("menuitem")).not.toHaveCount(0);
			await page.waitForTimeout(300);
			await shoot(page, "account-support-menu", size, lang);
			await page.keyboard.press("Escape");

			// Request access asks for a note first; the step stays a button on a phone.
			await section
				.locator("[data-state=none]")
				.getByTestId("staff-support-request")
				.click();
			await expect(
				page.getByTestId("support-access-request-modal").getByRole("dialog"),
			).toBeVisible();
			await page.waitForTimeout(400);
			await shoot(page, "account-support-note", size, lang);
			await noSideScroll(page);
			await page.keyboard.press("Escape");

			// An organisation without workspaces.
			await page.unrouteAll({ behavior: "ignoreErrors" });
			await answerStaffApi(page, []);
			await page.goto(account);
			await expect(section).toContainText(
				nl ? "Geen werkruimtes." : "No workspaces.",
			);
			await page
				.getByTestId("staff-tasks")
				.evaluate((el) => el.scrollIntoView({ block: "start" }));
			await page.waitForTimeout(300);
			await shoot(page, "account-support-empty", size, lang);
		});
