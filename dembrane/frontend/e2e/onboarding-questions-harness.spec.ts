import { appendFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { grammarAudit } from "./grammar-checks";

// The About you questions on the real /onboarding route: the usage question, then the open
// "problem to solve" screen empty, typed, long, recording, transcribing, transcribed, with
// a failed transcription, at the transcription limit and with the microphone refused, at
// desktop and phone width; the feedback dialog, which shares the voice text field, plain
// and with the microphone refused; and the bell, where staff read a long answer clamped
// and expanded, beside the Announcements tab's own Show more. The microphone is Chromium's
// fake device (--use-fake-device-for-media-stream). E2E_SHOTS=<dir> saves screenshots as
// <state>-<width>-<locale>.png; E2E_SHOT_TAG names a second build's feedback shot
// (feedback-dialog<tag>-1280-en-US.png).
const shots = process.env.E2E_SHOTS;
// E2E_GRAMMAR=<file> also runs the rendered design-grammar audit on every problem screen
// and appends its findings to that file, one JSON line per screen.
const grammarLog = process.env.E2E_GRAMMAR;
const tag = process.env.E2E_SHOT_TAG ?? "";
const sizes = [
	{ height: 900, name: "desktop", width: 1280 },
	{ height: 844, name: "phone", width: 390 },
];

// People look at these, so twice the pixels.
test.use({ deviceScaleFactor: 2 });

const TYPED = {
	en: "We run resident evenings and lose most of what people say. We want every table heard.",
	nl: "We organiseren bewonersavonden en verliezen veel van wat mensen zeggen. We willen dat elke tafel gehoord wordt.",
};
const SPOKEN = {
	en: "And the council wants a report the week after.",
	nl: "En de gemeente wil een week later een verslag.",
};

async function answerApi(page: Page) {
	// Onboarded but never answered: the route opens on the questions.
	await page.route("**/v2/me", (route) =>
		route.fulfill({
			json: {
				has_legacy_projects: false,
				has_pending_invites: false,
				is_invited: false,
				onboarding_answer_json: null,
				onboarding_completed: true,
			},
		}),
	);
	await page.route("**/user-settings/me", (route) =>
		route.fulfill({ json: { first_name: "Sam" } }),
	);
	await page.route("**/v2/onboarding/answers", (route) =>
		route.fulfill({ json: { status: "success" } }),
	);
}

for (const size of sizes)
	for (const lang of ["en-US", "nl-NL"])
		test(`onboarding questions harness, ${size.name}, ${lang}`, async ({
			page,
		}) => {
			test.setTimeout(120_000);
			const nl = lang === "nl-NL";
			const l = nl ? "nl" : "en";
			const errors: string[] = [];
			page.on("pageerror", (e) => errors.push(e.message));
			await page.setViewportSize({ height: size.height, width: size.width });
			await page.addInitScript((lng) => {
				localStorage.setItem("dembrane-language", lng);
			}, lang);
			await answerApi(page);
			const shot = async (name: string) => {
				if (shots)
					await page.screenshot({
						fullPage: true,
						path: `${shots}/${name}-${size.width}-${lang}.png`,
					});
				if (grammarLog && name.startsWith("problem")) {
					const audit = await page.evaluate(grammarAudit, {
						phone: size.name === "phone",
						portal: false,
					});
					appendFileSync(
						grammarLog,
						`${JSON.stringify({ lang, name, size: size.name, ...audit })}\n`,
					);
				}
			};
			const noSideScroll = async () =>
				expect(
					await page.evaluate(
						() => document.documentElement.scrollWidth <= window.innerWidth,
					),
				).toBe(true);
			const next = () =>
				page
					.getByRole("button", {
						exact: true,
						name: nl ? "Doorgaan" : "Continue",
					})
					.click();
			const done = page.getByRole("button", {
				exact: true,
				name: nl ? "Klaar" : "Done",
			});

			await page.goto(`/e2e/onboarding-harness.html?path=/${lang}/onboarding`);
			await page.getByLabel(nl ? "Nee" : "No", { exact: true }).check();
			await next();
			await page
				.getByLabel(nl ? "Binnen mijn organisatie" : "Within my organisation")
				.check();
			await page.waitForTimeout(300);
			await shot("usage");
			await next();

			const box = page.getByTestId("onboarding-problem-message");
			await expect(box).toBeVisible();
			await expect(
				page.getByText(
					nl
						? "Welk probleem wil je met dembrane oplossen?"
						: "What problem are you trying to solve with dembrane?",
				),
			).toBeVisible();
			await expect(done).toBeDisabled();
			// The pill fades between its enabled and disabled looks; shoot it settled.
			const settled = async () => {
				await done.evaluate((el) =>
					Promise.all(el.getAnimations().map((a) => a.finished)),
				);
				await page.waitForTimeout(400);
			};
			await settled();
			await shot("problem-empty");
			await noSideScroll();

			await box.fill(TYPED[l]);
			await expect(done).toBeEnabled();
			await settled();
			await shot("problem-typed");

			// Well over a screen of text: the box stops growing and scrolls.
			const long = Array.from({ length: 12 }, () => TYPED[l]).join(" ");
			await box.fill(long);
			await page.waitForTimeout(200);
			await shot("problem-long");
			await noSideScroll();

			await box.fill(TYPED[l]);
			// The transcription is held until the transcribing shot is taken.
			let releaseNow = () => {};
			const held = new Promise<void>((reached) => {
				void page.route("**/stateless/transcribe", async (route) => {
					const go = new Promise<void>((r) => {
						releaseNow = r;
					});
					reached();
					await go;
					await route.fulfill({ json: { note: "", transcript: SPOKEN[l] } });
				});
			});
			await page.getByTestId("onboarding-problem-voice-record").click();
			const stop = page.getByTestId("onboarding-problem-voice-stop");
			await expect(stop).toBeVisible();
			await page.waitForTimeout(1500);
			await expect(done).toBeDisabled();
			await shot("problem-recording");
			await stop.click();
			await held;
			await expect(
				page
					.getByText(
						nl
							? "Je spraaknotitie wordt omgezet naar tekst"
							: "Turning your voice note into text",
					)
					.first(),
			).toBeVisible();
			await expect(done).toBeDisabled();
			await shot("problem-transcribing");
			releaseNow();
			await expect(box).toHaveValue(`${TYPED[l]} ${SPOKEN[l]}`);
			await expect(done).toBeEnabled();
			await settled();
			await shot("problem-transcribed");

			// The transcription fails.
			await page.unroute("**/stateless/transcribe");
			await page.route("**/stateless/transcribe", (route) =>
				route.fulfill({ json: { detail: "bad gateway" }, status: 502 }),
			);
			await page.getByTestId("onboarding-problem-voice-record").click();
			await expect(stop).toBeVisible();
			await page.waitForTimeout(1200);
			await stop.click();
			await expect(
				page.getByTestId("onboarding-problem-voice-record"),
			).toBeVisible();
			await page.waitForTimeout(300);
			await shot("problem-transcribe-failed");

			// The per-person limit: what the platform's limiter answers.
			await page.unroute("**/stateless/transcribe");
			await page.route("**/stateless/transcribe", (route) =>
				route.fulfill({
					json: {
						action: "wait",
						code: "rate_limit.exceeded",
						detail: "Too many requests. Try again later.",
						params: { retry_after_seconds: 3600 },
					},
					status: 429,
				}),
			);
			await page.getByTestId("onboarding-problem-voice-record").click();
			await expect(stop).toBeVisible();
			await page.waitForTimeout(1200);
			await stop.click();
			await expect(
				page.getByText(
					nl
						? "Dat zijn veel spraaknotities in korte tijd. Typ het in, of probeer het later opnieuw."
						: "That is a lot of voice notes in a short time. Type it instead, or try again later.",
				),
			).toBeVisible();
			await page.waitForTimeout(300);
			await shot("problem-rate-limited");

			// The browser refuses the microphone.
			await page.evaluate(() => {
				navigator.mediaDevices.getUserMedia = () =>
					Promise.reject(
						new DOMException("Permission denied", "NotAllowedError"),
					);
			});
			await page.getByTestId("onboarding-problem-voice-record").click();
			await page.waitForTimeout(500);
			await expect(stop).toHaveCount(0);
			await shot("problem-mic-refused");
			// Typing still works.
			await expect(box).toBeEditable();

			expect(errors).toEqual([]);
		});

test("feedback dialog with the microphone refused, desktop, en-US", async ({
	page,
}) => {
	await page.setViewportSize({ height: 900, width: 1280 });
	await page.addInitScript(() => {
		localStorage.setItem("dembrane-language", "en-US");
		navigator.mediaDevices.getUserMedia = () =>
			Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
	});
	await page.goto("/e2e/onboarding-harness.html?path=/en-US/feedback");
	await page.getByTestId("report-issue-voice-record").click();
	const sentence = page.getByText(
		"Your browser is blocking the microphone. Allow access, then try again.",
	);
	await expect(sentence).toBeVisible();
	// Above the field, as on main.
	const box = await page.getByTestId("report-issue-message").boundingBox();
	const notice = await sentence.boundingBox();
	expect(notice && box && notice.y < box.y).toBe(true);
	await page.waitForTimeout(500);
	if (shots)
		await page.screenshot({
			path: `${shots}/feedback-dialog-mic-refused${tag}-1280-en-US.png`,
		});
});

test("feedback dialog, desktop, en-US", async ({ page }) => {
	await page.setViewportSize({ height: 900, width: 1280 });
	await page.addInitScript(() => {
		localStorage.setItem("dembrane-language", "en-US");
	});
	await page.goto("/e2e/onboarding-harness.html?path=/en-US/feedback");
	await expect(page.getByTestId("report-issue-message")).toBeVisible();
	await expect(page.getByTestId("report-issue-voice-record")).toBeVisible();
	await page.waitForTimeout(500);
	if (shots)
		await page.screenshot({
			path: `${shots}/feedback-dialog${tag}-1280-en-US.png`,
		});
});

// About 600 characters, as a person might answer, quoted by the staff notice.
const LONG_ANSWER =
	"We run resident evenings in four neighbourhoods every spring, with about sixty people at ten tables each time. Facilitators take notes by hand, and most of what people say never reaches the report: the notes are short, they are written up days later, and the quieter tables are hardly in them at all. The council asks us for a report within a week, and residents ask us afterwards whether anyone listened. We want every table heard in the words people used, a report we can stand behind, and a way to show residents what was done with what they said.";

const notice = (
	id: string,
	title: string,
	message: string | null,
	minutesAgo: number,
	eventCode = "WORKSPACE_MEMBER_JOINED",
) => ({
	action: "NONE",
	actor_avatar: null,
	actor_name: title.split(": ")[1] ?? "Ana Ruiz",
	actor_user_id: `u-${id}`,
	created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
	event_code: eventCode,
	expires_at: null,
	id,
	message,
	params: null,
	read: false,
	refs: {
		chat_id: null,
		conversation_id: null,
		invite_id: null,
		org_id: null,
		project_id: null,
		report_id: null,
		workspace_id: null,
	},
	scope: null,
	severity: "info",
	title,
});

async function answerBell(page: Page, reads: string[]) {
	await page.route("**/user-settings/me", (route) =>
		route.fulfill({ json: { first_name: "Sam", id: "staff-1" } }),
	);
	await page.route("**/v2/me/notifications", (route) =>
		route.fulfill({
			json: [
				notice(
					"n1",
					"Ana Ruiz joined Sam's workspace",
					"ana.ruiz@example.com joined as a member.",
					4,
				),
				notice(
					"n2",
					"Problem to solve: Jane Doe",
					`jane.doe@example.com: ${LONG_ANSWER}`,
					12,
					"ONBOARDING_PROBLEM_SHARED",
				),
				notice(
					"n3",
					"Onboarding follow-up: Piet de Vries",
					"piet@example.com: Selected serving external clients.",
					40,
					"ONBOARDING_FOLLOWUP",
				),
			],
		}),
	);
	await page.route("**/v2/me/notifications/unread-count", (route) =>
		route.fulfill({ json: { unread: 3 } }),
	);
	await page.route("**/v2/me/notifications/*/read", (route) => {
		reads.push(route.request().url());
		return route.fulfill({ json: { status: "success" } });
	});
	await page.route("**/v2/me/announcements**", (route) =>
		route.fulfill({
			json: [
				{
					activity: [],
					created_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
					expires_at: null,
					id: "a1",
					level: "info",
					translations: [
						{
							languages_code: "en-US",
							message: LONG_ANSWER.replace(
								"We run resident evenings",
								"Live reports now refresh while a session runs. We run resident evenings",
							),
							title: "Live reports during a session",
						},
					],
				},
			],
		}),
	);
}

for (const size of sizes)
	for (const lang of ["en-US", "nl-NL"])
		test(`bell with a long answer, ${size.name}, ${lang}`, async ({ page }) => {
			const nl = lang === "nl-NL";
			const reads: string[] = [];
			const errors: string[] = [];
			page.on("pageerror", (e) => errors.push(e.message));
			await page.setViewportSize({ height: size.height, width: size.width });
			await page.addInitScript((lng) => {
				localStorage.setItem("dembrane-language", lng);
			}, lang);
			await answerBell(page, reads);
			const shot = async (name: string) => {
				if (shots)
					await page.screenshot({
						path: `${shots}/${name}-${size.width}-${lang}.png`,
					});
			};
			await page.goto(`/e2e/onboarding-harness.html?path=/${lang}/inbox`);
			await page.getByRole("button", { name: "Inbox" }).click();
			await expect(page.getByText("Problem to solve: Jane Doe")).toBeVisible();
			// Only the long message gets the control; the short ones fit their two lines.
			const more = page.getByTestId("notification-show-more-button");
			await expect(more).toHaveCount(1);
			await expect(more).toContainText(nl ? "Meer tonen" : "Show more");
			await page.waitForTimeout(500);
			await shot("bell-clamped");

			await more.click();
			await expect(more).toContainText(nl ? "Minder tonen" : "Show less");
			await expect(
				page.getByText(/show residents what was done/),
			).toBeVisible();
			await page.waitForTimeout(300);
			await shot("bell-expanded");
			// Reading on neither marks the notice read nor leaves the bell.
			expect(reads).toEqual([]);
			await expect(page.getByText("Problem to solve: Jane Doe")).toBeVisible();

			if (size.name === "desktop" && !nl) {
				await page.getByRole("tab", { name: /Announcements/ }).click();
				await expect(
					page.getByTestId("announcement-show-more-button"),
				).toBeVisible();
				await page.waitForTimeout(300);
				if (shots)
					await page.screenshot({
						path: `${shots}/bell-announcement-sibling-1280-en-US.png`,
					});
			}
			expect(errors).toEqual([]);
		});
