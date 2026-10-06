import { defineConfig, devices } from "@playwright/test";

// The rendered design-grammar checks (e2e/grammar.spec.ts), kept out of the
// default e2e run. Runs against a local dev app on :5189 (the only origin the
// local API trusts) with a verified login from the environment:
//
//   GRAMMAR_E2E_EMAIL=… GRAMMAR_E2E_PASSWORD=… \
//   GRAMMAR_E2E_WORKSPACE_ID=… GRAMMAR_E2E_PROJECT_ID=… \
//   pnpm test:grammar
//
// GRAMMAR_E2E_BASE_URL overrides http://localhost:5189; GRAMMAR_E2E_BROWSER_PATH
// points at a Chromium executable when Playwright's own is not installed.
// Results land in test-results/grammar-report.json.
export default defineConfig({
	expect: { timeout: 10_000 },
	fullyParallel: false,
	globalSetup: "./grammar.global-setup.ts",
	outputDir: "../test-results/grammar",
	projects: [
		{
			name: "grammar-desktop",
			use: {
				...devices["Desktop Chrome"],
				viewport: { height: 800, width: 1280 },
			},
		},
		{
			name: "grammar-phone",
			use: {
				...devices["Desktop Chrome"],
				hasTouch: true,
				isMobile: true,
				viewport: { height: 844, width: 390 },
			},
		},
	],
	reporter: [["list"]],
	testDir: ".",
	testMatch: "grammar.spec.ts",
	timeout: 90_000,
	use: {
		baseURL: process.env.GRAMMAR_E2E_BASE_URL ?? "http://localhost:5189",
		launchOptions: process.env.GRAMMAR_E2E_BROWSER_PATH
			? { executablePath: process.env.GRAMMAR_E2E_BROWSER_PATH }
			: {},
		screenshot: "only-on-failure",
		// The report is the record; a trace per failing page costs more than it tells.
		trace: "off",
	},
	workers: 1,
});
