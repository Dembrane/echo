import { expect, type Page, test } from "@playwright/test";

// ECHO-1042: the template picker, the name step with "More options", and workspace home's
// first-project state, at desktop and phone width. E2E_SHOTS=<dir> also saves screenshots.
const shots = process.env.E2E_SHOTS;
const sizes = [
	{ height: 900, name: "desktop", width: 1280 },
	{ height: 844, name: "phone", width: 390 },
];

async function answerApi(page: Page) {
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
}

for (const size of sizes)
	for (const lang of ["en-US", "nl-NL"])
		test(`templates harness, ${size.name}, ${lang}`, async ({ page }) => {
			const errors: string[] = [];
			page.on("pageerror", (e) => errors.push(e.message));
			await page.setViewportSize({ height: size.height, width: size.width });
			await page.addInitScript((l) => {
				localStorage.setItem("dembrane-language", l);
			}, lang);
			await answerApi(page);
			const shot = async (name: string) => {
				if (shots)
					await page.screenshot({
						fullPage: true,
						path: `${shots}/${size.name}-${lang}-${name}.png`,
					});
			};

			await page.goto(
				`/e2e/templates-harness.html?path=/${lang}/w/w1/projects/new`,
			);
			await expect(page.getByTestId("template-picker")).toBeVisible();
			await expect(page.getByRole("radio")).toHaveCount(4);
			await page.getByTestId("template-card-event").click();
			await expect(page.getByTestId("template-card-event")).toHaveAttribute(
				"aria-checked",
				"true",
			);
			await shot("1-picker");
			// No sideways scroll at phone width.
			expect(
				await page.evaluate(
					() => document.documentElement.scrollWidth <= window.innerWidth,
				),
			).toBe(true);

			await page.getByTestId("create-project-template-continue").click();
			await expect(
				page.getByTestId("create-project-chosen-template"),
			).toBeVisible();
			await shot("2-name");
			await page.getByTestId("create-project-more-options-toggle").click();
			await expect(page.getByTestId("create-project-review")).toBeVisible();
			await page.waitForTimeout(300);
			await shot("3-more-options");

			await page.goto(`/e2e/templates-harness.html?path=/${lang}/w/w1/home`);
			await expect(page.getByTestId("workspace-home-start")).toBeVisible();
			await shot("4-workspace-home");
			expect(errors).toEqual([]);
		});
