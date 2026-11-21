import { expect, type Page, test } from "@playwright/test";

// ECHO-1052: every portal state of Verify and Explore at phone width, and the portal
// editor's Verify and Explore sections at desktop width, in English and Dutch.
// E2E_SHOTS=<dir> also saves screenshots.
const shots = process.env.E2E_SHOTS;

async function answerApi(page: Page) {
	// Anything the seeded queries do not cover answers empty, as a fresh project would.
	await page.route("**/api/**", (route) => route.fulfill({ json: {} }));
}

const open = async (page: Page, view: string, lang: string) => {
	await page.addInitScript((l) => {
		localStorage.setItem("dembrane-language", l);
	}, lang);
	await answerApi(page);
	await page.goto(`/e2e/verify-explore-harness.html?view=${view}&lang=${lang}`);
};

const noSideScroll = (page: Page) =>
	page.evaluate(
		() => document.documentElement.scrollWidth <= window.innerWidth,
	);

for (const lang of ["en-US", "nl-NL"]) {
	const nl = lang === "nl-NL";

	test(`portal states at 390px, ${lang}`, async ({ page }) => {
		const errors: string[] = [];
		page.on("pageerror", (e) => errors.push(e.message));
		await page.setViewportSize({ height: 844, width: 390 });
		const shot = async (name: string) => {
			if (shots)
				await page.screenshot({
					fullPage: true,
					path: `${shots}/portal-${lang}-${name}.png`,
				});
		};

		for (const [view, label] of [
			["button-verify", nl ? "Verifiëren" : "Verify"],
			["button-explore", nl ? "Verkennen" : "Explore"],
			// Both on: the product name, in every language.
			["button-both", "ECHO"],
		] as const) {
			await open(page, view, lang);
			await expect(page.getByTestId("portal-audio-echo-button")).toHaveText(
				label,
			);
			await shot(view);
			expect(await noSideScroll(page)).toBe(true);
		}

		await open(page, "choice-both", lang);
		const verify = page.getByTestId("portal-echo-verify-card");
		const explore = page.getByTestId("portal-echo-explore-card");
		await expect(verify).toBeVisible();
		await expect(explore).toBeVisible();
		for (const choice of [verify, explore]) {
			const box = await choice.boundingBox();
			expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
		}
		await shot("choice-both");
		await page.keyboard.press("Tab");
		await expect(verify).toBeFocused();
		await shot("choice-both-focus");
		expect(await noSideScroll(page)).toBe(true);

		await open(page, "picker", lang);
		await expect(
			page.getByTestId("portal-verify-topic-agreements"),
		).toBeVisible();
		await page.getByTestId("portal-verify-topic-heard").click();
		await expect(page.getByTestId("portal-verify-topic-heard")).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		await expect(
			page.getByTestId("portal-verify-selection-next-button"),
		).toBeEnabled();
		await page.mouse.move(0, 0);
		await page.waitForTimeout(300);
		await shot("picker");
		expect(await noSideScroll(page)).toBe(true);

		await open(page, "reminder", lang);
		await page.getByTestId("portal-audio-stop-finish-button").click();
		await expect(page.getByTestId("portal-audio-verify-button")).toBeVisible();
		await page.waitForTimeout(300);
		await shot("reminder");

		expect(errors).toEqual([]);
	});

	test(`portal editor Verify and Explore at 1280px, ${lang}`, async ({
		page,
	}) => {
		const errors: string[] = [];
		page.on("pageerror", (e) => errors.push(e.message));
		await page.setViewportSize({ height: 900, width: 1280 });
		await open(page, "editor", lang);
		const cross = page.getByTestId("portal-editor-cross-pollination-switch");
		await expect(cross).toBeAttached();
		await expect(
			page.getByTestId("portal-editor-verify-topic-heard"),
		).toBeAttached();
		await expect(
			page.getByTestId("portal-editor-ask-email-checkbox"),
		).toHaveCount(0);
		const explore = page.getByTestId("portal-editor-go-deeper-switch");
		await explore.scrollIntoViewIfNeeded();
		if (shots) {
			const section = page.locator("form").first();
			await section.screenshot({ path: `${shots}/editor-${lang}-full.png` });
			await page
				.getByTestId("portal-editor-go-deeper-switch")
				.locator(
					"xpath=ancestor::div[contains(@class,'mantine-Stack-root')][2]",
				)
				.screenshot({ path: `${shots}/editor-${lang}-explore-verify.png` });
		}
		expect(errors).toEqual([]);
	});
}

// The recorder's footer (the ECHO, Verify or Explore button beside Stop) stays on one row
// on a 390px phone in the languages with the longest words.
for (const lang of ["nl-NL", "de-DE"]) {
	test(`recorder footer on one row at 390px, ${lang}`, async ({ page }) => {
		await page.setViewportSize({ height: 844, width: 390 });
		for (const view of ["button-both", "button-verify", "button-explore"]) {
			await open(page, view, lang);
			const refine = page.getByTestId("portal-audio-echo-button");
			const stop = page.getByTestId("portal-audio-stop-button");
			await expect(refine).toBeVisible();
			if (view === "button-both") await expect(refine).toHaveText("ECHO");
			const [a, b] = [await refine.boundingBox(), await stop.boundingBox()];
			expect([view, Math.abs((a?.y ?? 0) - (b?.y ?? 1)) < 2]).toEqual([
				view,
				true,
			]);
			expect(await noSideScroll(page)).toBe(true);
			if (shots && lang === "de-DE")
				await page.screenshot({
					fullPage: true,
					path: `${shots}/portal-${lang}-${view}.png`,
				});
		}
	});
}
