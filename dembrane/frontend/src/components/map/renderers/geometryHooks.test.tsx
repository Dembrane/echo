// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Edge, MapGraphNode } from "../types";
import { useGeometry, useRendererGeometry } from "./hooks";

// The node set a renderer keys its geometry on, and the geometry it draws:
// kept through updates that do not move anything.
const node = (id: string, embedding = [1, 0]) =>
	({ embedding, id, label: id, metadata: {} }) as unknown as MapGraphNode;

describe("useGeometry", () => {
	it("keeps the node array while ids and vectors are unchanged", () => {
		const first = [node("a"), node("b")];
		const { result, rerender } = renderHook(({ nodes }) => useGeometry(nodes), {
			initialProps: { nodes: first },
		});
		rerender({ nodes: [node("a"), node("b")] });
		expect(result.current.nodes).toBe(first);

		const moved = [node("a"), node("b", [0, 1])];
		rerender({ nodes: moved });
		expect(result.current.nodes).toBe(moved);
		expect(result.current.key).not.toBe("");
	});
});

describe("useRendererGeometry", () => {
	const build = () => ({ mstEdges: [], neighbours: null });
	const edge = (source: string, target: string) =>
		({ source, target }) as unknown as Edge;

	it("draws nothing until edges span the nodes, then keeps the last that did", () => {
		const ab = [node("a"), node("b")];
		const { result, rerender } = renderHook(
			({ nodes, edges }) =>
				useRendererGeometry(nodes, { mstEdges: edges }, build),
			{ initialProps: { edges: [edge("a", "c")], nodes: ab } },
		);
		expect(result.current.nodes).toEqual([]);

		rerender({ edges: [edge("a", "b")], nodes: ab });
		expect(result.current.mstEdges).toEqual([edge("a", "b")]);
		expect(result.current.nodes).toBe(ab);

		// A filter adds a node before its tree arrives: the last tree stays.
		const abc = [node("a"), node("b"), node("c")];
		rerender({ edges: [edge("a", "b")], nodes: abc });
		expect(result.current.mstEdges).toEqual([edge("a", "b")]);
		expect(result.current.nodes).toBe(ab);
	});
});
