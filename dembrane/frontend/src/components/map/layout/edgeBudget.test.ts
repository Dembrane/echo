import { describe, expect, it } from "vitest";
import { LEGACY_BUDGET_BOUNDS, minEdgeLimit } from "../budgets";
import type { LocalMapLink } from "../graph/localMap";
import type { Edge, MapRelation } from "../types";
import { createRelationFixture, RELATIONS_PER_NODE } from "./benchmark";
import {
	orderNeighbourPairs,
	relationLines,
	selectLocalMapEdges,
	selectMstEdges,
} from "./edgeBudget";

const idsOf = (count: number) =>
	Array.from({ length: count }, (_, index) => `node-${index}`);

/** A path through the ids: a spanning tree of n - 1 edges. */
const pathTree = (ids: string[]): Edge[] =>
	ids.slice(1).map((id, index) => ({
		distance: 0.1,
		source: ids[index],
		target: id,
	}));

/** Ten nearest neighbours per node, listed from both ends as the k-NN is. */
const neighbourLinksOf = (ids: string[], k = 10): LocalMapLink[] =>
	ids.flatMap((source, index) =>
		Array.from({ length: Math.min(k, ids.length - 1) }, (_, rank) => ({
			source,
			strength: 1,
			target: ids[(index + rank + 1) % ids.length],
		})),
	);

const relation = (
	id: string,
	source: string,
	target: string,
	type = "supports_pole_a",
): MapRelation => ({ basis: "extracted", id, source, target, type });

const DEFAULTS = LEGACY_BUDGET_BOUNDS.defaults;
const BUDGETS = [
	{ ...DEFAULTS, label: "default" },
	{
		edgeLimit: DEFAULTS.edgeLimit * 3,
		label: "raised",
		nodeLimit: DEFAULTS.nodeLimit * 2,
	},
	{
		edgeLimit: minEdgeLimit(DEFAULTS.nodeLimit),
		label: "tree only",
		nodeLimit: DEFAULTS.nodeLimit,
	},
];

describe("MST edge budget over dense relationships", () => {
	for (const { label, nodeLimit, edgeLimit } of BUDGETS) {
		it.each([nodeLimit - 1, nodeLimit])(
			`${label} budget (${nodeLimit} nodes, ${edgeLimit} edges): %i nodes keep every tree edge and stay within the edge budget`,
			(count) => {
				const ids = idsOf(count);
				const relations = createRelationFixture(ids, RELATIONS_PER_NODE.dense);
				const {
					tree,
					relations: drawn,
					counts,
				} = selectMstEdges({
					edgeLimit,
					nodeIds: new Set(ids),
					relations,
					selectedId: ids[3],
					showRelationships: true,
					treeEdges: pathTree(ids),
				});

				expect(tree).toHaveLength(count - 1);
				expect(counts.tree).toBe(count - 1);
				expect(counts.drawn).toBe(tree.length + drawn.length);
				expect(counts.drawn).toBeLessThanOrEqual(edgeLimit);
				expect(drawn.length).toBe(Math.max(0, edgeLimit - (count - 1)));
				// Dense relations never fit: the counts say so
				expect(counts.available).toBeGreaterThan(counts.drawn);
			},
		);

		it(`${label} budget: ${nodeLimit + 1} nodes are refused by the layout, never pruned here`, () => {
			const ids = idsOf(nodeLimit + 1);
			const { tree } = selectMstEdges({
				edgeLimit,
				nodeIds: new Set(ids),
				relations: [],
				selectedId: null,
				showRelationships: false,
				treeEdges: pathTree(ids),
			});
			// Even past the budget the tree is whole; the layout refuses first
			expect(tree).toHaveLength(nodeLimit);
		});
	}

	it("draws the selected node's relations without the relationships toggle, first", () => {
		const ids = idsOf(20);
		const relations = [
			relation("r1", ids[1], ids[2]),
			relation("r2", ids[5], ids[9]),
			relation("r3", ids[9], ids[0]),
			relation("r4", ids[7], ids[5]),
		];
		const selectedAll = selectMstEdges({
			edgeLimit: 19 + 2,
			nodeIds: new Set(ids),
			relations,
			selectedId: ids[5],
			showRelationships: true,
			treeEdges: pathTree(ids),
		});
		// Both touch the selection; then by pair key (node-5~node-7 before node-5~node-9)
		expect(selectedAll.relations.map((line) => line.relationIds)).toEqual([
			["r4"],
			["r2"],
		]);
		expect(selectedAll.counts).toMatchObject({ available: 19 + 4, drawn: 21 });

		const selectedOnly = selectMstEdges({
			edgeLimit: 450,
			nodeIds: new Set(ids),
			relations,
			selectedId: ids[9],
			showRelationships: false,
			treeEdges: pathTree(ids),
		});
		expect(selectedOnly.relations.map((line) => line.relationIds)).toEqual([
			["r3"],
			["r2"],
		]);
	});

	it("draws one line per pair and leaves out relations to hidden nodes", () => {
		const ids = idsOf(4);
		const lines = relationLines(
			[
				relation("r1", ids[0], ids[1], "supports_pole_a"),
				relation("r2", ids[1], ids[0], "holds_position"),
				relation("r3", ids[0], "hidden-node"),
				relation("r4", ids[2], ids[2]),
			],
			new Set(ids),
			null,
		);
		expect(lines).toEqual([
			expect.objectContaining({
				relationIds: ["r1", "r2"],
				types: ["holds_position", "supports_pole_a"],
			}),
		]);
	});

	it("orders relations the same whatever order they arrive in", () => {
		const ids = idsOf(30);
		const relations = createRelationFixture(ids, 3);
		const forward = relationLines(relations, new Set(ids), ids[2]);
		const backward = relationLines(
			[...relations].reverse(),
			new Set(ids),
			ids[2],
		);
		expect(backward).toEqual(forward);
	});
});

