import { describe, expect, it } from "vitest";
import { createSyntheticMap } from "../fixtures/syntheticMap";
import type { Edge } from "../types";
import {
	buildMST,
	buildRootedTree,
	centralityOrder,
	cosineDistance,
	descendantsOf,
	downstreamOf,
	eccentricities,
	findGraphCenter,
	mstHopDistances,
} from "./mst";

const idNodes = (ids: string[]) => ids.map((id) => ({ id }));
const edge = (source: string, target: string): Edge => ({
	distance: 0,
	source,
	target,
});

// a - b - c - d - e
const pathIds = ["a", "b", "c", "d", "e"];
const pathEdges = [
	edge("a", "b"),
	edge("b", "c"),
	edge("c", "d"),
	edge("d", "e"),
];

/** True when the edges join all nodes into one tree without a cycle. */
function isSpanningTree(ids: string[], edges: Edge[]): boolean {
	const parent = new Map(ids.map((id) => [id, id]));
	const find = (x: string): string => {
		let root = x;
		while (parent.get(root) !== root) root = parent.get(root) as string;
		return root;
	};
	for (const { source, target } of edges) {
		const a = find(source);
		const b = find(target);
		if (a === b) return false; // cycle
		parent.set(a, b);
	}
	return new Set(ids.map(find)).size <= 1;
}

describe("cosineDistance", () => {
	it("is 0 for parallel and 1 for orthogonal vectors", () => {
		expect(cosineDistance([1, 2], [2, 4])).toBeCloseTo(0);
		expect(cosineDistance([1, 0], [0, 3])).toBeCloseTo(1);
	});
});

describe("buildMST", () => {
	it.each([0, 1, 2, 200])(
		"spans %i synthetic nodes with n-1 edges, acyclic and connected",
		(count) => {
			const nodes = createSyntheticMap({ count });
			const edges = buildMST(nodes);
			const ids = nodes.map((node) => node.id);

			expect(edges).toHaveLength(Math.max(0, count - 1));
			expect(isSpanningTree(ids, edges)).toBe(true);
		},
	);

	it("picks the shortest edges and keeps pair order on ties", () => {
		const nodes = [
			{ embedding: [1, 0], id: "x" },
			{ embedding: [1, 0], id: "y" },
			{ embedding: [0, 1], id: "z" },
		];
		const edges = buildMST(nodes);
		expect(edges.map((e) => `${e.source}-${e.target}`)).toEqual(["x-y", "x-z"]);
	});
});

describe("findGraphCenter", () => {
	it("returns the middle of a path", () => {
		expect(findGraphCenter(idNodes(pathIds), pathEdges)).toBe("c");
	});

	it("returns the hub of a star", () => {
		const ids = ["leaf1", "leaf2", "hub", "leaf3", "leaf4"];
		const edges = ["leaf1", "leaf2", "leaf3", "leaf4"].map((leaf) =>
			edge("hub", leaf),
		);
		expect(findGraphCenter(idNodes(ids), edges)).toBe("hub");
	});

	it("lets the first node win a tie", () => {
		// a - b: both have eccentricity 1
		expect(findGraphCenter(idNodes(["a", "b"]), [edge("a", "b")])).toBe("a");
	});

	it("handles empty and single-node graphs", () => {
		expect(findGraphCenter([], [])).toBeNull();
		expect(findGraphCenter(idNodes(["solo"]), [])).toBe("solo");
	});
});

describe("eccentricities", () => {
	it("measures the largest hop distance on a path", () => {
		expect(
			Object.fromEntries(eccentricities(idNodes(pathIds), pathEdges)),
		).toEqual({ a: 4, b: 3, c: 2, d: 3, e: 4 });
	});
});

describe("mstHopDistances", () => {
	it("counts hops between every pair", () => {
		const hops = mstHopDistances(idNodes(pathIds), pathEdges);
		expect(hops.get("a")?.get("e")).toBe(4);
		expect(hops.get("c")?.get("a")).toBe(2);
		expect(hops.get("d")?.get("d")).toBe(0);
	});
});

describe("downstreamOf", () => {
	// n0 - n1 - ... - n10, centre n5
	const longIds = Array.from({ length: 11 }, (_, i) => `n${i}`);
	const longEdges = longIds.slice(1).map((id, i) => edge(longIds[i], id));

	it("returns the hovered node and its subtree away from the centre", () => {
		const { ids, distances } = downstreamOf("n7", idNodes(longIds), longEdges);
		expect([...ids]).toEqual(["n7", "n8", "n9", "n10"]);
		expect(Object.fromEntries(distances)).toEqual({
			n7: 0,
			n8: 0.25,
			n9: 0.5,
			n10: 0.75,
		});
	});

	it("normalises depth by 4 and caps at 1", () => {
		const { ids, distances } = downstreamOf("n5", idNodes(longIds), longEdges);
		expect(ids.size).toBe(11);
		expect(distances.get("n5")).toBe(0);
		expect(distances.get("n2")).toBe(0.75);
		expect(distances.get("n1")).toBe(1);
		expect(distances.get("n0")).toBe(1);
	});

	it("is empty without nodes", () => {
		const { ids, distances } = downstreamOf("x", [], []);
		expect(ids.size).toBe(0);
		expect(distances.size).toBe(0);
	});
});

describe("buildRootedTree and descendantsOf", () => {
	const nodes = createSyntheticMap({ count: 50 });
	const edges = buildMST(nodes);
	const tree = buildRootedTree(nodes, edges);

	it("roots the tree at the graph centre and gives every other node one parent", () => {
		expect(tree.rootId).toBe(findGraphCenter(nodes, edges));
		expect(tree.parent.get(tree.rootId as string)).toBeNull();
		const childCount = [...tree.children.values()].reduce(
			(sum, children) => sum + children.length,
			0,
		);
		expect(childCount).toBe(49);
	});

	it("reaches the whole tree from the root and only itself from a leaf", () => {
		expect(descendantsOf(tree.rootId as string, tree).ids.size).toBe(50);
		const leaf = nodes.find(
			(node) => (tree.children.get(node.id) ?? []).length === 0,
		);
		const { ids, distances } = descendantsOf(leaf?.id as string, tree);
		expect([...ids]).toEqual([leaf?.id]);
		expect(distances.get(leaf?.id as string)).toBe(0);
	});

	it("is empty for an empty tree", () => {
		expect(descendantsOf("x", buildRootedTree([], [])).ids.size).toBe(0);
	});
});

describe("centralityOrder", () => {
	it("orders by eccentricity, then degree, then input order", () => {
		// c is the centre; b and d tie on eccentricity and degree; a and e are leaves
		expect(
			centralityOrder(["e", "d", "a", "c", "b"], idNodes(pathIds), pathEdges),
		).toEqual(["c", "d", "b", "e", "a"]);
	});

	it("breaks eccentricity ties by degree", () => {
		// hub - x, hub - y, x - z: hub and x both have eccentricity 2
		const ids = ["x", "hub", "y", "z"];
		const edges = [edge("hub", "x"), edge("hub", "y"), edge("x", "z")];
		expect(centralityOrder(ids, idNodes(ids), edges)).toEqual([
			"x",
			"hub",
			"y",
			"z",
		]);
	});

	it("puts unknown ids last", () => {
		expect(
			centralityOrder(["ghost", "a", "c"], idNodes(pathIds), pathEdges),
		).toEqual(["c", "a", "ghost"]);
	});
});
