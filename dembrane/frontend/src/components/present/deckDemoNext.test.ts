import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(
	new URL(
		"../../../../platform/packages/popcorn/static/app.js",
		import.meta.url,
	),
	"utf8",
);
const audience = readFileSync(
	new URL(
		"../../../../platform/packages/popcorn/static/audience-i18n.js",
		import.meta.url,
	),
	"utf8",
);

// The deck's way on for a prospect, on its own: whether it shows, and what it says.
const block = source.slice(
	source.indexOf("  const isSynthetic = () =>"),
	source.indexOf("  const hasOpening = () =>"),
);
// The page's own words: English and Dutch inline, the rest in audience-i18n.js.
const i18nBlock = source.slice(
	source.indexOf("  const I18N = {"),
	source.indexOf("  // Audience languages are kept separate"),
);

const URL_ = "https://dash.example/login?next=%2Fo%2Forg%2Faccount";

interface Node {
	id?: string;
	className?: string;
	innerHTML: string;
	dataset: Record<string, string>;
	remove: () => void;
}

function footer(
	session: Record<string, unknown>,
	embed: Record<string, unknown> | null = { mode: "public" },
) {
	const nodes = new Map<string, Node>();
	const context = {
		document: {
			createElement: (): Node => ({
				dataset: {},
				innerHTML: "",
				remove() {
					if (this.id) nodes.delete(this.id);
				},
			}),
			getElementById: (id: string) => nodes.get(id) ?? null,
			querySelector: (sel: string) =>
				sel === ".colophon"
					? {
							insertBefore: (el: Node) => {
								nodes.set(el.id as string, el);
							},
						}
					: null,
		},
		EMBED: embed,
		esc: (s: unknown) =>
			String(s ?? "").replace(
				/[&<>"']/g,
				(c) =>
					({
						"'": "&#39;",
						'"': "&quot;",
						"&": "&amp;",
						"<": "&lt;",
						">": "&gt;",
					})[c] as string,
			),
		state: { session },
		tr: (key: string) =>
			({
				"demo.next":
					"This is what you can expect after recording a few conversations. For the full analysis experience, {signIn}",
				"demo.signIn": "sign in →",
			})[key] ?? key,
	};
	runInNewContext(
		`${block}\n;globalThis.render = renderDemoNext; globalThis.url = demoNextUrl;`,
		context,
	);
	const ctx = context as typeof context & {
		render: () => void;
		url: () => string | null;
	};
	ctx.render();
	return { el: nodes.get("demo-next") ?? null, url: ctx.url() };
}

describe("the deck's way on for a prospect's demo", () => {
	it("shows in the footer with the sign-in link when the demo carries one", () => {
		const { el, url } = footer({
			demo: { continue_url: URL_, synthetic: true },
		});
		expect(url).toBe(URL_);
		expect(el?.className).toBe("demo-next");
		expect(el?.innerHTML).toBe(
			`This is what you can expect after recording a few conversations. For the full analysis experience, <a href="${URL_}" target="_blank" rel="noopener">sign in →</a>`,
		);
	});

	it("stays away without a link, for a real session, and off the public page", () => {
		expect(footer({ demo: { synthetic: true } }).el).toBeNull();
		expect(
			footer({ demo: { continue_url: URL_, synthetic: false } }).el,
		).toBeNull();
		expect(footer({ title: "A real session" }).el).toBeNull();
		expect(
			footer({ demo: { continue_url: "javascript:alert(1)", synthetic: true } })
				.el,
		).toBeNull();
		// The host's own deck and the Present shell are signed in already.
		const demo = { demo: { continue_url: URL_, synthetic: true } };
		expect(footer(demo, { mode: "host" }).el).toBeNull();
		expect(footer(demo, { mode: "public", presentationId: "p" }).el).toBeNull();
		expect(footer(demo, null).el).toBeNull();
	});

	it("is worded in every language the deck speaks, with the link kept", () => {
		const context: { window: Record<string, unknown> } = { window: {} };
		runInNewContext(audience, context);
		const { I18N } = runInNewContext(`${i18nBlock}\n;({ I18N });`, {
			window: context.window,
		}) as { I18N: Record<string, Record<string, string>> };
		const keys = Object.keys(I18N.en as Record<string, string>);
		const values = (
			context.window.POPCORN_AUDIENCE_I18N as {
				values: Record<string, string[]>;
			}
		).values;
		const words: Record<string, { next: string; signIn: string }> = {
			en: {
				next: I18N.en?.["demo.next"] ?? "",
				signIn: I18N.en?.["demo.signIn"] ?? "",
			},
			nl: {
				next: I18N.nl?.["demo.next"] ?? "",
				signIn: I18N.nl?.["demo.signIn"] ?? "",
			},
		};
		for (const [language, list] of Object.entries(values)) {
			// The compact arrays follow the English key order, one value per key.
			expect(list.length, language).toBe(keys.length);
			words[language] = {
				next: list[keys.indexOf("demo.next")] as string,
				signIn: list[keys.indexOf("demo.signIn")] as string,
			};
		}
		expect(Object.keys(words).sort()).toEqual(
			["cs", "de", "en", "es", "fr", "it", "nl", "uk"].sort(),
		);
		for (const [language, w] of Object.entries(words)) {
			expect(w.next, language).toContain("{signIn}");
			expect(w.signIn, language).toMatch(/→$/);
		}
		expect(words.nl?.next).toBe(
			"Dit kun je verwachten zodra je een paar gesprekken hebt opgenomen. Voor de volledige analyse kun je {signIn}",
		);
	});
});
