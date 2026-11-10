import { expect, type Page, test } from "@playwright/test";
import {
	DIGEST_RESULT_EN,
	DIGEST_RESULT_NL,
} from "../src/components/project/digest/digest.fixture";
import {
	makeDocx,
	makePdf,
	makePptx,
} from "../src/components/project/digest/extract/fixtures";

// ECHO-1055: "Start from your documents" on the template picker. Real generated PDF, DOCX
// and PPTX files go into the drop zone; the browser reads them, the digest endpoint is
// answered here. The entry row, the reading states, the review with every section, a
// section's provenance, an edited section, the failure fallback and the scanned-PDF
// refusal, at desktop and phone width, in English and Dutch. A network capture checks
// that only text leaves the browser. E2E_SHOTS=<dir> also saves screenshots.
const shots = process.env.E2E_SHOTS;
const sizes = [
	{ height: 900, name: "desktop", width: 1280 },
	{ height: 844, name: "phone", width: 390 },
];

const INVITATION = makePdf([
	[
		"Uitnodiging bewonersavond Kanaalzone-Oost",
		"Gemeente Veldhoven-Noord en woningcorporatie Thuisbasis nodigen je uit.",
		"Donderdag 4 december, 19.30 tot 21.30 uur",
		"Locatie: Wijkcentrum De Schakel, Sluisweg 12",
	],
	["Aanmelden bij Ilse Verbeek, i.verbeek@thuisbasis.example of 06-41234567."],
]);
const AGENDA = makeDocx([
	"Agenda bewonersavond Kanaalzone-Oost",
	"19.30 Welkom door wethouder Ramon Dijkhuis",
	"19.45 Ronde 1: Wat gaat goed in de Kanaalzone-Oost?",
	"20.35 Ronde 2: Wat moet anders aan de groenstrook langs de Sluisweg?",
]);
const SLIDES = makePptx([
	{
		lines: [
			"Bewonersavond Kanaalzone-Oost",
			"Bewoners praten aan tafels in twee rondes",
		],
	},
	{
		lines: ["Ronde 1", "Wat gaat goed?"],
		notes: ["Laat iedereen kort aan het woord."],
	},
]);
const SCAN = makePdf([null, null]);

const files = {
	agenda: {
		buffer: Buffer.from(AGENDA),
		mimeType:
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		name: "agenda.docx",
	},
	invitation: {
		buffer: Buffer.from(INVITATION),
		mimeType: "application/pdf",
		name: "uitnodiging-bewonersavond.pdf",
	},
	scan: {
		buffer: Buffer.from(SCAN),
		mimeType: "application/pdf",
		name: "scan.pdf",
	},
	slides: {
		buffer: Buffer.from(SLIDES),
		mimeType:
			"application/vnd.openxmlformats-officedocument.presentationml.presentation",
		name: "programma.pptx",
	},
};

type Answer = "result" | "fail" | "hold";

async function answerApi(page: Page, nl: boolean, answer: () => Answer) {
	const sent: { url: string; body: string; type: string }[] = [];
	page.on("request", (r) => {
		if (r.method() !== "GET")
			sent.push({
				body: r.postData() ?? "",
				type: r.headers()["content-type"] ?? "",
				url: r.url(),
			});
	});
	let release: (() => void) | null = null;
	await page.route("**/v2/workspaces/w1/free-allowance**", (route) =>
		route.fulfill({ json: { free: false } }),
	);
	await page.route(
		"**/v2/workspaces/w1/project-setup/digest",
		async (route) => {
			const a = answer();
			if (a === "hold")
				await new Promise<void>((r) => {
					release = r;
				});
			if (a === "fail")
				return route.fulfill({
					json: { code: "project.setup_suggestions_unavailable" },
					status: 503,
				});
			return route.fulfill({ json: nl ? DIGEST_RESULT_NL : DIGEST_RESULT_EN });
		},
	);
	await page.route("**/v2/workspaces/w1/projects", (route) =>
		route.fulfill({ json: { id: "p9", name: "x", workspace_id: "w1" } }),
	);
	return { release: () => release?.(), sent };
}

