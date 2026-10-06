import { expect, test } from "@playwright/test";

const methodologies = [
	{
		description: null,
		framing: null,
		id: "partial-methodology",
		is_seeded: false,
		latest_version: null,
		name: null,
		versions_count: undefined,
	},
	{
		description: "Panel setup",
		framing: "Keep tables aligned around neighbourhood concerns.",
		id: "panel-day",
		is_seeded: false,
		latest_version: {
			created_at: "2026-07-08T11:00:00Z",
			id: "panel-day-v2",
			note: "Tightened framing",
		},
		name: "Panel day",
		versions_count: 2,
	},
];

test("methodology harness creates, edits, and increments history without crashing", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") pageErrors.push(message.text());
	});
	const rows = structuredClone(methodologies);
	let editedFraming = "";

	await page.route("**/v2/bff/methodologies?**", async (route) => {
		await route.fulfill({ json: rows });
	});
	await page.route("**/v2/bff/methodologies/panel-day", async (route) => {
		await route.fulfill({
			json: {
				...rows.find((row) => row.id === "panel-day"),
				versions: [
					{
						content: { blocks: [{ type: "goal" }] },
						created_at: "2026-07-08T11:00:00Z",
						created_by: "du-1",
						id: "panel-day-v2",
						note: "Tightened framing",
					},
				],
			},
		});
	});
	await page.route("**/v2/bff/methodologies", async (route) => {
		if (route.request().method() !== "POST") return route.fallback();
		const body = route.request().postDataJSON();
		const created = {
			description: body.description,
			framing: body.framing,
			id: "new-methodology",
			is_seeded: false,
			latest_version: {
				created_at: "2026-07-08T12:00:00Z",
				id: "new-methodology-v1",
				note: "Initial history",
			},
			name: body.name,
			versions_count: 1,
		};
		rows.push(created);
		await route.fulfill({ json: created });
	});
	await page.route(
		"**/v2/bff/methodologies/panel-day/versions",
		async (route) => {
			const body = route.request().postDataJSON();
			editedFraming = body.framing;
			const panel = rows.find((row) => row.id === "panel-day");
			if (panel) {
				panel.framing = editedFraming;
				panel.versions_count = 3;
			}
			await route.fulfill({ json: panel });
		},
	);

	await page.goto("/e2e/methodology-harness.html");
	await expect(page.getByTestId("workspace-methodologies")).toContainText(
		"Untitled methodology",
	);

	await page.getByTestId("methodology-new-button").click();
	await expect(page.getByTestId("methodology-new-form")).toBeVisible();
	await page.getByTestId("methodology-new-name").fill("New panel");
	await page
		.getByTestId("methodology-new-description")
		.fill("A new panel flow");
	expect(pageErrors).toEqual([]);
	await page.getByLabel("Framing").fill("Ask for concerns by table.");
	await page.getByTestId("methodology-new-save").click();
	await expect(
		page.getByTestId("methodology-row-new-methodology"),
	).toContainText("1 history entry");

	await page.getByTestId("methodology-edit-panel-day").click();
	await expect(page.getByTestId("methodology-edit-form")).toBeVisible();
	await page.getByLabel("Framing").fill("Ask for concerns by neighbourhood.");
	await page.getByTestId("methodology-edit-save").click();
	await expect
		.poll(() => editedFraming)
		.toBe("Ask for concerns by neighbourhood.");
	await expect(page.getByTestId("methodology-row-panel-day")).toContainText(
		"3 history entries",
	);
});
