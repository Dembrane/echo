import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

const source = readFileSync(
	new URL("../../../../server/dembrane/popcorn/static/app.js", import.meta.url),
	"utf8",
);
const playbackSource = source.slice(
	source.indexOf("  const phraseWords ="),
	source.indexOf("  // Redraw the phrases on stage"),
);

function playback({ reducedMotion = false } = {}) {
	const state = {
		pop: {
			bilingualNext: new Map(),
			shownTranslation: new Map(),
		},
	};
	const document = {
		createDocumentFragment: () => ({
			appendChild(child: { textContent: string }) {
				this.children.push(child);
			},
			children: [] as Array<{ textContent: string }>,
		}),
		createElement: () => ({
			className: "",
			setAttribute: () => {},
			textContent: "",
		}),
	};
	const context = {
		armPopTimer: (
			rec: Record<string, unknown>,
			name: string,
			fn: () => void,
			delay: number,
		) => {
			clearTimeout(rec[name] as ReturnType<typeof setTimeout> | undefined);
			rec[name] = setTimeout(() => {
				rec[name] = null;
				fn();
			}, delay);
		},
		clearTimeout,
		currentItem: () => null,
		Date,
		document,
		esc: (value: string) => value,
		kindIcon: () => "",
		POP_LANGUAGE_HARD_CAP: 24_000,
		POP_LENS_MS: 1_100,
		POP_READ_BASE: 3_000,
		POP_READ_PER_WORD: 500,
		POP_RESIDENCY_CAP: 24_000,
		POP_TRANSITION_MS: 200,
		phraseText: (item: { phrase?: string; question?: boolean }) => {
			const text = item.phrase || "";
			return item.question && !text.endsWith("?") ? `${text}?` : text;
		},
		setTimeout,
		state,
		tr: (key: string) => key,
		window: { matchMedia: () => ({ matches: reducedMotion }) },
	};
	runInNewContext(
		`${playbackSource}\n;globalThis.playbackApi = { languageReadMs, phraseStateHtml, scheduleBilingualHandoff };`,
		context,
	);
	return (
		context as typeof context & {
			playbackApi: {
				languageReadMs: (text: string) => number;
				phraseStateHtml: (
					item: Record<string, unknown>,
					translated?: boolean,
				) => string;
				scheduleBilingualHandoff: (
					rec: Record<string, unknown>,
					item: Record<string, unknown>,
				) => void;
			};
		}
	).playbackApi;
}

function phraseElement(text: string) {
	const marks: string[] = [];
	const words = {
		insertAdjacentHTML: (_where: string, html: string) => marks.push(html),
		textContent: text,
	};
	const phrase = {
		querySelector: (selector: string) =>
			selector === ".pop-translated" && marks.length
				? { remove: () => marks.splice(0) }
				: null,
	};
	const classes = new Set<string>();
	const lenses: unknown[] = [];
	return {
		classes,
		el: {
			appendChild: (child: unknown) => lenses.push(child),
			classList: {
				add: (name: string) => classes.add(name),
				contains: (name: string) => classes.has(name),
				remove: (name: string) => classes.delete(name),
			},
			querySelector: (selector: string) =>
				selector === ".pop-words"
					? words
					: selector === ".pop-phrase"
						? phrase
						: selector === ".pop-lens" && lenses.length
							? { remove: () => lenses.splice(0) }
							: null,
			style: { setProperty: () => {} },
		},
		lenses,
		marks,
		words,
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("Popcorn bilingual playback", () => {
	it("gives each language its full word-count read around the lens", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-18T00:00:00Z"));
		const api = playback();
		const phrase = phraseElement("One thought");
		const beginFade = vi.fn();
		const rec = {
			...phrase,
			beginFade,
			idx: 0,
			itemId: "p1",
			languagePhase: "original",
			pinned: false,
			startedAt: Date.now(),
			tid: "table-1",
			timer: setTimeout(beginFade, 4_000),
		};
		const item = {
			id: "p1",
			phrase: "One thought",
			translation: "Een goed idee",
		};

		api.scheduleBilingualHandoff(rec, item);
		expect(api.languageReadMs(item.phrase)).toBe(4_000);
		expect(api.languageReadMs(item.translation)).toBe(4_500);
		vi.advanceTimersByTime(3_999);
		expect(phrase.words.textContent).toBe(item.phrase);
		expect(beginFade).not.toHaveBeenCalled();

		// The lens is over the phrase: the words change once, at its middle,
		// out of focus, and the translation carries its mark.
		vi.advanceTimersByTime(1);
		expect(phrase.classes.has("pop-language-morph")).toBe(true);
		expect(phrase.lenses).toHaveLength(1);
		vi.advanceTimersByTime(549);
		expect(phrase.words.textContent).toBe(item.phrase);
		vi.advanceTimersByTime(1);
		expect(phrase.words.textContent).toBe(item.translation);
		expect(phrase.marks).toHaveLength(1);
		expect(rec.languagePhase).toBe("morph-translation");
		vi.advanceTimersByTime(550);
		expect(rec.languagePhase).toBe("translation");
		expect(phrase.classes.has("pop-language-morph")).toBe(false);
		expect(phrase.lenses).toHaveLength(0);
		expect(beginFade).not.toHaveBeenCalled();

		vi.advanceTimersByTime(4_499);
		expect(beginFade).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(beginFade).toHaveBeenCalledOnce();
	});

	it("closes a translated phrase with the translate mark and writes no caption", () => {
		vi.useFakeTimers();
		const api = playback();
		const item = { phrase: "Original words", translation: "Vertaalde woorden" };
		expect(api.phraseStateHtml(item)).toBe(
			'<span class="pop-words">Original words</span>',
		);
		const translated = api.phraseStateHtml(item, true);
		expect(translated).toContain(
			'<span class="pop-words">Vertaalde woorden</span><svg class="pop-translated"',
		);
		// The mark is an icon with a name for screen readers, not words on stage.
		expect(translated.replace(/<svg[\s\S]*<\/svg>/, "")).toBe(
			'<span class="pop-words">Vertaalde woorden</span>',
		);
	});

	it("switches immediately after the original dwell when motion is reduced", () => {
		vi.useFakeTimers();
		const api = playback({ reducedMotion: true });
		const phrase = phraseElement("Hello");
		const rec = {
			...phrase,
			beginFade: vi.fn(),
			idx: 0,
			itemId: "p1",
			languagePhase: "original",
			pinned: false,
			startedAt: Date.now(),
			tid: "table-1",
			timer: setTimeout(() => {}, 3_500),
		};
		const item = { id: "p1", phrase: "Hello", translation: "Hoi" };

		api.scheduleBilingualHandoff(rec, item);
		vi.advanceTimersByTime(3_499);
		expect(phrase.words.textContent).toBe("Hello");
		vi.advanceTimersByTime(1);
		expect(phrase.words.textContent).toBe("Hoi");
		expect(rec.languagePhase).toBe("translation");
	});
});
