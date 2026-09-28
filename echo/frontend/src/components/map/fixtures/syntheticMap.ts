import { OBJECT_TYPES } from "../attributes";
import { defaultVisibleTypes } from "../data/scope";
import type {
	FactCheckStates,
	MapEvidence,
	MapPayloadBudgets,
	MapPayloadNode,
	MapPayloadRelation,
	MapPayloadV2,
} from "../hooks";
import type {
	FactCheckState,
	MapGraphNode,
	MapKind,
	MapValence,
	ObjectType,
} from "../types";

/** Small seeded PRNG (mulberry32): same seed, same sequence. */
export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let r = Math.imul(a ^ (a >>> 15), 1 | a);
		r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
		return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
	};
}

export type SyntheticMapOptions = {
	count: number;
	seed?: number;
	dims?: number;
	clusters?: number;
	/** Per-dimension noise around a cluster centroid. */
	spread?: number;
};

const VALENCES: MapValence[] = ["positive", "negative", "neutral"];

const FACT_CHECKS: FactCheckState[] = [
	{ status: "idle" },
	{ startedAt: "2026-01-01T00:00:00.000Z", status: "processing" },
	{
		checkedAt: "2026-01-01T00:00:00.000Z",
		justification: "Synthetic justification",
		sources: [{ title: "Synthetic source", url: "https://example.org" }],
		status: "done",
		verdict: "true",
	},
	{
		checkedAt: "2026-01-01T00:00:00.000Z",
		justification: "Synthetic justification",
		sources: [],
		status: "done",
		verdict: "contested",
	},
	{
		at: "2026-01-01T00:00:00.000Z",
		message: "Synthetic error",
		status: "error",
	},
];

/**
 * Deterministic argument nodes in a few clusters of a low-dimensional
 * embedding space, with mixed kinds and valences. Labels are fictional.
 */
export function createSyntheticMap({
	count,
	seed = 42,
	dims = 32,
	clusters = 4,
	spread = 0.35,
}: SyntheticMapOptions): MapGraphNode[] {
	const random = mulberry32(seed);
	const centroids = Array.from({ length: clusters }, () =>
		Array.from({ length: dims }, () => random() * 2 - 1),
	);
	const start = Date.UTC(2026, 0, 1);

	return Array.from({ length: count }, (_, index) => {
		const centroid = centroids[index % clusters];
		const embedding = centroid.map(
			(value) => value + (random() * 2 - 1) * spread,
		);
		const kind: MapKind = random() < 0.3 ? "claim" : "argument";
		const valence = VALENCES[Math.floor(random() * VALENCES.length)];
		const label =
			kind === "claim"
				? `Synthetic claim ${index}`
				: `Synthetic argument ${index}`;
		const id = `synthetic-${index}`;

		return {
			embedding,
			id,
			label,
			metadata: {
				conversationIds: [`synthetic-conversation-${index % 7}`],
				createdAt: new Date(start + index * 60_000).toISOString(),
				epistemicKind: kind,
				factCheck:
					kind === "claim"
						? FACT_CHECKS[index % FACT_CHECKS.length]
						: undefined,
				kind,
				objectId: id,
				objectType: "argument",
				quotes: [`Synthetic quote ${index}`],
				revisionId: id,
				sizeScale: 1,
				valence,
			},
		};
	});
}

// ---------------------------------------------------------------------------
// Mixed payloads
// ---------------------------------------------------------------------------

export type SyntheticPayloadOptions = {
	counts: Partial<Record<ObjectType, number>>;
	budgets: MapPayloadBudgets;
	seed?: number;
	dims?: number;
	clusters?: number;
	spread?: number;
	/** Every nth object has no vector. 0 or absent: all have one. */
	missingEvery?: number;
};

const RUNGS = ["voiced", "named", "inferred"] as const;

/**
 * A deterministic v2 payload with every requested type, explicit relations
 * (tension poles, stakeholder positions, deduplication lineage) and objects
 * without vectors. Labels are fictional.
 */
