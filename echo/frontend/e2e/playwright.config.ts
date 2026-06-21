import { defineConfig, devices } from "@playwright/test";

// E2E for the partner / observer flows (Waves F & G). Runs against the local
// dev app (Vite on :5173 → API on :8000 → Directus). Authenticated specs need
// a seeded partner-org login provided via env (E2E_EMAIL / E2E_PASSWORD); the
// smoke spec needs no auth. See e2e/README.md.
export default defineConfig({
	testDir: ".",
	timeout: 30_000,
	expect: { timeout: 10_000 },
	fullyParallel: false,
	reporter: [["list"]],
	use: {
		baseURL: process.env.E2E_BASE_URL ?? "http://localhost:5173",
		screenshot: "only-on-failure",
		trace: "retain-on-failure",
	},
	projects: [
		{ name: "chromium", use: { ...devices["Desktop Chrome"] } },
	],
});
