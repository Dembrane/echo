import { describe, expect, it } from "vitest";
import {
	buildWordDiff,
	ELISION_MARK,
	elideUnchangedRuns,
	needsWordDiff,
} from "./wordDiff";

describe("buildWordDiff", () => {
	it("marks the words that were removed and the words that were added", () => {
		const diff = buildWordDiff(
			"We want to hear from residents about the park.",
			"We want to hear from residents and shopkeepers about the park.",
		);
		expect(diff.unavailable).toBe(false);
		expect(diff.hasChanges).toBe(true);
		expect(diff.addedWords).toBe(2);
		expect(diff.removedWords).toBe(0);
		const added = diff.chunks
			.filter((chunk) => chunk.added)
			.map((chunk) => chunk.value.trim())
			.join("");
		expect(added).toBe("and shopkeepers");
	});

	it("reports no changes when both sides are the same", () => {
		const diff = buildWordDiff("Same text", "Same text");
		expect(diff.hasChanges).toBe(false);
		expect(diff.addedWords).toBe(0);
		expect(diff.removedWords).toBe(0);
	});

	it("reads a wholesale rewrite as removing everything that was there", () => {
		// Applying a change overwrites the field, so a full rewrite has to look
		// like a full rewrite rather than a quiet append.
		const diff = buildWordDiff("old context here", "a completely new brief");
		expect(diff.removedWords).toBe(3);
		expect(diff.addedWords).toBe(4);
	});

	it("treats an empty current value as pure addition", () => {
		const diff = buildWordDiff("", "brand new context");
		expect(diff.removedWords).toBe(0);
		expect(diff.addedWords).toBe(3);
	});

	it("rebuilds each side from the same chunk list", () => {
		const current = "the quick brown fox";
		const proposed = "the slow brown fox";
		const diff = buildWordDiff(current, proposed);
		const rebuild = (side: "current" | "proposed") =>
			diff.chunks
				.filter((chunk) => (side === "current" ? !chunk.added : !chunk.removed))
				.map((chunk) => chunk.value)
				.join("");
		expect(rebuild("current")).toBe(current);
		expect(rebuild("proposed")).toBe(proposed);
	});
});

describe("elideUnchangedRuns", () => {
	it("shortens a long unchanged middle but keeps context around the edits", () => {
		const filler = "word ".repeat(200).trim();
		const diff = buildWordDiff(`start ${filler} end`, `begin ${filler} end`);
		const elided = elideUnchangedRuns(diff.chunks, 40);
		const middle = elided.find((chunk) => chunk.elided);
		expect(middle).toBeDefined();
		expect(middle?.value).toContain(ELISION_MARK);
		expect(middle?.value.length).toBeLessThan(filler.length);
	});

	it("leaves a short unchanged run alone", () => {
		const diff = buildWordDiff("alpha beta gamma", "delta beta gamma");
		const elided = elideUnchangedRuns(diff.chunks, 140);
		expect(elided.some((chunk) => chunk.elided)).toBe(false);
	});

	it("never elides an added or removed run", () => {
		const long = "sentence ".repeat(100).trim();
		const diff = buildWordDiff("", long);
		const elided = elideUnchangedRuns(diff.chunks, 10);
		expect(elided.every((chunk) => !chunk.elided)).toBe(true);
		expect(elided.map((chunk) => chunk.value).join("")).toBe(long);
	});
});

describe("needsWordDiff", () => {
	it("is false for short single-line values", () => {
		expect(needsWordDiff("Old title", "New title")).toBe(false);
	});

	it("is true once either side is long", () => {
		expect(needsWordDiff("short", "x".repeat(200))).toBe(true);
	});

	it("is true for multi-line values however short", () => {
		expect(needsWordDiff("a\nb", "a\nc")).toBe(true);
	});

	it("is false for non-string proposals such as booleans", () => {
		expect(needsWordDiff(true, false)).toBe(false);
	});
});
