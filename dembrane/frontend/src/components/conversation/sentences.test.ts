import { describe, expect, it } from "vitest";
import { activeSentenceIndex, paragraphs } from "./sentences";

const sentences = [
	{ start: 0, end: 2, text: "a" },
	{ start: 2.5, end: 5, text: "b" },
	{ start: 5.2, end: 6, text: "c" },
	{ start: 20, end: 22, text: "d" },
];

describe("activeSentenceIndex", () => {
	it("is none before the first sentence and for no sentences", () => {
		expect(activeSentenceIndex([], 3)).toBe(-1);
		expect(activeSentenceIndex([{ start: 1, end: 2, text: "x" }], 0.5)).toBe(
			-1,
		);
	});

	it("is the sentence that has started", () => {
		expect(activeSentenceIndex(sentences, 0)).toBe(0);
		expect(activeSentenceIndex(sentences, 2.5)).toBe(1);
		expect(activeSentenceIndex(sentences, 5.5)).toBe(2);
	});

	it("holds a sentence through a short gap and lets go after a long pause", () => {
		expect(activeSentenceIndex(sentences, 2.2)).toBe(0);
		expect(activeSentenceIndex(sentences, 7.5)).toBe(2);
		expect(activeSentenceIndex(sentences, 12)).toBe(-1);
		expect(activeSentenceIndex(sentences, 21)).toBe(3);
	});
});

describe("paragraphs", () => {
	it("starts a new paragraph only after a pause longer than two seconds", () => {
		const p = paragraphs([
			{ start: 0, end: 4, text: "a" },
			{ start: 4.5, end: 8, text: "b" },
			{ start: 10.5, end: 12, text: "c" },
			{ start: 12.2, end: 14, text: "d" },
		]);
		expect(p.map((x) => x.map((y) => y.index))).toEqual([
			[0, 1],
			[2, 3],
		]);
		expect(paragraphs([])).toEqual([]);
	});
});
