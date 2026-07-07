import { expect, test } from "@playwright/test";
import { hasCreds, login } from "./helpers";

const workspaceId = process.env.E2E_WORKSPACE_ID ?? "";
const projectId = process.env.E2E_PROJECT_ID ?? "";
const hasScope = Boolean(workspaceId && projectId);

const methodologies = [
	{
		id: "dembrane",
		name: "dembrane",
		description: "Default",
		framing: "Figure out what this project is for.",
		is_seeded: true,
		latest_version: {
			id: "dembrane-v1",
			note: "Initial history",
			created_at: "2026-07-08T10:00:00Z",
		},
		versions_count: 1,
	},
	{
		id: "panel-day",
		name: "Panel day",
		description: "Panel setup",
		framing: "Keep tables aligned around neighbourhood concerns.",
		is_seeded: false,
		latest_version: {
			id: "panel-day-v2",
			note: "Tightened framing",
			created_at: "2026-07-08T11:00:00Z",
		},
		versions_count: 2,
	},
];

test.describe("methodology settings", () => {
	test.skip(!hasCreds || !hasScope, "Set E2E_EMAIL, E2E_PASSWORD, E2E_WORKSPACE_ID, and E2E_PROJECT_ID");

	test.beforeEach(async ({ page }) => {
		await page.route("**/v2/bff/methodologies?**", async (route) => {
			await route.fulfill({ json: methodologies });
		});
		await page.route("**/v2/bff/methodologies/panel-day", async (route) => {
			await route.fulfill({
				json: {
					...methodologies[1],
					versions: [
						{
							id: "panel-day-v2",
							note: "Tightened framing",
							created_by: "du-1",
							created_at: "2026-07-08T11:00:00Z",
							content: { blocks: [{ type: "goal" }] },
						},
					],
				},
			});
		});
		await page.route("**/v2/bff/methodologies", async (route) => {
			if (route.request().method() !== "POST") return route.fallback();
			await route.fulfill({
				json: {
					...methodologies[1],
					id: "new-methodology",
					name: "New panel",
					latest_version: { id: "new-methodology-v1", note: "Initial history", created_at: "2026-07-08T12:00:00Z" },
					versions_count: 1,
				},
			});
		});
		await login(page);
	});

	test("project settings renders methodology select and patches the project", async ({ page }) => {
		let patchedVersionId = "";
		await page.route(`**/v2/bff/projects/${projectId}`, async (route) => {
			if (route.request().method() !== "PATCH") return route.fallback();
			patchedVersionId = route.request().postDataJSON().methodology_version_id;
			await route.fulfill({ json: { id: projectId, methodology_version_id: patchedVersionId } });
		});

		await page.goto(`/w/${workspaceId}/projects/${projectId}/settings/overview`);
		await expect(page.getByTestId("project-methodology-current")).toContainText("dembrane");
		await page.getByTestId("project-methodology-select").click();
		await page.getByRole("option", { name: "Panel day" }).click();
		await expect.poll(() => patchedVersionId).toBe("panel-day-v2");
	});

	test("workspace settings can create and edit methodologies, while dembrane is read-only", async ({ page }) => {
		let createdName = "";
		let editedFraming = "";
		await page.route("**/v2/bff/methodologies", async (route) => {
			if (route.request().method() !== "POST") return route.fallback();
			createdName = route.request().postDataJSON().name;
			await route.fulfill({
				json: {
					...methodologies[1],
					id: "new-methodology",
					name: createdName,
					latest_version: { id: "new-methodology-v1", note: "Initial history", created_at: "2026-07-08T12:00:00Z" },
					versions_count: 1,
				},
			});
		});
		await page.route("**/v2/bff/methodologies/panel-day/versions", async (route) => {
			editedFraming = route.request().postDataJSON().framing;
			await route.fulfill({ json: { ...methodologies[1], framing: editedFraming } });
		});

		await page.goto(`/w/${workspaceId}/settings/general`);
		await expect(page.getByTestId("workspace-methodologies")).toContainText("dembrane");
		await expect(page.getByTestId("methodology-row-dembrane")).toContainText("Read-only");
		await expect(page.getByTestId("methodology-edit-dembrane")).toHaveCount(0);

		await page.getByTestId("methodology-new-button").click();
		await page.getByTestId("methodology-new-name").fill("New panel");
		await page.getByTestId("methodology-new-description").fill("A new panel flow");
		await page.getByTestId("methodology-new-framing").fill("Ask for concerns by table.");
		await page.getByTestId("methodology-new-save").click();
		await expect.poll(() => createdName).toBe("New panel");

		await page.getByTestId("methodology-edit-panel-day").click();
		await page.getByTestId("methodology-edit-framing").fill("Ask for concerns by neighbourhood.");
		await page.getByTestId("methodology-edit-save").click();
		await expect.poll(() => editedFraming).toBe("Ask for concerns by neighbourhood.");
	});
});