for (const size of sizes)
	for (const lang of ["en-US", "nl-NL"])
		test(`digest harness, ${size.name}, ${lang}`, async ({ page }) => {
			test.setTimeout(120_000);
			const nl = lang === "nl-NL";
			const errors: string[] = [];
			page.on("pageerror", (e) => errors.push(e.message));
			await page.setViewportSize({ height: size.height, width: size.width });
			await page.addInitScript((l) => {
				localStorage.setItem("dembrane-language", l);
			}, lang);
			let answer: Answer = "hold";
			const api = await answerApi(page, nl, () => answer);
			const shot = async (name: string, full = true) => {
				if (shots)
					await page.screenshot({
						fullPage: full,
						path: `${shots}/${size.name}-${lang}-${name}.png`,
					});
			};
			const noSideScroll = async () =>
				expect(
					await page.evaluate(
						() => document.documentElement.scrollWidth <= window.innerWidth,
					),
				).toBe(true);

			await page.goto(
				`/e2e/templates-harness.html?path=/${lang}/w/w1/projects/new`,
			);
			const entry = page.getByTestId("project-digest-entry");
			await expect(entry).toBeVisible();
			await expect(page.getByTestId("template-picker")).toBeVisible();
			await expect(page.getByTestId("project-digest-privacy")).toBeVisible();
			await shot("01-entry", false);
			await noSideScroll();

			// The scanned PDF is refused on this device; nothing is sent.
			const input = page.locator(
				"[data-testid=project-digest-dropzone] input[type=file]",
			);
			await input.setInputFiles([files.scan]);
			await expect(
				page.getByTestId("project-digest-file-0-reason"),
			).toContainText(nl ? "scan" : "scan");
			await expect(page.getByTestId("template-picker")).toBeVisible();
			await shot("02-scanned-refused", false);
			expect(api.sent.filter((s) => s.url.includes("digest"))).toHaveLength(0);

			// Three real files: read here, then "Reading your material" while held.
			await input.setInputFiles([files.invitation, files.agenda, files.slides]);
			await expect(
				page.getByTestId("project-digest-progress-status"),
			).toContainText(
				nl ? "Je materiaal wordt gelezen" : "Reading your material",
			);
			await expect(page.getByTestId("template-picker")).toBeHidden();
			await shot("03-reading", false);
			await noSideScroll();
			answer = "result";
			api.release();

			const review = page.getByTestId("project-digest-review");
			await expect(review).toBeVisible();
			for (const id of [
				"name",
				"goal",
				"context",
				"key-terms",
				"template",
				"tags",
				"verify",
				"name-label",
				"explore",
				"host-steps",
			])
				await expect(
					page.getByTestId(`project-digest-section-${id}`),
				).toBeVisible();
			await page.waitForTimeout(300);
			await shot("04-review");
			await noSideScroll();

			// Provenance: the source on the button, the words on focus.
			const from = page.getByTestId("project-digest-provenance-goal");
			await from.scrollIntoViewIfNeeded();
			await from.focus();
			await expect(page.getByRole("tooltip")).toContainText("Samen met jou");
			await page.waitForTimeout(200);
			await shot("05-provenance", false);

			// Edited: the goal rewritten, the Explore question switched off, another template.
			await page
				.getByTestId("project-digest-goal")
				.fill(
					nl
						? "Weten wat bewoners willen aan de Sluisweg."
						: "Learn what residents want at the Sluisweg.",
				);
			await page
				.getByTestId("project-digest-section-explore-switch")
				.evaluate((el) => (el as HTMLInputElement).click());
			await page.getByTestId("project-digest-runner-up-world_cafe").click();
			await page
				.getByTestId("project-digest-section-goal")
				.scrollIntoViewIfNeeded();
			await page.waitForTimeout(300);
			await shot("06-edited");

			// The network: only text and names went out, never a file's bytes.
			const digestCalls = api.sent.filter((s) =>
				s.url.includes("project-setup/digest"),
			);
			expect(digestCalls).toHaveLength(1);
			for (const s of api.sent) {
				expect(s.type).not.toContain("multipart");
				expect(s.body).not.toContain("%PDF");
				expect(s.body).not.toContain("PK\u0003\u0004");
			}
			const body = JSON.parse(digestCalls[0]?.body ?? "{}");
			expect(body.sources.map((x: { name: string }) => x.name)).toEqual([
				"uitnodiging-bewonersavond.pdf",
				"agenda.docx",
				"programma.pptx",
			]);
			expect(Object.keys(body.sources[0]).sort()).toEqual([
				"kind",
				"name",
				"text",
			]);
			expect(body.sources[0].text).toContain("Wijkcentrum De Schakel");
			expect(body.sources[2].text).toContain("Speaker notes: Laat iedereen");

			// Create sends the template and what is on, in one request.
			await page.getByTestId("project-digest-create").click();
			await expect(page.getByTestId("harness-landed")).toBeAttached();
			const create = api.sent.find((s) =>
				s.url.endsWith("/v2/workspaces/w1/projects"),
			);
			const created = JSON.parse(create?.body ?? "{}");
			expect(created.template_key).toBe("world_cafe");
			expect(created.digest.goal).toContain("Sluisweg");
			expect(created.digest.explore_prompt).toBeUndefined();
			expect(created.digest.key_terms).toHaveLength(5);

			// The failure fallback: the picker with the text in the context.
			answer = "fail";
			await page.goto(
				`/e2e/templates-harness.html?path=/${lang}/w/w1/projects/new`,
			);
			await page
				.locator("[data-testid=project-digest-dropzone] input[type=file]")
				.setInputFiles([files.agenda]);
			await expect(page.getByTestId("project-digest-fallback")).toBeVisible();
			await expect(page.getByTestId("template-picker")).toBeVisible();
			await shot("07-fallback", false);
			await page.getByTestId("template-card-resident_evening").click();
			await page.getByTestId("create-project-template-continue").click();
			await expect(
				page.getByLabel(nl ? "Projectcontext" : "Project context"),
			).toHaveValue(/Ronde 1: Wat gaat goed/);
			await shot("08-fallback-context");

			expect(errors).toEqual([]);
		});
