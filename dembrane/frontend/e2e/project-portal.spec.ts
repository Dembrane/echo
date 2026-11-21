import { devices, expect, type Page, test } from "@playwright/test";
import { AUTH_SECRET, seedOnboardedUser } from "./helpers";

// A host creates a "Table conversations" project, then a participant on a phone opens its
// portal, steps through the tutorial, records about ten seconds and finishes. Proves the
// project lands on its home page and the recording reaches the API as at least one chunk,
// read back through the same participant endpoint the portal calls.
//
// The account is seeded through the API (verified, onboarded) with a verification token
// minted from the API's AUTH_SECRET: pass it as E2E_AUTH_SECRET; without it the spec skips.
// Needs the dashboard (E2E_BASE_URL, default :5173) and the portal (E2E_PORTAL_URL, default
// :5174), both proxying /api to a running API with a migrated database and a worker. The
// microphone is Chromium's fake device, which plays a tone. Against a verify-dembrane run:
//   E2E_BASE_URL=$DASHBOARD_URL E2E_PORTAL_URL=$PORTAL_URL \
//   E2E_AUTH_SECRET=<AUTH_SECRET from dembrane/platform/.env.local> \
//   pnpm exec playwright test -c e2e/playwright.config.ts project-portal
// Not a PR gate.
const PORTAL_URL = process.env.E2E_PORTAL_URL ?? "http://localhost:5174";
const ORG = "E2E Org";
const PROJECT = "E2E table project";

// The portal's tutorial: one screen per heading, each left by its forward button.
const TUTORIAL: [heading: string, button: string][] = [
	["What is dembrane?", "Tell me more"],
	["Just speak your mind", "Continue"],
	["Solo or in a Group", "Continue"],
	["Question time", "Got it"],
	["Privacy matters", "Tell me more"],
	["Data controller, usage and security.", "I understand"],
	["Reduce background noise", "Noted"],
	["Strong internet connection", "Ready!"],
	["Don't lock your device!", "Okay"],
];

test.skip(!AUTH_SECRET, "set E2E_AUTH_SECRET to the API's AUTH_SECRET");

test.use({
	launchOptions: {
		args: [
			"--use-fake-device-for-media-stream",
			"--use-fake-ui-for-media-stream",
		],
	},
});

// The loading curtain both apps show while a route loads.
const curtainGone = (page: Page) =>
	expect(page.locator("[class*=stageHost]")).toHaveCount(0, {
		timeout: 20_000,
	});

