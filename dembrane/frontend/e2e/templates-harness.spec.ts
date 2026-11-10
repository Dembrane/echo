import { expect, type Page, test } from "@playwright/test";
import { RESIDENT_EVENING_GUIDE } from "../src/components/project/templates/hostGuide.fixture";

// ECHO-1042, ECHO-1053: the template picker by purpose (most used first, each verb filter,
// the setup filter), the name step with "What this sets up" open, the portal editor's name
// box label, a host guide a template filled in, and workspace home's first-project state,
// at desktop and phone width. E2E_SHOTS=<dir> also saves screenshots.
const shots = process.env.E2E_SHOTS;
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
			await expect(page.getByTestId("template-picker")).toBeVisible();
			// The first view: the most used six, and a resident evening among them.
			await expect(page.getByRole("radio")).toHaveCount(6);
			await expect(
				page.getByTestId("template-card-resident_evening"),
			).toContainText(nl ? "Bewonersavond" : "Resident evening");
			// Continue waits for a card, and says so.
			await expect(
				page.getByTestId("create-project-template-continue"),
			).toBeDisabled();
			await shot("01-first-view");
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
			await expect(page.getByRole("radio")).toHaveCount(10);
			await shot("03-many-groups");
			await noSideScroll();

			await page.getByTestId("template-card-resident_evening").click();
			await expect(
				page.getByTestId("template-card-resident_evening"),
			).toHaveAttribute("aria-checked", "true");
			// The bug from the earlier screenshot: Continue must be enabled and look it.
			const next = page.getByTestId("create-project-template-continue");
			await expect(next).toBeEnabled();
			expect(
				await next.evaluate((el) => getComputedStyle(el).backgroundColor),
			).not.toBe("rgba(0, 0, 0, 0)");
			await shot("04-selected");
			await next.click();
			await expect(
				page.getByTestId("create-project-chosen-template"),
			).toBeVisible();
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
			await noSideScroll();
			expect(errors).toEqual([]);
		});
