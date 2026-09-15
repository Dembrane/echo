import { describe, expect, it } from "vitest";
import { createSyntheticMap } from "../fixtures/syntheticMap";
import { newestNodeIds, nodeGeometryKey } from "./nodeSet";

describe("nodeGeometryKey", () => {
	const nodes = createSyntheticMap({ count: 5, dims: 16 });

	it("is equal for copies with different metadata", () => {
		const copy = nodes.map((node) => ({
			...node,
			embedding: [...node.embedding],
			label: "Relabelled",
		}));
		expect(nodeGeometryKey(copy)).toBe(nodeGeometryKey(nodes));
	});

	it("changes when a component past the first few changes", () => {
		const changed = nodes.map((node, index) =>
			index === 4
				? {
						...node,
						embedding: node.embedding.map((value, dim) =>
							dim === 15 ? value + 1e-6 : value,
						),
					}
				: node,
		);
		expect(nodeGeometryKey(changed)).not.toBe(nodeGeometryKey(nodes));
	});

	it("changes with the node order and ids", () => {
		expect(nodeGeometryKey([...nodes].reverse())).not.toBe(
			nodeGeometryKey(nodes),
		);
		expect(nodeGeometryKey(nodes.slice(1))).not.toBe(nodeGeometryKey(nodes));
	});
});

describe("newestNodeIds", () => {
	it("returns the newest ids first and skips undated nodes", () => {
		const nodes = createSyntheticMap({ count: 14 });
		nodes[13].metadata.createdAt = null;
		expect(newestNodeIds(nodes)).toEqual(
			[12, 11, 10, 9, 8, 7, 6, 5, 4, 3].map((i) => `synthetic-${i}`),
		);
		expect(newestNodeIds(nodes, 2)).toEqual(["synthetic-12", "synthetic-11"]);
	});
});
