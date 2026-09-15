import { i18n } from "@lingui/core";
import { beforeAll, describe, expect, it } from "vitest";
import { createSyntheticPayload } from "../fixtures/syntheticMap";
import type { MapPayloadNode, MapPayloadV2, MapResult } from "../hooks";
import { buildMapGraph, factCheckFor, withFactChecks } from "./adapter";
import { FIXTURE_BUDGETS, fixtureMapResult } from "./fixture";

beforeAll(() => {
	i18n.load("en-US", {});
	i18n.activate("en-US");
});

const node = (overrides: Partial<MapPayloadNode>): MapPayloadNode => ({
	attributes: {},
	detail: {},
	embedding: [1, 0, 0],
	label: "Label",
	objectId: "obj-1",
	provenance: { origin: "generated", recipeId: "arguments", runId: "run-1" },
	revisionId: "rev-1",
	type: "argument",
	...overrides,
});

const payload = (overrides: Partial<MapPayloadV2>): MapPayloadV2 => ({
	budgets: FIXTURE_BUDGETS,
	counts: {
		argument: 0,
		deduplicated_argument: 0,
		popcorn: 0,
		stakeholder: 0,
		tension: 0,
	},
	embedding: { dims: 3, key: "k", model: "m" },
	nodes: [],
	overBudget: false,
	relations: [],
	scope: { types: ["argument", "tension"] },
	snapshot: { createdAt: "", id: "snap-1", parentId: null, stale: [] },
	unplaced: [],
	version: 2,
	...overrides,
});

