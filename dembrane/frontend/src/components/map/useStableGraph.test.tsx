// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { FIXTURE_BUDGETS } from "./data/fixture";
import { createSyntheticPayload } from "./fixtures/syntheticMap";
import type { MapGraphResponse } from "./hooks";
import { useStableGraph } from "./MapPage";

// A refetch of the same graph keeps the graph the page built, so nodes keep
// their identity; another graph is built anew.
const payload = (argument: number) =>
	createSyntheticPayload({ budgets: FIXTURE_BUDGETS, counts: { argument } })
		.payload;

it("keeps the built graph through a refetch of the same graph", () => {
	const { result, rerender } = renderHook(
		({ response }) => useStableGraph(response),
		{ initialProps: { response: payload(3) } },
	);
	const first = result.current;
	expect(first).not.toBeNull();
	rerender({ response: structuredClone(payload(3)) });
	expect(result.current).toBe(first);
});

it("builds another graph anew, and nothing without a response", () => {
	const { result, rerender } = renderHook(
		({ response }) => useStableGraph(response),
		{
			initialProps: {
				response: payload(3) as MapGraphResponse | null,
			},
		},
	);
	const first = result.current;
	rerender({ response: payload(5) });
	expect(result.current).not.toBe(first);
	expect(result.current?.placedNodes).toHaveLength(5);
	rerender({ response: null });
	expect(result.current).toBeNull();
});
