import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const styles = readFileSync(
	new URL("../../../../server/dembrane/popcorn/static/styles.css", import.meta.url),
	"utf8",
);
const source = readFileSync(
	new URL("../../../../server/dembrane/popcorn/static/app.js", import.meta.url),
	"utf8",
);

// the token block at the top of the sheet, up to the first rule
const baseRoot = styles.slice(
	styles.indexOf(":root {"),
	styles.indexOf("* { margin: 0;"),
);
const darkRoot = styles.slice(
	styles.indexOf(':root[data-theme="dark"] {'),
	styles.indexOf("}", styles.indexOf(':root[data-theme="dark"] {')),
);

// applySession, on its own: the session's language and theme reaching the page
const applySource = source.slice(
	source.indexOf('  let shownLang = "en";'),
	source.indexOf("  // The session's date in the page's language;"),
);

function deck(session: Record<string, unknown> | null) {
	const documentElement: { dataset: Record<string, string>; lang: string } = {
		dataset: {},
		lang: "en",
	};
	const text: Record<string, string> = {};
	const context = {
		applyIntroduction: () => {},
		document: {
			documentElement,
			getElementById: (id: string) => ({
				set textContent(value: string) {
					text[id] = value;
				},
			}),
			querySelector: () => null,
			title: "",
		},
		// no language change, so the relabel branches stay out of the way
		pageLang: () => "en",
		renderDisclaimer: () => {},
		renderQrPanel: () => {},
		sessionDate: () => "",
		state: { session },
		tr: (key: string) => key,
	};
	runInNewContext(`${applySource}\n;globalThis.apply = applySession;`, context);
	(context as typeof context & { apply: () => void }).apply();
	return documentElement;
}

describe("deck dark theme", () => {
	it("redefines the role tokens under :root[data-theme=dark]", () => {
		expect(darkRoot).toContain(':root[data-theme="dark"]');
		for (const token of [
			"--parchment",
			"--graphite",
			"--hairline",
			"--ink-soft",
			"--ink-faint",
			"--brand-grey",
			"--blue",
		]) {
			expect(darkRoot).toMatch(new RegExp(`${token}:\\s*\\S`));
		}
		// the ground goes dark and the ink goes parchment: the names stay, the
		// roles turn over
		expect(darkRoot).toMatch(/--parchment:\s*#1B1B1A/i);
		expect(darkRoot).toMatch(/--graphite:\s*#F6F4F1/i);
	});

	it("keeps the markers bright in both themes", () => {
		for (const marker of ["--m0", "--m1", "--m2", "--m3", "--m4", "--m5"]) {
			expect(baseRoot).toContain(`${marker}:`);
			expect(darkRoot).not.toContain(`${marker}:`);
		}
	});

	it("pins the theme-independent tokens in the base :root only", () => {
		for (const token of ["--on-marker", "--qr-card", "--qr-ink"]) {
			expect(baseRoot).toMatch(new RegExp(`${token}:\\s*#`));
			expect(darkRoot).not.toContain(`${token}:`);
		}
		// a highlighted phrase is a sticky note: graphite ink, never inverted
		expect(baseRoot).toMatch(/--on-marker:\s*#2D2D2C/i);
		// the QR panel stays a light card with dark modules, so phones can scan it
		expect(baseRoot).toMatch(/--qr-card:\s*#F6F4F1/i);
		expect(baseRoot).toMatch(/--qr-ink:\s*#2D2D2C/i);
	});

	it("colours the phrase on the marker with the pinned ink", () => {
		const phrase = styles.slice(
			styles.indexOf(".pop-phrase {"),
			styles.indexOf("}", styles.indexOf(".pop-phrase {")),
		);
		expect(phrase).toContain("background: var(--marker)");
		expect(phrase).toContain("color: var(--on-marker)");
		// the tail's phrases are the same sticky notes in the list
		const tail = styles.slice(
			styles.indexOf(".tail-phrase {"),
			styles.indexOf("}", styles.indexOf(".tail-phrase {")),
		);
		expect(tail).toContain("color: var(--on-marker)");
	});

	it("takes the theme from the session on every apply", () => {
		expect(deck({ theme: "dark" }).dataset.theme).toBe("dark");
		expect(deck({ theme: "light" }).dataset.theme).toBe("light");
	});

	it("falls back to the light room for a missing or junk theme", () => {
		expect(deck({}).dataset.theme).toBe("light");
		expect(deck({ theme: "DARK" }).dataset.theme).toBe("light");
		expect(deck({ theme: "midnight" }).dataset.theme).toBe("light");
		expect(deck({ theme: true as unknown as string }).dataset.theme).toBe("light");
	});

	it("leaves the page alone when there is no session yet", () => {
		expect(deck(null).dataset.theme).toBeUndefined();
	});
});
