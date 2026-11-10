import { createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";

// Register, verify, log in: the whole way in for a new person, through the real UI and API.
//
// The verification email is not readable from here (locally it stays in the API's memory),
// so the spec mints the same link the email carries: Better Auth's verification token is an
// HS256 JWT of { email } signed with the API's AUTH_SECRET. Pass that secret as
// E2E_AUTH_SECRET; without it the spec skips. Needs the dashboard (E2E_BASE_URL, default
// :5173) talking to a running API with a migrated database. Not a PR gate.
const AUTH_SECRET = process.env.E2E_AUTH_SECRET ?? "";

const base64url = (value: string | Buffer) =>
	Buffer.from(value).toString("base64url");

function verificationToken(email: string, secret: string): string {
	const now = Math.floor(Date.now() / 1000);
	const header = base64url(JSON.stringify({ alg: "HS256" }));
	const payload = base64url(
		JSON.stringify({ email: email.toLowerCase(), exp: now + 3600, iat: now }),
	);
	const signature = createHmac("sha256", secret)
		.update(`${header}.${payload}`)
		.digest("base64url");
	return `${header}.${payload}.${signature}`;
}

test.skip(!AUTH_SECRET, "set E2E_AUTH_SECRET to the API's AUTH_SECRET");

test("a new person registers, verifies their email and logs in", async ({
	page,
}) => {
	test.setTimeout(60_000);
	const email = `e2e-${Date.now()}@example.com`;
	const password = "Abcdefgh1!xyz";

	await page.goto("/register");
	await page.getByTestId("auth-register-first-name-input").fill("E2E");
	await page.getByTestId("auth-register-email-input").fill(email);
	await page.getByTestId("auth-register-terms-checkbox").check();
	await page.getByTestId("auth-register-continue-button").click();
	await page.getByTestId("auth-register-password-input").fill(password);
	await page.getByTestId("auth-register-confirm-password-input").fill(password);
	await page.getByTestId("auth-register-submit-button").click();
	await expect(page.getByTestId("auth-register-verify-step")).toContainText(
		email,
	);

	// Logging in before verifying is refused with the resend offer.
	await page.goto("/login");
	await page.getByTestId("auth-login-email-input").fill(email);
	await page.getByTestId("auth-login-password-input").fill(password);
	await page.getByTestId("auth-login-submit-button").click();
	await expect(page.getByTestId("auth-resend-verification")).toBeVisible();

	await page.goto(
		`/verify-email?token=${verificationToken(email, AUTH_SECRET)}`,
	);
	await page.waitForURL(/\/login\?verified=1/, { timeout: 15_000 });

	await page.getByTestId("auth-login-email-input").fill(email);
	await page.getByTestId("auth-login-password-input").fill(password);
	await page.getByTestId("auth-login-submit-button").click();
	// A new account lands on onboarding (or the home list once that is done).
	await page.waitForURL(/\/(onboarding|o)\b/, { timeout: 20_000 });
});
