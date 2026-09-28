import { expect, test } from "@playwright/test";

test("persisted canvas proposal renders as an applied card after remount", async ({
	page,
}) => {
	await page.route("**/api/v2/bff/canvases?**", async (route) => {
		await route.fulfill({
			contentType: "application/json",
			json: [
				{
					created_at: "2026-07-08T08:00:00.000Z",
					id: "canvas-1",
					kind: "canvas",
					name: "Street Feedback Dashboard",
					project_id: "project-harness",
				},
			],
		});
	});
	await page.route("**/api/v2/bff/canvases/canvas-1", async (route) => {
		await route.fulfill({
			contentType: "application/json",
			json: {
				config: {
					brief:
						"Update the text formatting on the dashboard so it displays '2 interviews had' instead of '2 interviews uploaded'.",
					cadence_minutes: 5,
					created_at: "2026-07-08T09:54:00.000Z",
					gather_spec: { source: "all_conversations" },
				},
				id: "canvas-1",
				kind: "canvas",
				name: "Street Feedback Dashboard",
				project_id: "project-harness",
			},
		});
	});

	await page.goto("/e2e/agentic-persisted-canvas-harness.html");

	await expect(
		page.getByTestId("agentic-persisted-canvas-harness"),
	).toContainText("Persisted canvas history loaded.");
	await expect(page.getByTestId("agentic-canvas-suggestion-applied")).toBeVisible();
	await expect(page.getByTestId("agentic-canvas-suggestion-applied")).toContainText(
		"This canvas update is applied.",
	);

	await page.getByTestId("agentic-persisted-canvas-remount").click();
	await expect(page.getByTestId("agentic-canvas-suggestion-applied")).toBeVisible();
	await expect(page.getByText("No canvas suggestion parsed.")).toHaveCount(0);
});
