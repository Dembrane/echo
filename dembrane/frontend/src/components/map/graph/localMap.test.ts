import { describe, expect, it } from "vitest";
import { createSyntheticMap, mulberry32 } from "../fixtures/syntheticMap";
import {
	buildLocalMapForces,
	computeAdaptiveNeighbors,
	computeKNN,
} from "./localMap";

describe("computeAdaptiveNeighbors", () => {
	it("uses min(10, n - 1) below 10000 points", () => {
		expect(computeAdaptiveNeighbors(5)).toBe(4);
		expect(computeAdaptiveNeighbors(200)).toBe(10);
	});

	it("grows logarithmically from 10000 points", () => {
		expect(computeAdaptiveNeighbors(20000)).toBe(14);
	});
});

describe("computeKNN", () => {
	it("lists the k nearest other nodes, closest first", () => {
		const nodes = [
			{ embedding: [1, 0], id: "a" },
			{ embedding: [0.9, 0.1], id: "b" },
			{ embedding: [0, 1], id: "c" },
		];
		const knn = computeKNN(nodes, 1);
		expect(knn.get("a")?.map((n) => n.id)).toEqual(["b"]);
		expect(knn.get("c")?.map((n) => n.id)).toEqual(["b"]);
	});
});

describe("buildLocalMapForces", () => {
	it.each([
		[5, 4],
		[20, 10],
		[150, 10],
	])("with %i nodes uses k = %i and n * k NN links", (count, k) => {
		const nodes = createSyntheticMap({ count });
		const { nnLinks } = buildLocalMapForces(nodes, 0.2, 2.0, mulberry32(7));
		expect(nnLinks).toHaveLength(count * k);
		expect(nnLinks.every((link) => link.strength === 1)).toBe(true);
	});

	it("is deterministic for a seeded random source", () => {
		const nodes = createSyntheticMap({ count: 40 });
		const first = buildLocalMapForces(nodes, 0.2, 2.0, mulberry32(3));
		const second = buildLocalMapForces(nodes, 0.2, 2.0, mulberry32(3));
		expect(second).toEqual(first);
		expect(first.mnLinks.length).toBeGreaterThan(0);
		expect(first.fpLinks.every((link) => link.source !== link.target)).toBe(
			true,
		);
	});

	it("keeps mid-near pairs out of the k-NN pairs", () => {
		const nodes = createSyntheticMap({ count: 40 });
		const { nnLinks, mnLinks } = buildLocalMapForces(
			nodes,
			0.2,
			2.0,
			mulberry32(11),
		);
		const knn = new Set(nnLinks.map((l) => `${l.source}-${l.target}`));
		for (const link of mnLinks) {
			expect(knn.has(`${link.source}-${link.target}`)).toBe(false);
			expect(knn.has(`${link.target}-${link.source}`)).toBe(false);
		}
	});

	it("returns no links below two nodes", () => {
		const { nnLinks, mnLinks, fpLinks } = buildLocalMapForces(
			createSyntheticMap({ count: 1 }),
		);
		expect([nnLinks, mnLinks, fpLinks]).toEqual([[], [], []]);
	});
});
