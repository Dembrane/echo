import { describe, expect, it } from "vitest";
import type { MapArgument, MapResult } from "../hooks";
import { buildMapGraph, factCheckSignature, withFactChecks } from "./adapter";

const vector = (...values: number[]) => values;

const argument = (
	id: string,
	overrides: Partial<MapArgument> = {},
): MapArgument => ({
	claim_key: null,
	created_at: "2026-09-01T10:00:00Z",
	embedding: vector(1, 0, 0),
	evidence: [
		{
			conversation_id: "c1",
			created_at: null,
			label: "Conversation one",
			quotes: [`${id} quote a`],
		},
	],
	id,
	kind: "argument",
	statement: `Statement ${id}`,
	valence: "neutral",
	...overrides,
});

const result = (args: MapArgument[], missing: string[] = []): MapResult => ({
	arguments: args,
	completed_at: null,
	conversations: [],
	created_at: null,
	embedding: { dims: 3, key: "k", model: "m" },
	id: "result-1",
	missing_embeddings: missing,
	recipe_version: "v1",
	source_fingerprint: "f",
	stats: {},
	status: "ready",
});

describe("buildMapGraph", () => {
	it("shapes arguments into nodes with their full statement and every quote", () => {
		const graph = buildMapGraph(
			result([
				argument("a", {
					evidence: [
						{
							conversation_id: "c1",
							created_at: null,
							label: "One",
							quotes: ["q1", "q2"],
						},
						{
							conversation_id: "c2",
							created_at: null,
							label: "Two",
							quotes: ["q3"],
						},
						{
							conversation_id: "c1",
							created_at: null,
							label: "One",
							quotes: ["q4"],
						},
					],
				}),
			]),
		);

		const [node] = graph.placedNodes;
		expect(node.label).toBe("Statement a");
		expect(node.metadata.quotes).toEqual(["q1", "q2", "q3", "q4"]);
		expect(node.metadata.conversationIds).toEqual(["c1", "c2"]);
		expect(node.metadata.createdAt).toBe("2026-09-01T10:00:00Z");
		expect(graph.evidenceById.get("a")).toEqual([
			{
				conversationId: "c1",
				label: "One",
				quotes: ["q1", "q2", "q4"],
				slot: 0,
			},
			{ conversationId: "c2", label: "Two", quotes: ["q3"], slot: 1 },
		]);
		// The host map names its own conversations, so the legend can too.
		expect(graph.conversationNames.get(0)).toBe("One");
		expect(graph.conversationNames.get(1)).toBe("Two");
	});

	it("surfaces every argument it cannot place instead of dropping it", () => {
		const graph = buildMapGraph(
			result(
				[
					argument("ok"),
					argument("missing", { embedding: null }),
					argument("zero", { embedding: vector(0, 0, 0) }),
					argument("nan", { embedding: vector(1, Number.NaN, 0) }),
					argument("short", { embedding: vector(1, 0) }),
					argument("server-missing", { embedding: vector(0, 1, 0) }),
				],
				["server-missing"],
			),
		);

		expect(graph.placedNodes.map((node) => node.id)).toEqual(["ok"]);
		expect(graph.unplaced).toEqual(
			expect.arrayContaining([
				{ id: "missing", reason: "missing" },
				{ id: "zero", reason: "zero" },
				{ id: "nan", reason: "non-finite" },
				{ id: "short", reason: "dimension" },
				{ id: "server-missing", reason: "missing" },
			]),
		);
		expect(graph.unplaced).toHaveLength(5);
		expect(graph.allNodes).toHaveLength(6);
	});

	it("does not report an argument twice", () => {
		const graph = buildMapGraph(
			result([argument("gone", { embedding: null })], ["gone"]),
		);
		expect(graph.unplaced).toEqual([{ id: "gone", reason: "missing" }]);
	});
});

describe("fact-check merge", () => {
	const graph = buildMapGraph(
		result([
			argument("arg"),
			argument("claim", { claim_key: "k1", kind: "claim" }),
		]),
	);

	it("gives claims their state (idle by default) and leaves arguments untouched", () => {
		const idle = withFactChecks(graph.placedNodes, {});
		expect(idle[0]).toBe(graph.placedNodes[0]);
		expect(idle[1].metadata.factCheck).toEqual({ status: "idle" });
		expect(idle[1].embedding).toBe(graph.placedNodes[1].embedding);

		const done = withFactChecks(graph.placedNodes, {
			claim: {
				checkedAt: "x",
				justification: "Sources agree.",
				sources: [],
				status: "done",
				verdict: "true",
			},
		});
		expect(done[1].metadata.factCheck).toMatchObject({ verdict: "true" });
		// The source nodes never carry fact-check state.
		expect(graph.placedNodes[1].metadata.factCheck).toBeUndefined();
	});

	it("changes the signature only when a displayed verdict changes", () => {
		const processing = factCheckSignature(graph.placedNodes, {
			claim: { startedAt: "a", status: "processing" },
		});
		const processingLater = factCheckSignature(graph.placedNodes, {
			claim: { startedAt: "b", status: "processing" },
		});
		const done = factCheckSignature(graph.placedNodes, {
			claim: {
				checkedAt: "c",
				justification: "one",
				sources: [],
				status: "done",
				verdict: "false",
			},
		});
		const doneReworded = factCheckSignature(graph.placedNodes, {
			claim: {
				checkedAt: "d",
				justification: "two",
				sources: [],
				status: "done",
				verdict: "false",
			},
		});

		expect(processing).toBe(processingLater);
		expect(done).toBe(doneReworded);
		expect(done).not.toBe(processing);
	});
});
