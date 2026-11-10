import { expect, type Page, test } from "@playwright/test";
import { SUGGESTIONS } from "../src/components/project/setup-suggestions/setupSuggestions.fixture";

// ECHO-1043: "Tell dembrane about your session" in the create flow's name step, in each
// state (idle, loading, results, empty, error), at desktop and phone width, in English
// and Dutch. Reuses the templates harness page. E2E_SHOTS=<dir> also saves screenshots.
const shots = process.env.E2E_SHOTS;
const sizes = [
	{ height: 900, name: "desktop", width: 1280 },
	{ height: 844, name: "phone", width: 390 },
];
const AGENDA =
	"Bewonersavond Strijp-S met wethouder Marieke de Wolf, Woonbedrijf en Ennatuurlijk. 12 tafels.";

type Answer = "results" | "empty" | "error" | "pending" | "url_note";

async function answerApi(page: Page, answer: () => Answer) {
	await page.route("**/v2/workspaces/w1/free-allowance**", (route) =>
		route.fulfill({ json: { free: false } }),
	);
	await page.route("**/v2/workspaces/w1/project-setup/suggestions", (route) => {
		const a = answer();
		if (a === "pending") return; // never answered: the loading state stays
		if (a === "error")
			return route.fulfill({
				json: { code: "project.setup_suggestions_unavailable" },
				status: 503,
			});
		if (a === "empty")
			return route.fulfill({
				json: { key_terms: [], max_key_terms: 30, notes: [], settings: [] },
			});
		return route.fulfill({
			json: {
				...SUGGESTIONS,
				notes: a === "url_note" ? ["url_not_read"] : [],
			},
		});
	});
}

for (const size of sizes)
	for (const lang of ["en-US", "nl-NL"])
		test(`setup suggestions, ${size.name}, ${lang}`, async ({ page }) => {
			const errors: string[] = [];
			page.on("pageerror", (e) => errors.push(e.message));
			await page.setViewportSize({ height: size.height, width: size.width });
			await page.addInitScript((l) => {
				localStorage.setItem("dembrane-language", l);
			}, lang);
			let answer: Answer = "pending";
			await answerApi(page, () => answer);
			const block = page.getByTestId("setup-suggestions");
			const shot = async (name: string) => {
				if (!shots) return;
				await block.scrollIntoViewIfNeeded();
				await page.screenshot({
					fullPage: true,
					path: `${shots}/${size.name}-${lang}-${name}.png`,
				});
				await block.screenshot({
					path: `${shots}/${size.name}-${lang}-${name}-block.png`,
				});
			};
			const noSideScroll = async () =>
				expect(
					await page.evaluate(
						() => document.documentElement.scrollWidth <= window.innerWidth,
					),
				).toBe(true);
			const suggest = () =>
				page.getByTestId("setup-suggestions-submit").click();

			await page.goto(
				`/e2e/templates-harness.html?path=/${lang}/w/w1/projects/new?template=event`,
			);
			await expect(block).toBeVisible();
			await page.getByTestId("setup-suggestions-text").fill(AGENDA);
			await shot("1-idle");
			await noSideScroll();

			answer = "pending";
			await suggest();
			await expect(
				page.getByTestId("setup-suggestions-status"),
			).not.toBeEmpty();
			// Create is never held up by a running request.
			await page.getByRole("textbox").first().fill("Bewonersavond");
			await expect(page.getByTestId("create-project-submit")).toBeEnabled();
			await shot("2-loading");

			// A fresh page per state: the pending request above never settles.
			const fresh = async (a: Answer) => {
				answer = a;
				await page.goto(
					`/e2e/templates-harness.html?path=/${lang}/w/w1/projects/new?template=event`,
				);
				await page.getByTestId("setup-suggestions-text").fill(AGENDA);
				await page
					.getByTestId("setup-suggestions-url")
					.fill(a === "url_note" ? "https://example.org/avond" : "");
				await suggest();
			};

			await fresh("results");
			await expect(page.getByTestId("setup-suggestions-results")).toBeVisible();
			await page.getByTestId("setup-suggestions-term-toggle-1").click();
			await page
				.getByTestId("setup-suggestions-setting-is_verify_enabled")
				.check();
			// The reason shows on keyboard focus, as on hover.
			await page.mouse.move(0, 0);
			await page.getByTestId("setup-suggestions-term-toggle-0").focus();
			await page.keyboard.press("Shift+Tab");
			await page.keyboard.press("Tab");
			await expect(
				page.getByRole("tooltip", { name: SUGGESTIONS.key_terms[0]?.reason }),
			).toBeVisible();
			await page.waitForTimeout(300);
			await shot("3-results");
			await noSideScroll();

			await fresh("url_note");
			await expect(
				page.getByTestId("setup-suggestions-url-note"),
			).toBeVisible();
			await page.getByTestId("setup-suggestions-accept-all").click();
			await shot("4-accepted-all-url-note");

			await fresh("empty");
			await expect(page.getByTestId("setup-suggestions-empty")).toBeVisible();
			await shot("5-empty");

			await fresh("error");
			await expect(page.getByTestId("setup-suggestions-error")).toBeVisible();
			await shot("6-error");
			await noSideScroll();
			expect(errors).toEqual([]);
		});
