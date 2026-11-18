// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { buildMapGraph } from "../data/adapter";
import type { FactCheckState } from "../types";
import type { FactCheckStates, MapArgument, MapResult } from "./index";
import { useVerdictKeyedNodes } from "./useVerdictKeyedNodes";

const argument = (
	id: string,
	overrides: Partial<MapArgument> = {},
): MapArgument => ({
	claim_key: null,
	created_at: "2026-09-01T10:00:00Z",
	embedding: [1, 0, 0],
	evidence: [
		{
			conversation_id: "c1",
			created_at: null,
			label: "Conversation one",
			quotes: [`${id} quote`],
		},
	],
	id,
	kind: "argument",
	statement: `Statement ${id}`,
	valence: "neutral",
	...overrides,
});

const result = (args: MapArgument[]): MapResult => ({
	arguments: args,
	completed_at: null,
	conversations: [],
	created_at: null,
	embedding: { dims: 3, key: "k", model: "m" },
	id: "result-1",
	missing_embeddings: [],
	recipe_version: "v1",
	source_fingerprint: "f",
	stats: {},
	status: "ready",
});

const graph = buildMapGraph(
	result([
		argument("arg"),
		argument("claim", { claim_key: "k1", kind: "claim" }),
	]),
);

const done = (justification: string): FactCheckState => ({
	checkedAt: justification,
	justification,
	sources: [],
	status: "done",
	verdict: "false",
});

const render = (states: FactCheckStates) =>
	renderHook(({ states }) => useVerdictKeyedNodes(graph.placedNodes, states), {
		initialProps: { states },
	});

describe("useVerdictKeyedNodes", () => {
	it("puts the claim's fact-check state on its node", () => {
		const { result } = render({ claim: done("one") });
		expect(result.current[1].metadata.factCheck).toMatchObject({
			status: "done",
			verdict: "false",
		});
	});

	it("keeps the same nodes while a check is in progress", () => {
		const { rerender, result } = render({
			claim: { startedAt: "a", status: "processing" },
		});
		const first = result.current;
		rerender({ states: { claim: { startedAt: "b", status: "processing" } } });
		expect(result.current).toBe(first);
	});

	it("keeps the same nodes when only the justification changes", () => {
		const { rerender, result } = render({ claim: done("one") });
		const first = result.current;
		rerender({ states: { claim: done("two") } });
		expect(result.current).toBe(first);
	});

	it("rebuilds the nodes when a displayed verdict changes", () => {
		const { rerender, result } = render({
			claim: { startedAt: "a", status: "processing" },
		});
		const first = result.current;
		rerender({ states: { claim: done("one") } });
		expect(result.current).not.toBe(first);
		expect(result.current[1].metadata.factCheck).toMatchObject({
			status: "done",
		});
	});
});