describe("buildMapGraph with payload v2", () => {
	it("makes typed nodes whose id is the revision id", () => {
		const graph = buildMapGraph(
			payload({
				nodes: [
					node({
						attributes: { epistemicKind: "claim", valence: "negative" },
						factCheck: { claimKey: "ck", eligible: true },
						objectId: "obj-a",
						revisionId: "rev-a",
					}),
					node({
						detail: {
							knot: "The knot",
							poleA: "Open",
							poleB: "Quiet",
							toResolve: "Which floor",
						},
						label: "Open or quiet",
						objectId: "obj-t",
						revisionId: "rev-t",
						type: "tension",
					}),
				],
			}),
		);

		const [argument, tension] = graph.placedNodes;
		expect(argument.id).toBe("rev-a");
		expect(argument.metadata).toMatchObject({
			epistemicKind: "claim",
			factCheckEligible: true,
			// Deprecated alias for the renderers.
			kind: "claim",
			objectId: "obj-a",
			objectType: "argument",
			revisionId: "rev-a",
			sizeScale: 1,
			valence: "negative",
		});
		expect(tension.metadata).toMatchObject({
			kind: "argument",
			objectType: "tension",
			sizeScale: 1.5,
		});
		// A missing valence stays missing: "Not assessed", not neutral.
		expect(tension.metadata.valence).toBeUndefined();
		expect(graph.objectsById.get("rev-t")?.detail).toEqual({
			knot: "The knot",
			poleA: "Open",
			poleB: "Quiet",
			toResolve: "Which floor",
			type: "tension",
		});
		expect(graph.resultId).toBe("snap-1");
		expect(graph.snapshotId).toBe("snap-1");
		expect(graph.version).toBe(2);
	});

	it("adapts relations to node ids and keeps their basis", () => {
		const graph = buildMapGraph(
			payload({
				nodes: [
					node({ revisionId: "a" }),
					node({ revisionId: "t", type: "tension" }),
				],
				relations: [
					{
						basis: "extracted",
						from: "a",
						id: "r1",
						to: "t",
						type: "supports_pole_a",
					},
				],
			}),
		);
		expect(graph.relations).toEqual([
			{
				basis: "extracted",
				id: "r1",
				source: "a",
				target: "t",
				type: "supports_pole_a",
			},
		]);
	});

	it("lists objects without vectors as unplaced instead of dropping them", () => {
		const graph = buildMapGraph(
			payload({
				nodes: [
					node({ revisionId: "placed" }),
					node({ embedding: null, revisionId: "null-vector" }),
					node({ embedding: [0, 1, 0], revisionId: "server-listed" }),
				],
				unplaced: ["null-vector", "server-listed"],
			}),
		);
		expect(graph.placedNodes.map((item) => item.id)).toEqual(["placed"]);
		expect(graph.unplaced).toEqual([
			{ id: "null-vector", reason: "missing" },
			{ id: "server-listed", reason: "missing" },
		]);
		expect(graph.allNodes).toHaveLength(3);
	});

	it("keeps counts, budgets and scope when the server omits an over-budget scope", () => {
		const graph = buildMapGraph(
			payload({
				counts: {
					argument: 400,
					deduplicated_argument: 0,
					popcorn: 0,
					stakeholder: 0,
					tension: 6,
				},
				overBudget: true,
				scope: { resultScope: "dedup-1", types: ["argument"] },
			}),
		);
		expect(graph.overBudget).toBe(true);
		expect(graph.allNodes).toEqual([]);
		expect(graph.counts).toMatchObject({ argument: 400, tension: 6 });
		expect(graph.budgetBounds).toEqual({
			ceilings: FIXTURE_BUDGETS.ceilings,
			defaults: FIXTURE_BUDGETS.defaults,
		});
		expect(graph.scope).toEqual({
			resultScope: "dedup-1",
			types: ["argument"],
		});
	});

	it("reads fact-check eligibility from the capability, not the type name", () => {
		const graph = buildMapGraph(
			payload({
				nodes: [
					node({
						attributes: { epistemicKind: "claim" },
						factCheck: { eligible: false },
						revisionId: "claim-not-eligible",
					}),
				],
			}),
		);
		const [claim] = graph.placedNodes;
		expect(factCheckFor(claim, {})).toBeUndefined();
		expect(withFactChecks(graph.placedNodes, {})[0]).toBe(claim);
	});

	it("parses every type of the mixed fixture with its relations", () => {
		const { payload: mixed } = createSyntheticPayload({
			budgets: FIXTURE_BUDGETS,
			counts: { argument: 6, popcorn: 1, stakeholder: 1, tension: 1 },
		});
		const graph = buildMapGraph(mixed);
		expect(graph.counts).toMatchObject({
			argument: 6,
			popcorn: 1,
			stakeholder: 1,
			tension: 1,
		});
		expect(graph.objectsById.get("rev-stakeholder-0")?.detail).toMatchObject({
			role: "Synthetic role 0",
			rung: "voiced",
			type: "stakeholder",
		});
		expect(graph.evidenceById.get("rev-popcorn-0")?.[0].quotes[0]).toContain(
			"Synthetic phrase 0",
		);
		expect(
			graph.relations.filter((relation) => relation.target === "rev-tension-0"),
		).toHaveLength(4);
	});
});

describe("buildMapGraph with a legacy v1 result", () => {
	it("serves arguments as argument objects with legacy provenance", () => {
		const { result } = fixtureMapResult(50);
		const withClaim: MapResult = {
			...result,
			arguments: result.arguments.map((argument, index) =>
				index === 0
					? { ...argument, claim_key: "k0", kind: "claim" }
					: argument,
			),
		};
		const graph = buildMapGraph(withClaim);
		const first = graph.allNodes[0];
		expect(graph.version).toBe(1);
		expect(graph.resultId).toBe(result.id);
		expect(first.id).toBe(result.arguments[0].id);
		expect(first.metadata).toMatchObject({
			epistemicKind: "claim",
			factCheckEligible: true,
			kind: "claim",
			objectType: "argument",
			revisionId: result.arguments[0].id,
		});
		expect(graph.objectsById.get(first.id)).toMatchObject({
			factCheck: { claimKey: "k0", eligible: true },
			provenance: { legacy: true, runId: result.id },
			type: "argument",
		});
		expect(graph.counts.argument).toBe(50);
		expect(graph.budgetBounds).toBeNull();
		expect(graph.conversationCount).toBe(result.conversations.length);
	});
});
