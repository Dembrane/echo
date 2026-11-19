// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import type { MapGraphNode } from "../types";
import { useShowcaseWalk } from "./useShowcaseWalk";

// The Showcase panel follows the renderers' walk. The callback it hands them
// stays the same, so a renderer does not restart its timer on every render.
it("keeps the callback it hands the renderers", () => {
	const { result, rerender } = renderHook(useShowcaseWalk);
	const first = result.current.onActiveNodeChange;
	act(() =>
		result.current.onActiveNodeChange(
			{ id: "n1" } as MapGraphNode,
			1_000,
			4_000,
		),
	);
	rerender();
	expect(result.current.onActiveNodeChange).toBe(first);
});

it("shows the node the walk stands on and its countdown", () => {
	const { result } = renderHook(useShowcaseWalk);
	expect(result.current.nodeId).toBeNull();
	act(() =>
		result.current.onActiveNodeChange(
			{ id: "n1" } as MapGraphNode,
			1_000,
			4_000,
		),
	);
	expect(result.current).toMatchObject({
		durationMs: 4_000,
		expiresAt: 1_000,
		nodeId: "n1",
	});
	act(() => result.current.onActiveNodeChange(null, null, 4_000));
	expect(result.current.nodeId).toBeNull();
});
