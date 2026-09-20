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

	it("keeps verified consolidation members and their pinned evidence", () => {
		const graph = buildMapGraph(
			payload({
				nodes: [
					node({
						detail: {
							consolidation: {
								memberCount: 2,
								members: [
									{
										evidence: [
											{
												conversation_id: "conversation-1",
												label: "Conversation one",
												quotes: ["Pinned quote"],
											},
										],
										objectId: "source-1",
										revisionId: "source-rev-1",
										statement: "First source statement",
									},
									{
										objectId: "source-2",
										revisionId: "source-rev-2",
										statement: "Second source statement",
									},
								],
							},
							statement: "Combined statement",
						},
					}),
				],
			}),
		);

		expect(graph.placedNodes[0].metadata.consolidation).toEqual({
			memberCount: 2,
		});
		const detail = graph.objectsById.get("rev-1")?.detail;
		expect(detail).toMatchObject({
			consolidation: { legacy: false, memberCount: 2 },
		});
		if (detail?.type === "argument") {
			expect(detail.consolidation?.members).toHaveLength(2);
			expect(detail.consolidation?.members[0]).toMatchObject({
				evidence: [
					{
						conversationId: "conversation-1",
						quotes: ["Pinned quote"],
					},
				],
				objectId: "source-1",
			});
		}
	});

	it("accepts trusted legacy counts without statements and rejects inconsistent lineage", () => {
		const graph = buildMapGraph(
			payload({
				nodes: [
					node({
						detail: {
							consolidation: { legacy: true, memberCount: 3, members: [] },
							statement: "Older merge",
						},
						revisionId: "legacy",
					}),
					node({
						detail: {
							consolidation: {
								memberCount: 3,
								members: [
									{ objectId: "one", revisionId: "r1", statement: "One" },
									{ objectId: "two", revisionId: "r2", statement: "Two" },
								],
							},
						},
						revisionId: "malformed",
					}),
				],
			}),
		);
		expect(graph.allNodes[0].metadata.consolidation).toEqual({
			memberCount: 3,
		});
		expect(graph.allNodes[1].metadata.consolidation).toBeUndefined();
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

describe("conversations behind a node", () => {
	const evidence = (conversationId: string, createdAt: string) => ({
		conversationId,
		createdAt,
		quotes: [`Something said in ${conversationId}`],
	});

	it("gives every conversation a slot, oldest first, as popcorn does", () => {
		const graph = buildMapGraph(
			payload({
				nodes: [
					node({
						detail: { evidence: [evidence("c-late", "2026-09-02T10:00:00Z")] },
						revisionId: "rev-late",
					}),
					node({
						detail: { evidence: [evidence("c-first", "2026-09-01T09:00:00Z")] },
						revisionId: "rev-first",
					}),
				],
			}),
		);
		const slotsOf = (id: string) =>
			graph.allNodes.find((item) => item.id === id)?.metadata.conversationSlots;
		expect(slotsOf("rev-first")).toEqual([0]);
		expect(slotsOf("rev-late")).toEqual([1]);
		expect(graph.conversationSlotCount).toBe(2);
	});

	it("counts a merge once per member, so a blend can be weighted", () => {
		const graph = buildMapGraph(
			payload({
				nodes: [
					node({
						detail: {
							consolidation: {
								memberCount: 3,
								members: [
									{
										evidence: [evidence("c-b", "2026-09-02T10:00:00Z")],
										objectId: "m1",
										revisionId: "mr1",
										statement: "One",
									},
									{
										evidence: [evidence("c-a", "2026-09-01T10:00:00Z")],
										objectId: "m2",
										revisionId: "mr2",
										statement: "Two",
									},
									{
										evidence: [evidence("c-b", "2026-09-02T10:00:00Z")],
										objectId: "m3",
										revisionId: "mr3",
										statement: "Three",
									},
								],
							},
							evidence: [
								evidence("c-a", "2026-09-01T10:00:00Z"),
								evidence("c-b", "2026-09-02T10:00:00Z"),
							],
							statement: "Combined",
						},
						revisionId: "rev-merged",
						type: "deduplicated_argument",
					}),
				],
			}),
		);
		expect(graph.allNodes[0].metadata.conversationSlots).toEqual([0, 1, 1]);
	});

	it("takes the slots the room's projection assigns, ids and all withheld", () => {
		const graph = buildMapGraph(
			payload({
				nodes: [
					node({
						conversations: [0, 2, 2],
						detail: {},
						revisionId: "rev-room",
					}),
				],
			}),
		);
		expect(graph.allNodes[0].metadata.conversationSlots).toEqual([0, 2, 2]);
		expect(graph.conversationSlotCount).toBe(3);
	});
});

describe("the evidence on the room's map", () => {
	const roomNode = node({
		conversations: [0, 1],
		detail: {
			consolidation: {
				memberCount: 2,
				members: [
					{
						evidence: [{ conversation: 0, quotes: ["The tram is late."] }],
						statement: "The tram is late every morning",
					},
					{
						evidence: [{ conversation: 1, quotes: ["They never keep time."] }],
						statement: "Trams never keep time",
					},
				],
			},
			evidence: [
				{ conversation: 0, quotes: ["The tram is late."] },
				{ conversation: 1, quotes: ["They never keep time."] },
			],
			statement: "Trams run late",
		},
		revisionId: "rev-room",
		type: "deduplicated_argument",
	});

	it("numbers the conversations where the payload gives no names", () => {
		const graph = buildMapGraph(payload({ nodes: [roomNode] }));
		expect(graph.evidenceById.get("rev-room")).toEqual([
			{
				conversationId: "slot:0",
				label: "Conversation 1",
				quotes: ["The tram is late."],
				slot: 0,
			},
			{
				conversationId: "slot:1",
				label: "Conversation 2",
				quotes: ["They never keep time."],
				slot: 1,
			},
		]);
		expect(graph.conversationNames.size).toBe(0);
	});

	it("names them where the presentation put the names in the payload", () => {
		const graph = buildMapGraph(
			payload({
				conversationNames: { "0": "Ada", "1": "Ben" },
				nodes: [roomNode],
			}),
		);
		expect(
			graph.evidenceById.get("rev-room")?.map((group) => group.label),
		).toEqual(["Ada", "Ben"]);
		expect(graph.conversationNames.get(1)).toBe("Ben");
	});

	it("reads a merge whose members carry a statement and no identity", () => {
		const graph = buildMapGraph(payload({ nodes: [roomNode] }));
		const detail = graph.objectsById.get("rev-room")?.detail;
		expect(detail?.type).toBe("deduplicated_argument");
		const consolidation =
			detail?.type === "deduplicated_argument"
				? detail.consolidation
				: undefined;
		expect(consolidation?.memberCount).toBe(2);
		expect(consolidation?.members.map((member) => member.statement)).toEqual([
			"The tram is late every morning",
			"Trams never keep time",
		]);
		expect(consolidation?.members[1].evidence).toEqual([
			{
				conversationId: "slot:1",
				label: "Conversation 2",
				quotes: ["They never keep time."],
				slot: 1,
			},
		]);
		expect(graph.allNodes[0].metadata.consolidation).toEqual({
			memberCount: 2,
		});
	});

	it("refuses a member that is half identified, which is malformed", () => {
		const graph = buildMapGraph(
			payload({
				nodes: [
					node({
						detail: {
							consolidation: {
								memberCount: 2,
								members: [
									{ evidence: [], objectId: "m1", statement: "One" },
									{ evidence: [], statement: "Two" },
								],
							},
							statement: "Combined",
						},
						revisionId: "rev-broken",
						type: "deduplicated_argument",
					}),
				],
			}),
		);
		const detail = graph.objectsById.get("rev-broken")?.detail;
		expect(
			detail?.type === "deduplicated_argument" ? detail.consolidation : "gone",
		).toBeUndefined();
	});
});
