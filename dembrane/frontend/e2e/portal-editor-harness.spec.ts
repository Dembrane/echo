import { appendFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { grammarAudit } from "./grammar-checks";

// ECHO-1060: Brief, the portal editor's six pages, one option at a time, each with the
// participant screen it changes in the preview phone (on a phone behind "Preview"), the
// preview's own screens, and Manage's Advanced tab, at desktop and phone width, in English
// and Dutch. The preview frame loads the participant dev server on port 5174
// (pnpm participant:dev) beside the dashboard's on 5173. A network capture checks that the
// preview sends nothing. E2E_SHOTS=<dir> saves screenshots; E2E_GRAMMAR=<file> appends the
// rendered design-grammar audit of every screen, one JSON line each.
const shots = process.env.E2E_SHOTS;
const grammarLog = process.env.E2E_GRAMMAR;
const sizes = [
	{ height: 900, name: "desktop", width: 1280 },
	{ height: 844, name: "phone", width: 390 },
];

const topic = (key: string, en: string, nl: string) => ({
	is_custom: false,
	key,
	translations: { "en-US": { label: en }, "nl-NL": { label: nl } },
});

const project = (nl: boolean) => ({
	anonymize_transcripts: true,
	context: nl
		? "Bewonersavond over het nieuwe Kastanjeplein in Lindenwijk."
		: "Resident evening on the new Kastanjeplein square in Lindenwijk.",
	conversation_ask_for_participant_name_label: nl
		? "Naam of nummer van je tafel"
		: "Table name or number",
	conversation_title_prompt: "",
	default_conversation_ask_for_participant_email: true,
	default_conversation_ask_for_participant_name: true,
	default_conversation_description: nl
		? "Vertel ons wat het plein voor jou moet worden. **Er zijn geen foute antwoorden.**"
		: "Tell us what the square should become for you. **There are no wrong answers.**",
	default_conversation_finish_text: nl
		? "Dank je wel! We delen de uitkomsten in januari."
		: "Thank you! We will share what we heard in January.",
	default_conversation_title: nl
		? "Het nieuwe Kastanjeplein"
		: "The new Kastanjeplein",
	default_conversation_transcript_prompt: "Lindenwijk, Kastanjeplein",
	default_conversation_tutorial_slug: "basic",
	enable_ai_title_and_tags: true,
	get_reply_mode: "summarize",
	get_reply_prompt: "",
	id: "p1",
	is_dembrane_event_cta_enabled: true,
	is_get_reply_cross_pollination_enabled: false,
	is_get_reply_enabled: true,
	is_project_notification_subscription_allowed: true,
	is_verify_enabled: true,
	is_verify_on_finish_enabled: true,
	language: nl ? "nl" : "en",
	methodology_version_id: null,
	name: nl ? "Toekomst van Lindenwijk" : "The future of Lindenwijk",
	selected_verification_key_list: "agreements,actions",
	tags: [
		{ id: "t1", sort: 1, text: nl ? "Ronde 1" : "Round 1" },
		{ id: "t2", sort: 2, text: nl ? "Ronde 2" : "Round 2" },
	],
	updated_at: "2026-11-10T09:00:00Z",
	visibility: "workspace",
	workspace_id: "w1",
});

async function answerApi(page: Page, nl: boolean) {
	await page.route("http://localhost:5173/api/**", (route) => {
		const url = route.request().url();
		if (route.request().method() !== "GET") return route.fulfill({ json: {} });
		if (url.includes("/v2/projects/p1/bff")) {
			if (url.includes("include_legal"))
				return route.fulfill({
					json: {
						_legal: {
							effective: {
								legal_basis: "consent",
								privacy_policy_url: null,
								source: "workspace",
							},
							inherited: {
								legal_basis: "consent",
								privacy_policy_url: null,
								source: "workspace",
							},
							organiser_name: nl ? "Gemeente Lindenwijk" : "Lindenwijk council",
						},
						legal_basis: null,
						privacy_policy_url: null,
					},
				});
			return route.fulfill({ json: project(nl) });
		}
		if (url.includes("/verify/topics/p1"))
			return route.fulfill({
				json: {
					available_topics: [
						topic("agreements", "Table check", "Tafelcheck"),
						topic("disagreements", "Differences", "Verschillen"),
						topic("actions", "Decisions and actions", "Besluiten en acties"),
						topic("gems", "Ideas worth keeping", "Ideeën om te bewaren"),
						topic("truths", "Hard points", "Lastige punten"),
						topic("heard", "What we heard", "Wat we hoorden"),
						topic("moments", "Turning points", "Kantelpunten"),
					],
					selected_topics: ["actions", "agreements"],
				},
			});
		if (url.includes("goal"))
			return route.fulfill({ json: { current: null, revisions: [] } });
		if (url.includes("methodolog")) return route.fulfill({ json: [] });
		if (url.includes("memory")) return route.fulfill({ json: [] });
		if (url.includes("webhook")) return route.fulfill({ json: [] });
		return route.fulfill({ json: [] });
	});
}

// Every page, its options in order, and the preview screens it can pick.
const PAGES: { section: string; options: string[]; screens?: string[] }[] = [
	{
		options: ["language", "title", "description", "tutorial"],
		screens: ["landing", "tutorial", "recording"],
		section: "welcome",
	},
	{ options: ["legal-basis", "anonymise"], section: "privacy" },
	{
		options: [
			"ask-name",
			"name-label",
			"tags",
			"auto-titles",
			"title-prompt",
			"ask-email",
		],
		section: "about",
	},
	{
		options: ["enabled", "mode", "other-conversations"],
		screens: ["explore", "recording"],
		section: "explore",
	},
	{
		options: ["enabled", "topics", "custom-topics", "remind", "key-terms"],
		screens: ["verify-topics", "verify-summary"],
		section: "verify",
	},
	{ options: ["text", "notifications", "event"], section: "finish" },
];

async function audit(page: Page, name: string, phone: boolean) {
	if (!grammarLog) return;
	const result = await page.evaluate(grammarAudit, { phone, portal: false });
	appendFileSync(grammarLog, `${JSON.stringify({ name, ...result })}\n`);
}

async function shot(page: Page, name: string, phone: boolean) {
	if (shots)
		await page.screenshot({ fullPage: !phone, path: `${shots}/${name}.png` });
	await audit(page, name, phone);
}

const previewReady = (page: Page) =>
	expect(page.getByTestId("portal-preview-phone")).toHaveAttribute(
		"data-ready",
		"true",
		{ timeout: 30_000 },
	);

for (const size of sizes)
	for (const lang of ["en-US", "nl-NL"]) {
		const nl = lang === "nl-NL";
		const phone = size.name === "phone";
		test.describe(`${size.name} ${lang}`, () => {
			test.use({ viewport: { height: size.height, width: size.width } });

			test("every portal editor page and option, with its preview", async ({
				page,
			}) => {
				test.setTimeout(600_000);
				await answerApi(page, nl);
				const sent: string[] = [];
				// Anything the frame asks of the API, and any request that is not a read. (The dev
				// server's own page loads a development overlay script; that is not the preview.)
				page.on("request", (req) => {
					if (req.frame() === page.mainFrame()) return;
					if (
						req.url().startsWith("http://localhost:5174/api") ||
						req.method() !== "GET"
					)
						sent.push(`${req.method()} ${req.url()}`);
				});
				for (const { section, options } of PAGES) {
					for (const option of options) {
						await page.goto(
							`/e2e/portal-editor-harness.html?path=/${lang}/w/w1/projects/p1/portal/${section}/${option}`,
						);
						await expect(
							page.getByTestId(`portal-option-${option}-body`),
						).toBeVisible({ timeout: 30_000 });
						if (phone) {
							await shot(
								page,
								`${size.name}-${lang}-portal-${section}-${option}`,
								phone,
							);
							await page.getByTestId("portal-preview-toggle").click();
						}
						await previewReady(page);
						// Let the frame draw its screen and outline.
						await page.waitForTimeout(1200);
						await shot(
							page,
							`${size.name}-${lang}-portal-${section}-${option}${phone ? "-preview" : ""}`,
							phone,
						);
					}
				}
				// The preview fetches nothing and sends nothing.
				expect(sent).toEqual([]);
			});

			test("the preview's screens on their own", async ({ page }) => {
				test.setTimeout(300_000);
				await answerApi(page, nl);
				for (const { section, screens } of PAGES) {
					if (!screens) continue;
					for (const screen of screens) {
						await page.goto(
							`/e2e/portal-editor-harness.html?path=/${lang}/w/w1/projects/p1/portal/${section}`,
						);
						if (phone) await page.getByTestId("portal-preview-toggle").click();
						await previewReady(page);
						await page
							.getByTestId("portal-preview-screen")
							.selectOption(screen);
						await expect(
							page.getByTestId("portal-preview-phone"),
						).toHaveAttribute("data-screen", screen);
						await expect(
							page
								.frameLocator('[data-testid="portal-preview-frame"]')
								.locator(`[data-preview-screen="${screen}"]`),
						).toBeAttached({ timeout: 15_000 });
						await page.waitForTimeout(1200);
						await page.getByTestId("portal-preview-phone").screenshot(
							shots
								? {
										path: `${shots}/${size.name}-${lang}-screen-${screen}.png`,
									}
								: {},
						);
					}
				}
			});

			// ECHO-1061: "Try it" on Explore and Verify against a mocked endpoint: idle,
			// running, the result in the phone, a result from earlier settings, the hour's
			// limit, a failure and its retry, and none of it for an observer.
			test("Try it on Explore and Verify", async ({ page }) => {
				test.setTimeout(300_000);
				await answerApi(page, nl);
				let reply: { status: number; json: unknown } = {
					json: {},
					status: 200,
				};
				const tries: unknown[] = [];
				await page.route(
					"http://localhost:5173/api/v2/projects/p1/portal-editor/try",
					async (route) => {
						const body = route.request().postDataJSON() as {
							kind: string;
							topic_key?: string;
							get_reply_mode?: string;
						};
						tries.push(body);
						// Long enough to see the running state.
						await new Promise((r) => setTimeout(r, 1500));
						if (reply.status !== 200)
							return route.fulfill({ json: reply.json, status: reply.status });
						return route.fulfill({
							json: {
								key:
									body.kind === "explore"
										? body.get_reply_mode
										: body.topic_key,
								kind: body.kind,
								language: nl ? "nl" : "en",
								source: "sample",
								text:
									body.kind === "explore"
										? nl
											? "Wat zou de avond in het park voor jullie veiliger maken?"
											: "What would make the park feel safer for you in the evening?"
										: nl
											? "Concept om samen te verbeteren.\n- Eerst schaduw boven de zandbak.\n- Een waterkraantje.\nKlopt dit? Wat ontbreekt of is te stellig?"
											: "Draft to correct together.\n- Shade over the sandpit first.\n- A water tap.\nIs this right? What is missing or too strong?",
							},
						});
					},
				);
				const sent: string[] = [];
				page.on("request", (req) => {
					if (req.frame() === page.mainFrame()) return;
					if (
						req.url().startsWith("http://localhost:5174/api") ||
						req.method() !== "GET"
					)
						sent.push(`${req.method()} ${req.url()}`);
				});
				const tryState = page.getByTestId("portal-try");
				const phoneFrame = page.frameLocator(
					'[data-testid="portal-preview-frame"]',
				);
				const open = async (section: string, option: string) => {
					await page.goto(
						`/e2e/portal-editor-harness.html?path=/${lang}/w/w1/projects/p1/portal/${section}/${option}`,
					);
					await expect(
						page.getByTestId(`portal-option-${option}-body`),
					).toBeVisible({ timeout: 30_000 });
					if (phone) await page.getByTestId("portal-preview-toggle").click();
					await previewReady(page);
				};
				const name = (state: string) => `${size.name}-${lang}-try-${state}`;

				await open("explore", "mode");
				await expect(tryState).toHaveAttribute("data-status", "idle");
				await shot(page, name("explore-idle"), phone);

				await page.getByTestId("portal-try-button").click();
				await expect(tryState).toHaveAttribute("data-status", "running");
				await shot(page, name("explore-running"), phone);
				await expect(tryState).toHaveAttribute("data-status", "result", {
					timeout: 15_000,
				});
				await expect(
					phoneFrame.getByText(nl ? "veiliger maken" : "feel safer", {
						exact: false,
					}),
				).toBeVisible({ timeout: 15_000 });
				await expect(
					page.getByTestId("portal-preview-sample-note"),
				).toBeVisible();
				await page.waitForTimeout(800);
				await shot(page, name("explore-result"), phone);

				await page.getByTestId("portal-editor-reply-mode-brainstorm").click();
				await expect(page.getByTestId("portal-try-status")).toContainText(
					nl ? "vorige" : "earlier",
				);
				await shot(page, name("explore-stale"), phone);

				// The bodies the API sends: code, action, detail and params.
				reply = {
					json: {
						action: "retry",
						code: "portal.try_failed",
						detail: "The try did not work.",
						params: {},
					},
					status: 502,
				};
				await page.getByTestId("portal-try-button").click();
				await expect(tryState).toHaveAttribute("data-status", "failed", {
					timeout: 15_000,
				});
				await expect(page.getByTestId("portal-try-status")).toHaveText(
					nl
						? "Het proberen is niet gelukt. Probeer het opnieuw."
						: "The try did not work. Try again.",
				);
				await shot(page, name("explore-failed"), phone);

				reply = {
					json: {
						action: "wait",
						code: "rate_limit.exceeded",
						detail: "Too many requests. Try again later.",
						params: {},
					},
					status: 429,
				};
				await page.getByTestId("portal-try-button").click();
				await expect(tryState).toHaveAttribute("data-status", "limit", {
					timeout: 15_000,
				});
				await expect(page.getByTestId("portal-try-button")).toBeDisabled();
				await shot(page, name("explore-limit"), phone);

				reply = { json: {}, status: 200 };
				await open("verify", "topics");
				await page.getByTestId("portal-try-button").click();
				await expect(tryState).toHaveAttribute("data-status", "result", {
					timeout: 15_000,
				});
				await expect(page.getByTestId("portal-preview-phone")).toHaveAttribute(
					"data-screen",
					"verify-summary",
				);
				await expect(
					phoneFrame.getByText(nl ? "zandbak" : "sandpit", { exact: false }),
				).toBeVisible({ timeout: 15_000 });
				await page.waitForTimeout(800);
				await shot(page, name("verify-result"), phone);
				expect(tries).toContainEqual(
					expect.objectContaining({ kind: "verify", topic_key: "actions" }),
				);

				// An observer reads the page without the action.
				await page.goto(
					`/e2e/portal-editor-harness.html?role=observer&path=/${lang}/w/w1/projects/p1/portal/explore/mode`,
				);
				await expect(page.getByTestId("portal-option-mode-body")).toBeVisible({
					timeout: 30_000,
				});
				if (phone) await page.getByTestId("portal-preview-toggle").click();
				await previewReady(page);
				await expect(page.getByTestId("portal-try")).toHaveCount(0);

				// The frame still sends nothing: the dashboard made every try.
				expect(sent).toEqual([]);
			});

			test("Brief and Advanced", async ({ page }) => {
				await answerApi(page, nl);
				await page.goto(
					`/e2e/portal-editor-harness.html?path=/${lang}/w/w1/projects/p1/brief`,
				);
				await expect(page.getByTestId("project-brief-key-terms")).toBeVisible({
					timeout: 30_000,
				});
				await shot(page, `${size.name}-${lang}-brief`, phone);
				await page.goto(
					`/e2e/portal-editor-harness.html?path=/${lang}/w/w1/projects/p1/advanced`,
				);
				await expect(page.getByTestId("project-advanced")).toBeVisible({
					timeout: 30_000,
				});
				await shot(page, `${size.name}-${lang}-advanced`, phone);
			});
		});
	}