test("a host creates a project and a participant records in its portal", async ({
	baseURL,
	browser,
	page,
	request,
}) => {
	test.setTimeout(180_000);
	if (!baseURL) throw new Error("no baseURL in the Playwright config");
	const { email, password } = await seedOnboardedUser(request, baseURL, ORG);

	// "What's new" opens over the home page on a timer, sometimes well after login; close it
	// whenever it shows up in front of a later step.
	await page.addLocatorHandler(
		page.locator("[aria-label='Close and go to dembrane']"),
		(close) => close.click(),
	);

	await page.goto("/login");
	await expect(page.getByTestId("auth-login-email-input")).toBeVisible();
	await curtainGone(page);
	await page.getByTestId("auth-login-email-input").fill(email);
	await page.getByTestId("auth-login-password-input").fill(password);
	await page.getByTestId("auth-login-submit-button").click();
	await page.waitForURL(/\/o\b/, { timeout: 20_000 });
	await curtainGone(page);

	await page.getByRole("link", { exact: true, name: ORG }).click();
	await page.getByRole("link", { exact: true, name: "Default" }).click();
	await page.getByRole("link", { name: "Create project" }).click();
	await page.waitForURL(/\/projects\/new\b/);
	await curtainGone(page);
	await page.getByRole("button", { name: "Table conversations" }).click();
	await page.getByLabel("Project name").fill(PROJECT);
	await page
		.getByRole("button", { exact: true, name: "Create project" })
		.click();
	await page.waitForURL(/\/projects\/[^/]+\/home\b/, { timeout: 20_000 });
	await expect(page.getByRole("heading", { name: PROJECT })).toBeVisible();
	const projectId = page.url().match(/\/projects\/([^/]+)\/home/)?.[1];
	if (!projectId) throw new Error(`no project id in ${page.url()}`);

	// The participant, on a phone of their own. The project runs Chromium, so drop the
	// device's WebKit default.
	const { defaultBrowserType: _, ...iPhone } = devices["iPhone 14"];
	const phone = await browser.newContext({
		...iPhone,
		permissions: ["microphone"],
	});
	const portal = await phone.newPage();

	await portal.goto(`${PORTAL_URL}/${projectId}/start`);
	await expect(portal.getByRole("button", { name: "Let's go!" })).toBeVisible();
	await curtainGone(portal);
	await portal.getByRole("button", { name: "Let's go!" }).click();
	for (const [heading, button] of TUTORIAL) {
		await expect(
			portal.getByRole("heading", { exact: true, name: heading }),
		).toBeVisible();
		await portal.getByRole("button", { exact: true, name: button }).click();
	}

	await expect(
		portal.getByRole("heading", { name: "Ready to begin?" }),
	).toBeVisible();
	await portal.getByLabel("Table name or number").fill("Table 7");
	// The portal doesn't send the participant token yet; carry it if the API issues one,
	// so the chunk check below still passes once tokens are required.
	const initiated = portal.waitForResponse(
		(r) =>
			r.request().method() === "POST" &&
			r.url().includes("/conversations/initiate"),
	);
	await portal.getByRole("button", { exact: true, name: "Continue" }).click();
	const participantToken = (await initiated).headers()["x-participant-token"];
	await portal.waitForURL(/\/conversation\/[^/]+/, { timeout: 20_000 });
	const conversationId = portal.url().match(/\/conversation\/([^/?#]+)/)?.[1];
	if (!conversationId) throw new Error(`no conversation id in ${portal.url()}`);
	await curtainGone(portal);

	// React Grab's dev-only toolbar sits over the Record button at phone width.
	await portal.evaluate(() =>
		document.querySelectorAll("[data-react-grab]").forEach((e) => {
			e.remove();
		}),
	);
	await portal.getByRole("button", { exact: true, name: "Record" }).click();
	await expect(
		portal.getByRole("button", { exact: true, name: "Stop" }),
	).toBeVisible();
	// The length of the recording, not a wait for the page: Stop sends it as one chunk.
	await portal.waitForTimeout(10_000);
	await portal.getByRole("button", { exact: true, name: "Stop" }).click();
	await portal.getByRole("button", { exact: true, name: "Finish" }).click();
	// No "Before you finish" step: it only opens after 60 s of recording (REFINE_BUTTON_THRESHOLD_SECONDS).
	await portal.waitForURL(/\/finish\b/, { timeout: 20_000 });
	await expect(portal.getByText("Thank you for participating!")).toBeVisible();

	// Fetched from inside the portal page, as the portal does: Node can't resolve
	// portal.localhost, which Chromium maps to this machine.
	const chunksPath = `/api/participant/projects/${projectId}/conversations/${conversationId}/chunks`;
	await expect
		.poll(
			() =>
				portal.evaluate(
					async ({ path, token, id }) => {
						const response = await fetch(path, {
							headers: token ? { "x-participant-token": token } : {},
						});
						if (!response.ok) throw new Error(`${path}: ${response.status}`);
						const chunks: { conversation_id: string }[] = await response.json();
						return chunks.filter((c) => c.conversation_id === id).length;
					},
					{ id: conversationId, path: chunksPath, token: participantToken },
				),
			{ timeout: 30_000 },
		)
		.toBeGreaterThan(0);

	await phone.close();
});
