import { appendFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { RESIDENT_EVENING_GUIDE } from "../src/components/project/templates/hostGuide.fixture";
import { grammarAudit } from "./grammar-checks";

// ECHO-1042, ECHO-1053, ECHO-1058: the start screen's row of formats (Quick start first),
// all formats with each verb filter and the setup filter, the name step with "What this
// sets up" open and from Quick start, the portal editor's name box label, a host guide a
// template filled in, workspace home's first-project state, and Home's Create menu with
// its "Which workspace?" question, at desktop and phone width. E2E_SHOTS=<dir> also saves
// screenshots.
const shots = process.env.E2E_SHOTS;
// E2E_GRAMMAR=<file> also runs the rendered design-grammar audit on every screen shot here
// and appends its findings to that file, one JSON line per screen.
const grammarLog = process.env.E2E_GRAMMAR;
const sizes = [
	{ height: 900, name: "desktop", width: 1280 },
	{ height: 844, name: "phone", width: 390 },
];
const VERBS = ["gather", "understand", "explore", "align", "decide"];

const guide = (nl: boolean) =>
	nl ? RESIDENT_EVENING_GUIDE.nl : RESIDENT_EVENING_GUIDE.en;

async function answerApi(page: Page, nl: boolean) {
	await page.route("**/v2/workspaces/w1/projects?**", (route) =>
		route.fulfill({
			json: {
				has_more: false,
				is_admin: true,
				pinned: [],
				projects: [
					{
						access_count: 1,
						access_preview: [],
						audio_hours: 0,
						conversations_count: 49,
						id: "s1",
						is_sample: true,
						language: "en",
						name: "Best practices (sample)",
						pin_order: null,
						updated_at: "2026-11-10T09:00:00Z",
						visibility: "workspace",
					},
				],
				total_count: 1,
			},
		}),
	);
	await page.route("**/v2/workspaces/w1/free-allowance**", (route) =>
		route.fulfill({ json: { free: false } }),
	);
	await page.route("**/v2/projects/p1/bff**", (route) =>
		route.fulfill({
			json: {
				// The portal editor's legal basis section reads the same endpoint.
				_legal: {
					effective: {
						legal_basis: "client-managed",
						privacy_policy_url: null,
						source: "system",
					},
					inherited: {
						legal_basis: "client-managed",
						privacy_policy_url: null,
						source: "system",
					},
					organiser_name: null,
				},
				default_conversation_ask_for_participant_name: true,
				host_guide: guide(nl),
				id: "p1",
				is_conversation_allowed: true,
				language: nl ? "nl" : "en",
				legal_basis: null,
				name: nl ? "Bewonersavond Lindenwijk" : "Lindenwijk resident evening",
				privacy_policy_url: null,
			},
		}),
	);
	await page.route("**/conversations**", (route) =>
		route.fulfill({ json: [] }),
	);
	// Home (/o): two workspaces in two organisations, so a project asks which.
	await page.route("**/v2/workspaces", (route) =>
		route.fulfill({
			json: {
				organisations: [
					{
						id: "o1",
						logo_url: null,
						name: "Sam's organisation",
						role: "owner",
						total_members: 1,
						workspace_count: 1,
					},
				],
				recent_removals: [],
				workspaces: [
					{
						id: "w1",
						name: "Sam's workspace",
						org_id: "o1",
						org_logo_url: null,
						org_name: "Sam's organisation",
						role: "owner",
					},
					{
						id: "w2",
						name: "Neighbourhood panels",
						org_id: "o2",
						org_logo_url: null,
						org_name: "Gemeente Lindenwijk",
						role: "member",
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

for (const size of sizes)
	for (const lang of ["en-US", "nl-NL"])
		test(`templates harness, ${size.name}, ${lang}`, async ({ page }) => {
			test.setTimeout(90_000);
			const nl = lang === "nl-NL";
			const errors: string[] = [];
			page.on("pageerror", (e) => errors.push(e.message));
			await page.setViewportSize({ height: size.height, width: size.width });
			await page.addInitScript((l) => {
				localStorage.setItem("dembrane-language", l);
			}, lang);
			await answerApi(page, nl);
			const shot = async (name: string) => {
				if (shots)
					await page.screenshot({
						fullPage: true,
						path: `${shots}/${size.name}-${lang}-${name}.png`,
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
			};
			const noSideScroll = async () =>
				expect(
					await page.evaluate(
						() => document.documentElement.scrollWidth <= window.innerWidth,
					),
				).toBe(true);

			await page.goto(
				`/e2e/templates-harness.html?path=/${lang}/w/w1/projects/new`,
			);
			// Start (ECHO-1058): the upload first, then every format in one row.
			await expect(page.getByTestId("project-digest-entry")).toBeVisible();
			const row = page.getByTestId("template-row-list");
			await expect(row.locator("button")).toHaveCount(17);
			await expect(row.locator("button").first()).toHaveAttribute(
				"data-testid",
				"template-card-blank",
			);
			await expect(page.getByTestId("template-card-blank")).toContainText(
				nl ? "Snelstart" : "Quick start",
			);
			await expect(
				page.getByTestId("template-card-resident_evening"),
			).toContainText(nl ? "Tafelgesprekken" : "Table conversations");
			await expect(page.getByText(nl ? "Doorgaan" : "Continue")).toHaveCount(0);
			await shot("01-start");
			await noSideScroll();
			// The row scrolls with its buttons; nothing moves by itself.
			const before = await row.evaluate((el) => el.scrollLeft);
			await page.waitForTimeout(600);
			expect(await row.evaluate((el) => el.scrollLeft)).toBe(before);
			await page.getByTestId("template-row-next").click();
			await page.waitForTimeout(600);
			expect(await row.evaluate((el) => el.scrollLeft)).toBeGreaterThan(before);
			await shot("01b-start-row-scrolled");

			// All formats: the filters first, then the grid.
			await page.getByTestId("template-row-see-all").click();
			await expect(page.getByTestId("all-formats")).toBeVisible();
			const grid = page.getByTestId("all-formats-grid").locator("button");
			await expect(grid).toHaveCount(17);
			await expect(grid.first()).toHaveAttribute(
				"data-testid",
				"template-card-blank",
			);
			await shot("02-all-formats");
			await noSideScroll();
			for (const verb of VERBS) {
				await page.getByTestId(`template-filter-verb-${verb}`).click();
				await expect(
					page.getByTestId(`template-filter-verb-${verb}`),
				).toHaveAttribute("aria-pressed", "true");
				await shot(`02-verb-${verb}`);
			}
			// The last verb pressed again clears it.
			await page.getByTestId("template-filter-verb-decide").click();
			await page.getByTestId("template-filter-setup-many_groups").click();
			// Ten formats, and Quick start steps aside while a filter is on.
			await expect(grid).toHaveCount(10);
			await expect(page.getByTestId("template-card-blank")).toHaveCount(0);
			await expect(page.getByTestId("template-filter-count")).toHaveText(
				nl ? "10 sjablonen" : "10 templates",
			);
			await shot("03-many-groups");
			await noSideScroll();

			// One press chooses and moves on to the name.
			await page.getByTestId("template-card-resident_evening").click();
			await expect(
				page.getByTestId("create-project-chosen-template"),
			).toBeVisible();
			await expect(page.getByTestId("create-project-progress")).toHaveAttribute(
				"aria-valuenow",
				"2",
			);
			await shot("04-name");
			await page.getByTestId("template-setup-summary-toggle").click();
			await expect(
				page.getByTestId("template-setup-summary-script"),
			).toHaveText(
				nl
					? "Een tafel leiden op de bewonersavond"
					: "Hosting a table at a resident evening",
			);
			await page.waitForTimeout(300);
			await shot("05-name-what-this-sets-up");
			await noSideScroll();

			// Quick start: one press, then the name, with nothing set up to show.
			await page.goto(
				`/e2e/templates-harness.html?path=/${lang}/w/w1/projects/new`,
			);
			await page.getByTestId("template-card-blank").click();
			await expect(
				page.getByTestId("create-project-chosen-template"),
			).toHaveText(
				nl ? "Vertrekpunt: Snelstart" : "Starting from: Quick start",
			);
			await expect(
				page.getByTestId("template-setup-summary-toggle"),
			).toHaveCount(0);
			await shot("05b-quick-start-name");
			await noSideScroll();

			await page.goto(`/e2e/templates-harness.html?path=/${lang}/editor`);
			await expect(
				page.getByTestId("portal-editor-name-label-input"),
			).toHaveValue(
				nl ? "Naam of nummer van je tafel" : "Table name or number",
			);
			await page
				.getByTestId("portal-editor-name-label-input")
				.evaluate((el) => el.scrollIntoView({ block: "center" }));
			if (shots)
				await page.screenshot({
					path: `${shots}/${size.name}-${lang}-06-editor-name-label.png`,
				});

			await page.goto(
				`/e2e/templates-harness.html?path=/${lang}/w/w1/projects/p1/host-guide`,
			);
			await expect(
				page.getByText(
					nl
						? "Een tafel leiden op de bewonersavond"
						: "Hosting a table at a resident evening",
				),
			).toBeVisible();
			await page.waitForTimeout(300);
			await shot("07-host-guide");

			// The portal's name box: the example follows the label (ECHO-1053).
			for (const [name, label, placeholder] of [
				[
					"09-portal-name-default",
					"",
					nl ? "Groep 1, Tafel 3, enz." : "Group 1, Table 3, etc.",
				],
				[
					"09-portal-name-table",
					nl ? "Naam of nummer van je tafel" : "Table name or number",
					null,
				],
				[
					"09-portal-name-interview",
					nl
						? "Interviewcode (geen echte namen)"
						: "Interview code (no real names)",
					null,
				],
			] as const) {
				await page.goto(
					`/e2e/templates-harness.html?path=/${lang}/p1/start&label=${encodeURIComponent(label)}`,
				);
				const input = page.getByTestId("portal-initiate-name-input");
				await expect(input).toBeVisible();
				expect(await input.getAttribute("placeholder")).toBe(placeholder);
				await shot(name);
			}

			await page.goto(`/e2e/templates-harness.html?path=/${lang}/w/w1/home`);
			await expect(page.getByTestId("workspace-home-start")).toBeVisible();
			await expect(page.getByTestId("template-picker")).toBeVisible();
			await shot("08-workspace-home");

			// All sixteen cards side by side.
			await page.goto(
				`/e2e/templates-harness.html?path=/${lang}/contact-sheet`,
			);
			await expect(
				page.getByTestId("contact-sheet").locator("svg"),
			).toHaveCount(17);
			await page.waitForTimeout(200);
			await shot("10-contact-sheet");
			await noSideScroll();

			// Home: Create above the search box, its menu, and the question which workspace.
			await page.goto(`/e2e/templates-harness.html?path=/${lang}/o`);
			await expect(page.getByTestId("create-menu-button")).toBeVisible();
			await expect(page.getByRole("combobox")).toBeVisible();
			await shot("11-home");
			await noSideScroll();
			await page.getByTestId("create-menu-button").click();
			await expect(page.getByTestId("create-menu-quick-project")).toBeVisible();
			await expect(page.getByRole("menuitem")).toHaveCount(4);
			await page.waitForTimeout(300);
			await shot("11b-home-create-menu");
			await noSideScroll();
			await page.getByTestId("create-menu-quick-project").click();
			await expect(page.getByRole("dialog")).toBeVisible();
			await expect(
				page.locator("[data-testid^=which-workspace-w]"),
			).toHaveCount(2);
			await page.waitForTimeout(300);
			await shot("11c-home-which-workspace");
			await noSideScroll();
			await page.getByTestId("which-workspace-w2").click();
			await expect(
				page.getByTestId("create-project-chosen-template"),
			).toHaveText(
				nl ? "Vertrekpunt: Snelstart" : "Starting from: Quick start",
			);
			expect(errors).toEqual([]);
		});
