import { createSyntheticMap } from "../fixtures/syntheticMap";
import type {
	FactCheckStates,
	MapArgument,
	MapConversation,
	MapResult,
} from "../hooks";

export const FIXTURE_COUNTS = [50, 150, 200] as const;

/** `?fixture=` value to a supported node count, else null. */
export const parseFixtureCount = (value: string | null): number | null => {
	if (!value) return null;
	const count = Number(value);
	return (FIXTURE_COUNTS as ReadonlyArray<number>).includes(count)
		? count
		: null;
};

/**
 * A ready result built from synthetic nodes, so fixture mode runs the same
 * adapter, panels and renderers as real data without any request.
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
		if (node.metadata.kind === "claim" && node.metadata.factCheck) {
			factChecks[node.id] = node.metadata.factCheck;
		}
		return {
			claim_key: node.metadata.kind === "claim" ? `claim-${node.id}` : null,
			created_at: createdAt,
			embedding: node.embedding,
			evidence: node.metadata.conversationIds.map((conversationId) => ({
				conversation_id: conversationId,
				created_at: createdAt,
				label: conversations.get(conversationId)?.label ?? conversationId,
				quotes: node.metadata.quotes,
			})),
			id: node.id,
			kind: node.metadata.kind,
			statement: node.label,
			valence: node.metadata.valence,
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
