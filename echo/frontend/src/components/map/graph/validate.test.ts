import { describe, expect, it } from "vitest";
import { createSyntheticMap } from "../fixtures/syntheticMap";
import type { MapGraphNode } from "../types";
import { partitionByEmbedding } from "./validate";

const withEmbedding = (id: string, embedding: unknown): MapGraphNode => ({
	...createSyntheticMap({ count: 1 })[0],
	embedding: embedding as number[],
	id,
});

describe("partitionByEmbedding", () => {
	it("keeps valid nodes and reports each rejected one with its reason", () => {
		const nodes = [
			withEmbedding("ok-1", [1, 0, 0]),
			withEmbedding("empty", []),
			withEmbedding("absent", undefined),
			withEmbedding("nan", [1, Number.NaN, 0]),
			withEmbedding("infinite", [Number.POSITIVE_INFINITY, 0, 0]),
			withEmbedding("zero", [0, 0, 0]),
			withEmbedding("short", [1, 2]),
			withEmbedding("ok-2", [0, 2, 1]),
		];

		const { valid, invalid, dims } = partitionByEmbedding(nodes);

		expect(valid.map((node) => node.id)).toEqual(["ok-1", "ok-2"]);
		expect(invalid).toEqual([
			{ id: "empty", reason: "missing" },
			{ id: "absent", reason: "missing" },
			{ id: "nan", reason: "non-finite" },
			{ id: "infinite", reason: "non-finite" },
			{ id: "zero", reason: "zero" },
			{ id: "short", reason: "dimension" },
		]);
		expect(dims).toBe(3);
	});

	it("takes the dimension from the first valid node", () => {
		const { valid, invalid, dims } = partitionByEmbedding([
			withEmbedding("zero-long", [0, 0, 0, 0]),
			withEmbedding("first", [1, 1]),
			withEmbedding("long", [1, 1, 1]),
		]);
		expect(dims).toBe(2);
		expect(valid.map((node) => node.id)).toEqual(["first"]);
		expect(invalid.map((entry) => entry.reason)).toEqual(["zero", "dimension"]);
	});

	it("reports null dims when nothing is valid", () => {
		expect(partitionByEmbedding([]).dims).toBeNull();
	});
});