describe("LocalMap edge budget", () => {
	for (const { label, nodeLimit, edgeLimit } of BUDGETS) {
		it.each([nodeLimit - 1, nodeLimit, nodeLimit + 1])(
			`${label} budget (${edgeLimit} edges): %i nodes with neighbour links and dense relations stay within the budget`,
			(count) => {
				const ids = idsOf(count);
				const { neighbours, relations, counts } = selectLocalMapEdges({
					edgeLimit,
					neighbourLinks: neighbourLinksOf(ids),
					nodeIds: new Set(ids),
					relations: createRelationFixture(ids, RELATIONS_PER_NODE.dense),
					selectedId: ids[0],
					showNeighbourLinks: true,
					showRelationships: true,
				});
				expect(counts.drawn).toBe(neighbours.length + relations.length);
				expect(counts.drawn).toBeLessThanOrEqual(edgeLimit);
				expect(counts.available).toBeGreaterThan(counts.drawn);
				expect(counts.tree).toBe(0);
			},
		);
	}

	it("hides neighbour links by default and draws nothing without relations", () => {
		const ids = idsOf(20);
		const { neighbours, counts } = selectLocalMapEdges({
			edgeLimit: 450,
			neighbourLinks: neighbourLinksOf(ids),
			nodeIds: new Set(ids),
			relations: [],
			selectedId: ids[0],
			showNeighbourLinks: false,
			showRelationships: false,
		});
		expect(neighbours).toEqual([]);
		expect(counts).toEqual({
			available: 0,
			drawn: 0,
			neighbours: 0,
			relations: 0,
			tree: 0,
		});
	});

	it("counts a neighbour pair listed from both ends once", () => {
		const links: LocalMapLink[] = [
			{ source: "a", strength: 1, target: "b" },
			{ source: "b", strength: 1, target: "a" },
			{ source: "b", strength: 1, target: "c" },
		];
		expect(orderNeighbourPairs(links, null)).toEqual([links[0], links[2]]);
	});

	it("spreads a small budget: every node's nearest neighbour before any second nearest", () => {
		const ids = idsOf(6);
		const pairs = orderNeighbourPairs(neighbourLinksOf(ids, 3), null);
		const firstSix = pairs.slice(0, 6);
		expect(new Set(firstSix.map((link) => link.source))).toEqual(new Set(ids));
	});

	it("gives relations the budget before neighbour links", () => {
		const ids = idsOf(10);
		const selection = selectLocalMapEdges({
			edgeLimit: 3,
			neighbourLinks: neighbourLinksOf(ids),
			nodeIds: new Set(ids),
			relations: [
				relation("r1", ids[1], ids[2]),
				relation("r2", ids[3], ids[4]),
			],
			selectedId: null,
			showNeighbourLinks: true,
			showRelationships: true,
		});
		expect(selection.relations).toHaveLength(2);
		expect(selection.neighbours).toHaveLength(1);
	});

	it("is deterministic", () => {
		const ids = idsOf(40);
		const input = {
			edgeLimit: 60,
			neighbourLinks: neighbourLinksOf(ids),
			nodeIds: new Set(ids),
			relations: createRelationFixture(ids, 2),
			selectedId: ids[7],
			showNeighbourLinks: true,
			showRelationships: true,
		};
		expect(selectLocalMapEdges(input)).toEqual(selectLocalMapEdges(input));
	});
});
