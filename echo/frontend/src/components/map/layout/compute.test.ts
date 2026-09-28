import { describe, expect, it } from "vitest";
import { createSyntheticMap } from "../fixtures/syntheticMap";
import {
	buildLocalMapForces,
	LOCAL_MAP_SEED,
	seededRandom,
} from "../graph/localMap";
import { buildMST, findGraphCenter } from "../graph/mst";
import {
	LayoutBudgetError,
	layoutSteps,
	packVectors,
	runLayoutSync,
} from "./compute";

type EmbeddedNode = { id: string; embedding: number[] };

const layoutOf = (nodes: EmbeddedNode[], nodeLimit = 10_000) =>
	runLayoutSync({ ...packVectors(nodes), nodeLimit });

describe("layout computation", () => {
	it.each([2, 3, 7, 20, 64, 150])(
		"builds exactly buildMST's tree over %i synthetic nodes",
		(count) => {
			const nodes = createSyntheticMap({ count, seed: count });
			expect(layoutOf(nodes).mstEdges).toEqual(buildMST(nodes));
		},
	);

	it("builds exactly buildMST's tree over 768-dimensional vectors", () => {
		const nodes = createSyntheticMap({ count: 40, dims: 768, seed: 5 });
		expect(layoutOf(nodes).mstEdges).toEqual(buildMST(nodes));
	});

	it("keeps buildMST's tie order when vectors repeat", () => {
		const base = createSyntheticMap({ count: 8, dims: 6, seed: 9 });
		const nodes = [
			...base,
			...base.map((node) => ({ ...node, id: `${node.id}-copy` })),
			{ embedding: base[0].embedding, id: "third-copy" },
		];
		expect(layoutOf(nodes).mstEdges).toEqual(buildMST(nodes));
	});

	it.each([2, 5, 30, 150])(
		"finds findGraphCenter's centre over %i nodes",
		(count) => {
			const nodes = createSyntheticMap({ count, seed: 3 });
			const { mstEdges, centerId } = layoutOf(nodes);
			expect(centerId).toBe(findGraphCenter(nodes, mstEdges));
		},
	);

	it.each([5, 40, 150])(
		"builds buildLocalMapForces' neighbour and further pairs over %i nodes with the versioned seed",
		(count) => {
			const nodes = createSyntheticMap({ count, seed: 11 });
			const expected = buildLocalMapForces(
				nodes,
				0.2,
				2.0,
				seededRandom(LOCAL_MAP_SEED),
			);
			const { neighbours } = layoutOf(nodes);
			expect(neighbours.nnLinks).toEqual(expected.nnLinks);
			expect(neighbours.fpLinks).toEqual(expected.fpLinks);
		},
	);

	it("gives the same result for the same input", () => {
		const nodes = createSyntheticMap({ count: 60 });
		const first = layoutOf(nodes);
		const second = layoutOf(nodes);
		expect(second.mstEdges).toEqual(first.mstEdges);
		expect(second.neighbours).toEqual(first.neighbours);
		expect(second.centerId).toBe(first.centerId);
	});

	it("refuses a node set over its budget before any pairwise work", () => {
		// 100,000 nodes have about 5e9 pairs, more than a typed array can hold:
		// only a refusal before the pairwise stage returns this error
		const ids = Array.from({ length: 100_000 }, (_, index) => `n${index}`);
		expect(() =>
			runLayoutSync({
				dims: 0,
				ids,
				nodeLimit: 150,
				vectors: new Float64Array(0),
			}),
		).toThrow(LayoutBudgetError);
	});

	it("refuses at the very first step, before it can pause", () => {
		const nodes = createSyntheticMap({ count: 20 });
		const steps = layoutSteps({ ...packVectors(nodes), nodeLimit: 19 });
		expect(() => steps.next()).toThrow(LayoutBudgetError);
	});

	it.each([
		[149, 150],
		[150, 150],
		[299, 300],
		[300, 300],
	])("admits %i nodes under a budget of %i", (count, nodeLimit) => {
		const nodes = createSyntheticMap({ count, dims: 8 });
		expect(layoutOf(nodes, nodeLimit).mstEdges).toHaveLength(count - 1);
	});

	it.each([0, -1, 1.5, Number.NaN])(
		"refuses the invalid budget %s",
		(limit) => {
			const nodes = createSyntheticMap({ count: 3 });
			expect(() => layoutOf(nodes, limit)).toThrow(LayoutBudgetError);
		},
	);

	it("returns no pairs for no node or one node", () => {
		expect(layoutOf([])).toMatchObject({ centerId: null, mstEdges: [] });
		const one = createSyntheticMap({ count: 1 });
		expect(layoutOf(one)).toMatchObject({
			centerId: one[0].id,
			mstEdges: [],
			neighbours: { fpLinks: [], nnLinks: [] },
		});
	});

	it("rejects vectors of different lengths", () => {
		expect(() =>
			packVectors([
				{ embedding: [1, 0], id: "a" },
				{ embedding: [1, 0, 0], id: "b" },
			]),
		).toThrow(/dimensions/);
	});

	it("pauses between rows and accounts the pause out of its timings", () => {
		const nodes = createSyntheticMap({ count: 30 });
		const steps = layoutSteps({ ...packVectors(nodes), nodeLimit: 30 });
		let pauses = 0;
		let step = steps.next();
		while (!step.done) {
			pauses++;
			step = steps.next(1_000);
		}
		expect(pauses).toBeGreaterThan(30);
		expect(step.value.timings.totalMs).toBeLessThan(1_000);
		expect(step.value.mstEdges).toEqual(buildMST(nodes));
	});
});
