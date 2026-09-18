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
		// The sandbox has a Math of its own; tests steer the random order.
		Math,
		POP_FLIP_MS: 1_000,
		POP_FLIP_SWAP: 0.36,
		POP_LANGUAGE_HARD_CAP: 24_000,
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
		`${playbackSource}\n;globalThis.playbackApi = { languageReadMs, phraseStateHtml, scheduleBilingualHandoff, owed: () => [...state.pop.bilingualNext.keys()] };`,
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
				owed: () => string[];
				scheduleBilingualHandoff: (
					rec: Record<string, unknown>,
					item: Record<string, unknown>,
				) => void;
			};
		}
	).playbackApi;
}

function phraseElement(text: string) {
	const phrase = { innerHTML: `<span class="pop-words">${text}</span>` };
	const classes = new Set<string>();
	const styles = new Map<string, string>([["--tilt", "-3deg"]]);
	return {
		classes,
		el: {
			classList: {
				add: (name: string) => classes.add(name),
				contains: (name: string) => classes.has(name),
				remove: (name: string) => classes.delete(name),
			},
			querySelector: (selector: string) =>
				selector === ".pop-phrase" ? phrase : null,
			style: {
				getPropertyValue: (name: string) => styles.get(name) ?? "",
				setProperty: (name: string, value: string) => styles.set(name, value),
			},
		},
		phrase,
		styles,
		words: () => />([^<]*)<\/span>/.exec(phrase.innerHTML)?.[1] ?? "",
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("Popcorn bilingual playback", () => {
	it("gives each language its full word-count read around the flip", () => {
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
			translation_language: "nl",
		};

		api.scheduleBilingualHandoff(rec, item);
		expect(api.languageReadMs(item.phrase)).toBe(4_000);
		expect(api.languageReadMs(item.translation)).toBe(4_500);
		vi.advanceTimersByTime(3_999);
		expect(phrase.words()).toBe(item.phrase);
		expect(beginFade).not.toHaveBeenCalled();

		// It pops again: the words change once, at the top of the jump, while
		// the popcorn is edge-on, and it lands in the translation with its mark.
		vi.advanceTimersByTime(1);
		expect(phrase.classes.has("pop-flip")).toBe(true);
		// Thrown, not wound up: it is edge-on 36% of the way in.
		vi.advanceTimersByTime(359);
		expect(phrase.words()).toBe(item.phrase);
		vi.advanceTimersByTime(1);
		expect(phrase.words()).toBe(item.translation);
		expect(phrase.phrase.innerHTML).toContain('class="pop-translated"');
		expect(rec.languagePhase).toBe("morph-translation");
		// Every flip is knocked differently, and tumbles one way or the other.
		expect(["1", "-1"]).toContain(phrase.styles.get("--flip-dir"));
		expect(phrase.styles.get("--kick")).toMatch(/^-?\d+(\.\d)?deg$/);
		vi.advanceTimersByTime(640);
		expect(rec.languagePhase).toBe("translation");
		expect(phrase.classes.has("pop-flip")).toBe(false);
		// The other side of a tilted card leans the other way.
		expect(phrase.styles.get("--tilt")).toBe("3deg");
		expect(beginFade).not.toHaveBeenCalled();

		vi.advanceTimersByTime(4_499);
		expect(beginFade).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(beginFade).toHaveBeenCalledOnce();
	});

	it("pops once per language, the original first and the rest in random order", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-18T00:00:00Z"));
		// Always the last of what is left: fr, then de, then en.
		vi.spyOn(Math, "random").mockReturnValue(0.99);
		const api = playback();
		const phrase = phraseElement("Hallo");
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
			timer: setTimeout(beginFade, 3_500),
		};
		const item = {
			id: "p1",
			phrase: "Hallo",
			translations: [
				{ language: "en", text: "Hello" },
				{ language: "de", text: "Guten Tag" },
				{ language: "fr", text: "Bonjour" },
			],
		};

		api.scheduleBilingualHandoff(rec, item);
		const seen: string[] = [];
		for (
			let elapsed = 0;
			elapsed < 24_000 && !beginFade.mock.calls.length;
			elapsed += 10
		) {
			vi.advanceTimersByTime(10);
			if (seen.at(-1) !== phrase.words()) seen.push(phrase.words());
		}
		expect(seen).toEqual(["Hallo", "Bonjour", "Guten Tag", "Hello"]);
		// With several languages on the go, the mark says which.
		expect(phrase.phrase.innerHTML).toContain(
			'<span class="pop-translated-code">en</span>',
		);
		expect(beginFade).toHaveBeenCalledOnce();
		vi.restoreAllMocks();
	});

	it("owes a language that does not fit this appearance its next fair slot", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-18T00:00:00Z"));
		const api = playback();
		const long = Array.from({ length: 30 }, () => "woord").join(" ");
		const phrase = phraseElement(long);
		const rec = {
			...phrase,
			beginFade: vi.fn(),
			idx: 0,
			itemId: "p1",
			languagePhase: "original",
			pinned: false,
			startedAt: Date.now(),
			tid: "table-1",
			timer: setTimeout(() => {}, 18_000),
		};
		const item = {
			id: "p1",
			phrase: long,
			translations: [
				{ language: "en", text: long.split("woord").join("word") },
			],
		};

		// 18 s for the original and 18 s for the translation cannot share 24 s.
		api.scheduleBilingualHandoff(rec, item);
		vi.advanceTimersByTime(20_000);
		expect(phrase.words()).toBe(long);
		expect(phrase.classes.has("pop-flip")).toBe(false);
		expect(api.owed()).toEqual(["table-1:p1"]);
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
			'<span class="pop-words">Vertaalde woorden</span><span class="pop-translated-wrap"><svg class="pop-translated"',
		);
		// The mark is an icon with a name for screen readers, not words on
		// stage; one language needs no code beside it.
		expect(translated).not.toContain("pop-translated-code");
		expect(
			translated.replace(/<span class="pop-translated-wrap">[\s\S]*$/, ""),
		).toBe('<span class="pop-words">Vertaalde woorden</span>');
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
		expect(phrase.words()).toBe("Hello");
		vi.advanceTimersByTime(1);
		expect(phrase.words()).toBe("Hoi");
		expect(rec.languagePhase).toBe("translation");
		expect(phrase.classes.has("pop-flip")).toBe(false);
	});
});
