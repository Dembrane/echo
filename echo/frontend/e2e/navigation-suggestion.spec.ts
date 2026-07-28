import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";

const screenshotPath =
	"../docs/plans/smart-loop-briefs/wave10-shots/navigation-card.png";

test("navigateTo card uses client-side navigation and preserves back state", async ({
	page,
}) => {
	await page.goto("/e2e/navigation-suggestion-harness.html");
	await expect(page.getByTestId("agentic-navigation-suggestion")).toBeVisible();
	await expect(page.getByTestId("navigation-harness-chat")).toContainText(
		"Chat stayed mounted.",
	);

	const historyBefore = await page.evaluate(() => window.history.length);
	mkdirSync("../docs/plans/smart-loop-briefs/wave10-shots", {
		recursive: true,
	});
	await page
		.getByTestId("agentic-navigation-suggestion")
		.screenshot({ path: screenshotPath });

	await page.getByTestId("navigation-suggestion-button").click();

	await expect(page).toHaveURL(
		/en-US\/w\/workspace-harness\/projects\/project-harness\/home$/,
	);
	await expect(
		page.getByTestId("navigation-harness-destination"),
	).toContainText("Overview route reached.");
	await expect
		.poll(() => page.evaluate(() => window.history.length))
		.toBeGreaterThan(historyBefore);

	await page.goBack();
	await expect(page).toHaveURL(
		/en-US\/w\/workspace-harness\/projects\/project-harness\/chats\/chat-harness$/,
	);
	await expect(page.getByTestId("agentic-navigation-suggestion")).toBeVisible();
});