export function createSyntheticPayload({
	counts,
	budgets,
	seed = 7,
	dims = 32,
	clusters = 5,
	spread = 0.35,
	missingEvery = 0,
}: SyntheticPayloadOptions): {
	payload: MapPayloadV2;
	factChecks: FactCheckStates;
} {
	const random = mulberry32(seed);
	const centroids = Array.from({ length: clusters }, () =>
		Array.from({ length: dims }, () => random() * 2 - 1),
	);
	const start = Date.UTC(2026, 0, 1);
	const nodes: MapPayloadNode[] = [];
	const relations: MapPayloadRelation[] = [];
	const unplaced: string[] = [];
	const factChecks: FactCheckStates = {};
	const idsByType = new Map<ObjectType, string[]>();
	let position = 0;

	const evidenceFor = (index: number, text: string): MapEvidence[] => [
		{
			conversation_id: `synthetic-conversation-${index % 9}`,
			created_at: null,
			label: `Synthetic conversation ${(index % 9) + 1}`,
			quotes: [`${text}, as a participant put it`],
		},
	];

	for (const type of OBJECT_TYPES) {
		const count = counts[type] ?? 0;
		const ids: string[] = [];
		for (let index = 0; index < count; index += 1) {
			const revisionId = `rev-${type}-${index}`;
			const centroid = centroids[position % clusters];
			const vector = centroid.map(
				(value) => value + (random() * 2 - 1) * spread,
			);
			const missing = missingEvery > 0 && position % missingEvery === 1;
			position += 1;
			if (missing) unplaced.push(revisionId);
			ids.push(revisionId);

			const createdAt = new Date(start + position * 60_000).toISOString();
			const base = {
				embedding: missing ? null : vector,
				objectId: `obj-${type}-${index}`,
				provenance: {
					origin: "generated" as const,
					recipeId: type,
					recipeVersion: "fixture-1",
					runId: `run-${type}`,
				},
				revisionId,
				type,
			};

			if (type === "argument" || type === "deduplicated_argument") {
				const claim = random() < 0.3;
				const label = claim
					? `Synthetic ${type === "argument" ? "claim" : "combined claim"} ${index}`
					: `Synthetic ${type === "argument" ? "argument" : "combined argument"} ${index}`;
				// Every fifth has no valence yet: "Not assessed", not neutral.
				const valence =
					index % 5 === 4
						? undefined
						: VALENCES[Math.floor(random() * VALENCES.length)];
				if (claim) {
					factChecks[revisionId] = FACT_CHECKS[index % FACT_CHECKS.length];
				}
				nodes.push({
					...base,
					attributes: {
						epistemicKind: claim ? "claim" : "argument",
						...(valence ? { valence } : {}),
					},
					detail: {
						created_at: createdAt,
						evidence: evidenceFor(index, label),
						statement: label,
					},
					factCheck: {
						eligible: claim,
						...(claim ? { claimKey: `claim-${revisionId}` } : {}),
					},
					label,
				});
			} else if (type === "popcorn") {
				const label = `Synthetic phrase ${index}`;
				nodes.push({
					...base,
					attributes: {},
					detail: {
						created_at: createdAt,
						evidence: evidenceFor(index, label),
						phrase: label,
					},
					factCheck: { eligible: false },
					label,
				});
			} else if (type === "tension") {
				const label = `Synthetic tension ${index}`;
				nodes.push({
					...base,
					attributes: {},
					detail: {
						created_at: createdAt,
						evidence: evidenceFor(index, label),
						knot: `Two groups read synthetic topic ${index} in opposite ways.`,
						poleA: `Synthetic pole A ${index}`,
						poleB: `Synthetic pole B ${index}`,
						toResolve: `Whether synthetic topic ${index} can hold both.`,
					},
					factCheck: { eligible: false },
					label,
				});
			} else {
				const label = `Synthetic stakeholder ${index}`;
				nodes.push({
					...base,
					attributes: {},
					detail: {
						created_at: createdAt,
						evidence: { rung: RUNGS[index % RUNGS.length] },
						name: label,
						quotes: evidenceFor(index, label),
						role: `Synthetic role ${index}`,
						stake: `Synthetic stake ${index}`,
					},
					factCheck: { eligible: false },
					label,
				});
			}
		}
		idsByType.set(type, ids);
	}

	const argumentIds = idsByType.get("argument") ?? [];
	const pick = (ids: string[], index: number) =>
		ids.length > 0 ? ids[index % ids.length] : null;
	const relate = (
		type: string,
		from: string | null,
		to: string,
		basis: MapPayloadRelation["basis"],
	) => {
		if (!from) return;
		relations.push({ basis, from, id: `${type}:${from}:${to}`, to, type });
	};

	(idsByType.get("deduplicated_argument") ?? []).forEach((id, index) => {
		relate("derived_from", id, pick(argumentIds, index * 2) ?? "", "extracted");
		relate(
			"derived_from",
			id,
			pick(argumentIds, index * 2 + 1) ?? "",
			"extracted",
		);
	});
	(idsByType.get("tension") ?? []).forEach((id, index) => {
		relate("supports_pole_a", pick(argumentIds, index * 3), id, "extracted");
		relate(
			"supports_pole_a",
			pick(argumentIds, index * 3 + 1),
			id,
			"extracted",
		);
		relate(
			"supports_pole_b",
			pick(argumentIds, index * 3 + 2),
			id,
			"extracted",
		);
	});
	const tensionIds = idsByType.get("tension") ?? [];
	(idsByType.get("stakeholder") ?? []).forEach((id, index) => {
		const argumentId = pick(argumentIds, index * 5);
		if (argumentId) relate("holds_position", id, argumentId, "extracted");
		const tensionId = pick(tensionIds, index);
		if (tensionId) relate("affected_by", id, tensionId, "inferred");
	});
	// derived_from with an empty target is not a relation.
	const kept = relations.filter((relation) => relation.from && relation.to);

	const typeCounts = Object.fromEntries(
		OBJECT_TYPES.map((type) => [type, counts[type] ?? 0]),
	) as Record<ObjectType, number>;

	return {
		factChecks,
		payload: {
			budgets,
			counts: typeCounts,
			embedding: { dims, key: "fixture", model: "fixture" },
			nodes,
			overBudget: false,
			relations: kept,
			scope: { types: defaultVisibleTypes(typeCounts, budgets.nodeLimit) },
			snapshot: {
				createdAt: new Date(start).toISOString(),
				id: `fixture-snapshot-${seed}-${position}`,
				parentId: null,
				stale: [],
			},
			unplaced,
			version: 2,
		},
	};
}
