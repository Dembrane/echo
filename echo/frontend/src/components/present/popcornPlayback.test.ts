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
		createElement: () => ({ className: "", textContent: "" }),
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
	const words = {
		replaceChildren(fragment: { children: Array<{ textContent: string }> }) {
			this.textContent = fragment.children
				.map((child) => child.textContent)
				.join("");
		},
		textContent: text,
	};
	const classes = new Set<string>();
	return {
		el: {
			classList: {
				add: (name: string) => classes.add(name),
				contains: (name: string) => classes.has(name),
				remove: (name: string) => classes.delete(name),
			},
			querySelector: (selector: string) =>
				selector === ".pop-words" ? words : null,
		},
		words,
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("Popcorn bilingual playback", () => {
	it("gives each language its full word-count read around the letter morph", () => {
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

		for (
			let elapsed = 0;
			elapsed < 200 && rec.languagePhase !== "translation";
			elapsed++
		) {
			vi.advanceTimersByTime(1);
		}
		expect(phrase.words.textContent).toBe(item.translation);
		expect(rec.languagePhase).toBe("translation");
		expect(beginFade).not.toHaveBeenCalled();

		vi.advanceTimersByTime(4_499);
		expect(beginFade).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(beginFade).toHaveBeenCalledOnce();
	});

	it("renders no visible Original or Translation cue", () => {
		vi.useFakeTimers();
		const api = playback();
		const item = { phrase: "Original words", translation: "Vertaalde woorden" };
		expect(api.phraseStateHtml(item)).toBe(
			'<span class="pop-words">Original words</span>',
		);
		expect(api.phraseStateHtml(item, true)).toBe(
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
