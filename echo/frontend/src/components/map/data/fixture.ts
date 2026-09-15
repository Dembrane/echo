import {
	createSyntheticMap,
	createSyntheticPayload,
} from "../fixtures/syntheticMap";
import type {
	FactCheckStates,
	MapArgument,
	MapConversation,
	MapGraphResponse,
	MapPayloadBudgets,
	MapResult,
} from "../hooks";

/**
 * `?fixture=` values. Numbers are legacy argument-only results of that size;
 * the names are mixed v2 payloads for each entry state.
 */
export const MAP_FIXTURES = [
	"50",
	"150",
	"200",
	"mixed",
	"small",
	"single",
	"empty",
	"oversized",
] as const;

export type MapFixtureId = (typeof MAP_FIXTURES)[number];

/** `?fixture=` value to a supported fixture, else null. */
export const parseFixture = (value: string | null): MapFixtureId | null =>
	value && (MAP_FIXTURES as ReadonlyArray<string>).includes(value)
		? (value as MapFixtureId)
		: null;

/** The budgets a fixture server would send. Fixture data, not app limits. */
export const FIXTURE_BUDGETS: MapPayloadBudgets = {
	ceilings: { edgeLimit: 3000, nodeLimit: 1000 },
	defaults: { edgeLimit: 450, nodeLimit: 150 },
	edgeLimit: 450,
	nodeLimit: 150,
};

/**
 * A ready legacy result built from synthetic nodes, so fixture mode runs the
 * same adapter, panels and renderers as real data without any request.
 */
export function fixtureMapResult(count: number): {
	result: MapResult;
	factChecks: FactCheckStates;
} {
	const nodes = createSyntheticMap({ count });
	const conversations = new Map<string, MapConversation>();
	const factChecks: FactCheckStates = {};

	const args = nodes.map((node): MapArgument => {
		const createdAt = node.metadata.createdAt;
		for (const conversationId of node.metadata.conversationIds) {
			if (!conversations.has(conversationId)) {
				conversations.set(conversationId, {
					created_at: createdAt,
					id: conversationId,
					label: `Synthetic conversation ${conversations.size + 1}`,
				});
			}
		}
		const claim = node.metadata.epistemicKind === "claim";
		if (claim && node.metadata.factCheck) {
			factChecks[node.id] = node.metadata.factCheck;
		}
		return {
			claim_key: claim ? `claim-${node.id}` : null,
			created_at: createdAt,
			embedding: node.embedding,
			evidence: node.metadata.conversationIds.map((conversationId) => ({
				conversation_id: conversationId,
				created_at: createdAt,
				label: conversations.get(conversationId)?.label ?? conversationId,
				quotes: node.metadata.quotes,
			})),
			id: node.id,
			kind: claim ? "claim" : "argument",
			statement: node.label,
			valence: node.metadata.valence ?? "neutral",
		};
	});

	const now = new Date(Date.UTC(2026, 0, 1)).toISOString();
	return {
		factChecks,
		result: {
			arguments: args,
			completed_at: now,
			conversations: Array.from(conversations.values()),
			created_at: now,
			embedding: {
				dims: nodes[0]?.embedding.length ?? null,
				key: "fixture",
				model: "fixture",
			},
			id: `fixture-${count}`,
			missing_embeddings: [],
			recipe_version: "fixture",
			source_fingerprint: "fixture",
			stats: { arguments: args.length, conversations: conversations.size },
			status: "ready",
		},
	};
}

/** The response and saved fact-check states of one fixture. */
export function fixtureMapData(id: MapFixtureId): {
	response: MapGraphResponse;
	factChecks: FactCheckStates;
} {
	switch (id) {
		case "mixed": {
			const { payload, factChecks } = createSyntheticPayload({
				budgets: FIXTURE_BUDGETS,
				counts: {
					argument: 60,
					deduplicated_argument: 24,
					popcorn: 30,
					stakeholder: 8,
					tension: 6,
				},
				missingEvery: 23,
			});
			return { factChecks, response: payload };
		}
		case "small": {
			const { payload, factChecks } = createSyntheticPayload({
				budgets: FIXTURE_BUDGETS,
				counts: { argument: 8, stakeholder: 2, tension: 2 },
				seed: 11,
			});
			return { factChecks, response: payload };
		}
		case "single": {
			const { payload, factChecks } = createSyntheticPayload({
				budgets: FIXTURE_BUDGETS,
				counts: { tension: 1 },
				seed: 13,
			});
			return { factChecks, response: payload };
		}
		case "empty": {
			const { payload, factChecks } = createSyntheticPayload({
				budgets: FIXTURE_BUDGETS,
				counts: {},
				seed: 17,
			});
			return { factChecks, response: payload };
		}
		case "oversized": {
			const { payload, factChecks } = createSyntheticPayload({
				budgets: FIXTURE_BUDGETS,
				counts: { argument: 400 },
				missingEvery: 97,
				seed: 19,
			});
			return { factChecks, response: payload };
		}
		default: {
			const { result, factChecks } = fixtureMapResult(Number(id));
			return { factChecks, response: result };
		}
	}
}
