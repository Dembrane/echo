import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { APIRequestContext, Page } from "@playwright/test";

// Credentials for authenticated specs. Provide a VERIFIED user (the app gates
// login on email verification, so automated registration can't self-serve a
// session). Specs skip themselves when these are absent.
export const E2E_EMAIL = process.env.E2E_EMAIL ?? "";
export const E2E_PASSWORD = process.env.E2E_PASSWORD ?? "";
export const hasCreds = Boolean(E2E_EMAIL && E2E_PASSWORD);

// The API's AUTH_SECRET, for specs that mint their own verification link.
export const AUTH_SECRET = process.env.E2E_AUTH_SECRET ?? "";

// Log in through the real UI (Directus auth → session cookie). The login form
// lives at /login; test ids come from src/routes/auth/Login.tsx.
export async function login(page: Page): Promise<void> {
	await page.goto("/login");
	await page
		.locator('input[name="email"], input[type="email"]')
		.first()
		.fill(E2E_EMAIL);
	await page
		.locator('input[name="password"], input[type="password"]')
		.first()
		.fill(E2E_PASSWORD);
	await page
		.getByRole("button", { name: /log\s?in|sign\s?in|continue/i })
		.first()
		.click();
	// Landed in the app shell (post-auth redirect → /o).
	await page.waitForURL(/\/(o|onboarding|w)\b/, { timeout: 15_000 });
}

const base64url = (value: string) => Buffer.from(value).toString("base64url");

// The token the verification email carries: Better Auth's HS256 JWT of
// { email }, signed with the API's AUTH_SECRET. Locally the email stays in the
// API's memory, so specs mint the same token instead of reading it.
export function verificationToken(email: string, secret: string): string {
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

// The questionnaire version the onboarding page sends, read from its source so
// the seed stays in step when it changes. Importing the page would drag React,
// Lingui macros and the @/ alias into Playwright's loader.
function onboardingAnswersVersion(): string {
	const file = path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		"../src/routes/onboarding/OnboardingRoute.tsx",
	);
	const version = readFileSync(file, "utf8").match(/version: "([^"]*)"/)?.[1];
	if (!version) throw new Error(`no questionnaire version found in ${file}`);
	return version;
}

// A verified account that has finished onboarding with an organisation named
// orgName, made through the same /api calls the register, verify and
// onboarding pages make (.agents/skills/verify-dembrane/scripts/seed-user.sh).
// Needs AUTH_SECRET. The account lands on the home page at its first login.
export async function seedOnboardedUser(
	request: APIRequestContext,
	baseURL: string,
	orgName: string,
): Promise<{ email: string; password: string }> {
	if (!AUTH_SECRET) throw new Error("set E2E_AUTH_SECRET to seed a user");
	const email = `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
	const password = "Abcdefgh1!xyz";
	// Through the dashboard's /api proxy with its Origin, as the page sends it.
	const headers = { Origin: baseURL };
	const post = async (url: string, data: unknown) => {
		const response = await request.post(`${baseURL}${url}`, { data, headers });
		if (!response.ok())
			throw new Error(
				`POST ${url}: ${response.status()} ${await response.text()}`,
			);
	};

	await post("/api/v2/auth/register", {
		email,
		first_name: "E2E",
		password,
		verification_url: `${baseURL}/verify-email`,
	});
	// The API answers with a redirect to the login page; don't follow it.
	const verified = await request.get(
		`${baseURL}/api/auth/verify-email?token=${verificationToken(email, AUTH_SECRET)}`,
		{ headers, maxRedirects: 0 },
	);
	if (verified.status() >= 400)
		throw new Error(`verify-email: ${verified.status()}`);

	await post("/api/auth/sign-in/email", { email, password });
	await post("/api/v2/onboarding/complete", { org_name: orgName });
	// Skips the "About you" question as its Skip button does; without an answer,
	// every login sends the account back to that step.
	await post("/api/v2/onboarding/answers", {
		data: [],
		skipped: true,
		version: onboardingAnswersVersion(),
	});
	return { email, password };
}
