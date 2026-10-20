import { describe, expect, it } from "vitest";
import { activeSentenceIndex, paragraphs } from "./sentences";

const sentences = [
	{ end: 2, start: 0, text: "a" },
	{ end: 5, start: 2.5, text: "b" },
	{ end: 6, start: 5.2, text: "c" },
	{ end: 22, start: 20, text: "d" },
];

describe("activeSentenceIndex", () => {
	it("is none before the first sentence and for no sentences", () => {
		expect(activeSentenceIndex([], 3)).toBe(-1);
		expect(activeSentenceIndex([{ end: 2, start: 1, text: "x" }], 0.5)).toBe(
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
			{ end: 4, start: 0, text: "a" },
			{ end: 8, start: 4.5, text: "b" },
			{ end: 12, start: 10.5, text: "c" },
			{ end: 14, start: 12.2, text: "d" },
		]);
		expect(p.map((x) => x.map((y) => y.index))).toEqual([
			[0, 1],
			[2, 3],
		]);
		expect(paragraphs([])).toEqual([]);
	});
});

describe("paragraphs, long runs", () => {
	const run = (n: number, gap = 0.3, len = 3) =>
		Array.from({ length: n }, (_, i) => ({
			end: i * (len + gap) + len,
			start: i * (len + gap),
			text: `s${i}`,
		}));

	it("breaks a long run with no pause into several paragraphs", () => {
		const p = paragraphs(run(23));
		expect(p.length).toBeGreaterThan(3);
		for (const para of p) expect(para.length).toBeLessThanOrEqual(5);
	});

	it("breaks at the biggest gap in the later part", () => {
		const s = run(8);
		// widen the gap before sentence 4 to 1.5 s (under the 2 s rule)
		for (let i = 4; i < s.length; i++) {
			s[i] = { ...s[i], end: s[i].end + 1.2, start: s[i].start + 1.2 } as never;
		}
		const p = paragraphs(s);
		expect(p[0]?.map((x) => x.index)).toEqual([0, 1, 2, 3]);
	});

	it("breaks on duration as well as count", () => {
		const p = paragraphs(run(8, 0.3, 12));
		expect(p[0]?.length).toBeLessThanOrEqual(4);
		expect(p.length).toBeGreaterThan(1);
	});

	it("still breaks after a pause over two seconds", () => {
		const s = [
			{ end: 3, start: 0, text: "a" },
			{ end: 8, start: 5.5, text: "b" },
		];
		expect(paragraphs(s).map((x) => x.length)).toEqual([1, 1]);
	});

	it("keeps every index, in order, exactly once", () => {
		const flat = paragraphs(run(40)).flat();
		expect(flat.map((x) => x.index)).toEqual(
			Array.from({ length: 40 }, (_, i) => i),
		);
		for (const x of flat) expect(x.sentence.text).toBe(`s${x.index}`);
	});
});
