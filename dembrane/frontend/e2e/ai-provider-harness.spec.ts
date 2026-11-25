import { expect, type Page, test } from "@playwright/test";
import {
	orgGoogleForAnalysis,
	orgScaleway,
	projectChoices,
	staffAccount,
} from "../src/e2e/aiProviderFixtures";

// The AI provider screens, per job: the organisation's page with only Scaleway and with Google
// enabled for analysis only, a project's choices and the Google confirm, and the staff account
// card's summary and edit dialog; desktop and phone, light and dark. The API answers with the
// responses the real service gave over a seeded database (aiProviderFixtures.ts).
// E2E_SHOTS=<dir> saves a screenshot of each.
const shots = process.env.E2E_SHOTS;
const sizes = [
	{ height: 900, name: "desktop", width: 1280 },
	{ height: 844, name: "phone", width: 390 },
];
const schemes = ["light", "dark"] as const;

async function answerApi(
	page: Page,
	body: { org?: unknown; project?: unknown; staff?: unknown },
) {
	await page.route("**/api/v2/**", (route) => {
		const url = route.request().url();
		if (route.request().method() !== "GET") return route.fulfill({ json: {} });
		if (url.includes("/v2/admin/orgs/"))
			return route.fulfill({ json: body.staff });
		if (url.includes("/v2/orgs/")) return route.fulfill({ json: body.org });
		if (url.includes("/v2/projects/"))
			return route.fulfill({ json: body.project });
		return route.fulfill({ json: {} });
	});
}

for (const size of sizes) {
	for (const scheme of schemes) {
		test.describe(`${size.name} ${scheme}`, () => {
			test.use({
				colorScheme: scheme,
				viewport: { height: size.height, width: size.width },
			});
			const shot = async (page: Page, name: string, full = true) => {
				if (shots)
					await page.screenshot({
						fullPage: full,
						path: `${shots}/${name}-${size.name}-${scheme}.png`,
					});
			};

			test("the organisation page with only Scaleway", async ({ page }) => {
				await answerApi(page, { org: orgScaleway });
				await page.goto("/e2e/ai-provider-harness.html?view=org");
				await expect(page.getByTestId("org-job-analysis")).toBeVisible();
				await expect(page.getByTestId("org-job-transcription")).toBeVisible();
				// Google is muted with a Request button in each job; Scaleway reads Included.
				await expect(page.getByRole("button", { name: "Request" })).toHaveCount(
					2,
				);
				await expect(page.getByText("Included in your plan")).toHaveCount(2);
				await shot(page, "1-org-ai-provider-scaleway-only");
			});

			test("the organisation page with Google enabled for analysis only", async ({
				page,
			}) => {
				await answerApi(page, { org: orgGoogleForAnalysis });
				await page.goto("/e2e/ai-provider-harness.html?view=org");
				const analysis = page.getByTestId("org-job-analysis");
				await expect(analysis.getByText("Enabled")).toBeVisible();
				await expect(
					page.getByTestId("org-job-transcription").getByText("Not enabled"),
				).toBeVisible();
				await expect(page.getByTestId("ai-provider-history")).toContainText(
					"Google Vertex AI enabled for Analysis",
				);
				await expect(page.getByTestId("ai-provider-month")).toContainText(
					"This month: Scaleway included, Google EUR",
				);
				await shot(page, "1c-org-ai-provider-with-google");
			});

			test("a project's choice per job, and the Google confirm", async ({
				page,
			}) => {
				await answerApi(page, { project: projectChoices });
				await page.goto("/e2e/ai-provider-harness.html?view=project");
				await expect(page.getByTestId("project-job-analysis")).toBeVisible();
				await expect(
					page.getByTestId("project-job-transcription"),
				).toBeVisible();
				await expect(page.getByText("Account default")).toHaveCount(2);
				await shot(page, "2-project-ai-provider");
				await page.getByTestId("project-provider-analysis-google").click();
				const dialog = page.getByRole("dialog");
				await expect(dialog).toContainText(
					"Use Google Vertex AI for Analysis?",
				);
				await expect(dialog).toContainText(
					"about EUR 4 a month at your last 30 days of use",
				);
				// Let the dialog finish its entrance before it is drawn.
				await page.waitForTimeout(500);
				await shot(page, "2b-project-use-google-confirm", false);
			});

			test("the staff card's section and its edit dialog", async ({ page }) => {
				await answerApi(page, { staff: staffAccount });
				await page.goto("/e2e/ai-provider-harness.html?view=staff");
				const section = page.getByTestId("staff-ai-provider");
				await expect(section).toBeVisible();
				await expect(page.getByTestId("summary-transcription")).toBeVisible();
				await expect(
					page.getByTestId("ai-provider-google-month"),
				).toContainText("Google this month: EUR");
				await page.getByTestId("ai-provider-show-all").click();
				await shot(page, "3-staff-ai-provider");
				await page.getByTestId("ai-provider-edit").click();
				await expect(page.getByTestId("edit-job-analysis")).toBeVisible();
				await page.waitForTimeout(500);
				// The dialog's whole form is in view for the picture.
				await page.setViewportSize({ height: 2400, width: size.width });
				// The default's switch reads as on and locked, never greyed like off.
				const locked = page
					.getByTestId("enabled-analysis-google")
					.locator("xpath=ancestor-or-self::*[@data-locked]")
					.first();
				await expect(locked).toBeAttached();
				await expect(page.getByTestId("enabled-analysis-google")).toBeChecked();
				await expect(page.getByTestId("enabled-analysis-google")).toBeEnabled();
				await expect(
					page.getByTestId("enabled-transcription-scaleway"),
				).toBeChecked();
				await expect(
					page.getByTestId("enabled-transcription-google"),
				).toBeChecked();
				await shot(page, "3b-staff-ai-provider-edit");
			});
		});
	}
}
