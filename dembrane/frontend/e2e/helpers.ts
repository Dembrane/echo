import type { Page } from "@playwright/test";

// Credentials for authenticated specs. Provide a VERIFIED user (the app gates
// login on email verification, so automated registration can't self-serve a
// session). Specs skip themselves when these are absent.
export const E2E_EMAIL = process.env.E2E_EMAIL ?? "";
export const E2E_PASSWORD = process.env.E2E_PASSWORD ?? "";
export const hasCreds = Boolean(E2E_EMAIL && E2E_PASSWORD);

// Log in through the real UI (Directus auth → session cookie). The login form
// lives at /login; test ids come from src/routes/auth/Login.tsx.
export async function login(page: Page): Promise<void> {
	await page.goto("/login");
	await page.locator('input[name="email"], input[type="email"]').first().fill(E2E_EMAIL);
	await page
		.locator('input[name="password"], input[type="password"]')
		.first()
		.fill(E2E_PASSWORD);
	await page.getByRole("button", { name: /log\s?in|sign\s?in|continue/i }).first().click();
	// Landed in the app shell (post-auth redirect → /o).
	await page.waitForURL(/\/(o|onboarding|w)\b/, { timeout: 15_000 });
}
