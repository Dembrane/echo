import { expect, test } from "@playwright/test";

// Unauthenticated smoke: proves Playwright drives the running dev app and the
// auth shell renders. No seed/credentials needed.
test("app loads and shows an auth surface", async ({ page }) => {
	const resp = await page.goto("/");
	expect(resp?.status()).toBeLessThan(500);
	// The app should land on a login/auth route or render the login form.
	await page.waitForLoadState("networkidle");
	const body = await page.locator("body").innerText();
	// Login/registration copy or the email field should be present somewhere.
	const hasAuthUi =
		(await page.locator('input[type="email"], input[name="email"]').count()) >
			0 ||
		/log\s?in|sign\s?in|register|email/i.test(body);
	expect(hasAuthUi).toBeTruthy();
});
