import {
	attributeInputsOf,
	deriveDisplayVerdict,
	isFactCheckEligible,
	isObjectType,
	OBJECT_TYPES,
	sizeScaleFor,
} from "../attributes";
import type { MapBudgetBounds, MapBudgets } from "../budgets";
import {
	type EmbeddingRejection,
	partitionByEmbedding,
} from "../graph/validate";
import type {
	FactCheckStates,
	MapEvidence,
	MapGraphResponse,
	MapPayloadNode,
	MapPayloadV2,
	MapProvenance,
	MapResult,
	MapStaleRef,
} from "../hooks";
import type {
	FactCheckState,
	MapEpistemicKind,
	MapGraphNode,
	MapRelation,
	MapValence,
	ObjectType,
} from "../types";

export type EvidenceGroup = {
	conversationId: string;
	label: string;
	quotes: string[];
};

export type UnplacedObject = {
	id: string;
	reason: EmbeddingRejection;
};

/** @deprecated use UnplacedObject. */
export type UnplacedArgument = UnplacedObject;

export type MapProvenanceInfo = {
	runId: string | null;
	recipeId: string | null;
	recipeVersion: string | null;
	origin: MapProvenance["origin"];
	/** Served from a v1 result. */
	legacy: boolean;
};

export type ConsolidationMember = {
	objectId: string;
	revisionId: string;
	statement: string;
	evidence: EvidenceGroup[];
};

export type ConsolidationDetail = {
	memberCount: number;
	members: ConsolidationMember[];
	/** Older trusted results retained counts but not their source statements. */
	legacy: boolean;
};

export type ArgumentDetail = {
	type: "argument" | "deduplicated_argument";
	statement: string;
	consolidation?: ConsolidationDetail;
};

export type PopcornDetail = { type: "popcorn"; phrase: string };

export type TensionDetail = {
	type: "tension";
	poleA: string;
	poleB: string;
	/** The deck's `knot`; the inspector calls it the narrative. */
	knot: string;
	toResolve: string;
};

export type StakeholderRung = "voiced" | "named" | "inferred";

export type StakeholderDetail = {
	type: "stakeholder";
	name: string;
	role: string;
	stake: string;
	rung: StakeholderRung | null;
	invokedBy: string | null;
};

export type ObjectDetail =
	| ArgumentDetail
	| PopcornDetail
	| TensionDetail
	| StakeholderDetail;

export type MapObjectInfo = {
	objectId: string;
	revisionId: string;
	type: ObjectType;
	provenance: MapProvenanceInfo;
	detail: ObjectDetail;
	factCheck: { eligible: boolean; claimKey: string | null };
};

export type RelatedStub = {
	objectId: string;
	revisionId: string;
	type: ObjectType;
	label: string;
};

export type MapGraphData = {
	version: 1 | 2;
	/** The id fact-checks and titles are requested under. */
	resultId: string;
	snapshotId: string | null;
	/** Every object, placed or not. Fact-check state is not merged in. */
	allNodes: MapGraphNode[];
	/** Objects with a usable embedding, in payload order. */
	placedNodes: MapGraphNode[];
	/** Objects the map cannot place, with the reason. */
	unplaced: UnplacedObject[];
	/** Quotes per source conversation, by node id. */
	evidenceById: Map<string, EvidenceGroup[]>;
	objectsById: Map<string, MapObjectInfo>;
	/** Explicit relations with node (revision) ids as endpoints. */
	relations: MapRelation[];
	/** Objects outside this payload that relations point at. */
	relatedStubs: Map<string, RelatedStub>;
	/** Objects per type before filtering. */
	counts: Record<ObjectType, number>;
	/** Server defaults and ceilings; null for a legacy result. */
	budgetBounds: MapBudgetBounds | null;
	/** The budgets the server applied; null for a legacy result. */
	serverBudgets: MapBudgets | null;
	/** The server omitted nodes and vectors because the scope is over budget. */
	overBudget: boolean;
	scope: { types: ObjectType[] | null; resultScope: string | null };
	stale: MapStaleRef[];
	/** Source conversations of a legacy result; null when unknown. */
	conversationCount: number | null;
	/** How many conversation colours this payload asks the legend for. */
	conversationSlotCount: number;
};

export const isMapPayloadV2 = (value: unknown): value is MapPayloadV2 =>
	!!value &&
	typeof value === "object" &&
	(value as { version?: unknown }).version === 2;

// ---------------------------------------------------------------------------
// Defensive readers for the type-specific projections
// ---------------------------------------------------------------------------

const asRecord = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};

const asString = (...values: unknown[]): string => {
	for (const value of values) {
		if (typeof value === "string" && value) return value;
	}
	return "";
};

const asStringOrNull = (...values: unknown[]): string | null =>
	asString(...values) || null;

const VALENCES: ReadonlySet<string> = new Set([
	"positive",
	"negative",
	"neutral",
]);
const RUNGS: ReadonlySet<string> = new Set(["voiced", "named", "inferred"]);
const BASES: ReadonlySet<string> = new Set([
	"extracted",
	"inferred",
	"authored",
]);

const parseEvidence = (value: unknown): MapEvidence[] => {
	if (!Array.isArray(value)) return [];
	const evidence: MapEvidence[] = [];
	for (const item of value) {
		const record = asRecord(item);
		const conversationId = asString(
			record.conversation_id,
			record.conversationId,
		);
		if (!conversationId) continue;
		evidence.push({
			conversation_id: conversationId,
			created_at: asStringOrNull(record.created_at, record.createdAt),
			label: asString(record.label) || conversationId,
			quotes: Array.isArray(record.quotes)
				? record.quotes.filter(
						(quote): quote is string => typeof quote === "string",
					)
				: [],
		});
	}
	return evidence;
};

const groupEvidence = (evidence: MapEvidence[]): EvidenceGroup[] => {
	const groups = new Map<string, EvidenceGroup>();
	for (const item of evidence) {
		const existing = groups.get(item.conversation_id);
		if (existing) {
			existing.quotes.push(...(item.quotes ?? []));
		} else {
			groups.set(item.conversation_id, {
				conversationId: item.conversation_id,
				label: item.label,
				quotes: [...(item.quotes ?? [])],
			});
		}
	}
	return Array.from(groups.values());
};

/**
 * Read only lineage that is internally consistent. The server validates that
 * lineage against pinned inputs; this check prevents malformed or legacy
 * numeric metadata from becoming a merge badge in the client.
 */
const parseConsolidation = (
	value: unknown,
): ConsolidationDetail | undefined => {
	const consolidation = asRecord(value);
	if (!Array.isArray(consolidation.members)) return undefined;
	const memberCount = consolidation.memberCount;
	const legacy = consolidation.legacy === true;
	if (
		typeof memberCount !== "number" ||
		!Number.isInteger(memberCount) ||
		memberCount <= 1
	) {
		return undefined;
	}
	if (legacy && consolidation.members.length === 0) {
		return { legacy: true, memberCount, members: [] };
	}
	const members: ConsolidationMember[] = [];
	const objectIds = new Set<string>();
	for (const value of consolidation.members) {
		const member = asRecord(value);
		const objectId = asString(member.objectId, member.object_id);
		const revisionId = asString(member.revisionId, member.revision_id);
		if (!objectId || !revisionId || objectIds.has(objectId)) return undefined;
		objectIds.add(objectId);
		members.push({
			evidence: groupEvidence(parseEvidence(member.evidence)),
			objectId,
			revisionId,
			statement: asString(member.statement),
		});
	}
	if (memberCount !== members.length) {
		return undefined;
	}
	return { legacy: false, memberCount, members };
};

const parseDetail = (
	type: ObjectType,
	label: string,
	raw: unknown,
): ObjectDetail => {
	const detail = asRecord(raw);
	switch (type) {
		case "popcorn":
			return { phrase: asString(detail.phrase, label), type };
		case "tension":
			return {
				knot: asString(detail.knot, detail.narrative),
				poleA: asString(detail.poleA, detail.pole_a),
				poleB: asString(detail.poleB, detail.pole_b),
				toResolve: asString(detail.toResolve, detail.to_resolve),
				type,
			};
		case "stakeholder": {
			const evidence = asRecord(detail.evidence);
			const rung = asString(evidence.rung, detail.rung);
			return {
				invokedBy: asStringOrNull(evidence.invokedBy, detail.invokedBy),
				name: asString(detail.name, label),
				role: asString(detail.role),
				rung: RUNGS.has(rung) ? (rung as StakeholderRung) : null,
				stake: asString(detail.stake),
				type,
			};
		}
		default:
			return {
				consolidation: parseConsolidation(detail.consolidation),
				statement: asString(detail.statement, label),
				type,
			};
	}
};

/** Source evidence of a projection: `evidence` when it is a list, else `quotes`. */
const detailEvidence = (raw: unknown): MapEvidence[] => {
	const detail = asRecord(raw);
	return Array.isArray(detail.evidence)
		? parseEvidence(detail.evidence)
		: parseEvidence(detail.quotes);
};

// ---------------------------------------------------------------------------
// One normalised shape for v1 and v2
// ---------------------------------------------------------------------------

type Normalised = {
	version: 1 | 2;
	resultId: string;
	snapshotId: string | null;
	nodes: MapPayloadNode[];
	relations: MapPayloadV2["relations"];
	related: NonNullable<MapPayloadV2["related"]>;
	unplaced: string[];
	counts: Partial<Record<ObjectType, number>> | null;
	budgets: MapPayloadV2["budgets"] | null;
	overBudget: boolean;
	scope: { types: ObjectType[] | null; resultScope: string | null };
	stale: MapStaleRef[];
	conversationCount: number | null;
};

/** A v1 result as `argument` objects with legacy provenance. */
const fromLegacy = (result: MapResult): Normalised => ({
	budgets: null,
	conversationCount: Array.isArray(result.conversations)
		? result.conversations.length
		: null,
	counts: null,
	nodes: (result.arguments ?? []).map(
		(argument): MapPayloadNode => ({
			attributes: {
				epistemicKind: argument.kind,
				valence: argument.valence,
			},
			detail: {
				claimKey: argument.claim_key,
				created_at: argument.created_at,
				evidence: argument.evidence ?? [],
				statement: argument.statement,
			},
			// An absent vector becomes empty, which the partition reports.
			embedding: Array.isArray(argument.embedding) ? argument.embedding : null,
			factCheck: {
				claimKey: argument.claim_key ?? undefined,
				eligible: argument.kind === "claim",
			},
			label: argument.statement,
			// Legacy node ids stay the ids fact-checks and titles use.
			objectId: argument.id,
			provenance: {
				origin: "imported",
				recipeVersion: result.recipe_version ?? undefined,
				runId: result.id,
			},
			revisionId: argument.id,
			type: "argument",
		}),
	),
	overBudget: false,
	related: [],
	relations: [],
	resultId: result.id,
	scope: { resultScope: null, types: null },
	snapshotId: null,
	stale: [],
	unplaced: result.missing_embeddings ?? [],
	version: 1,
});

const fromV2 = (payload: MapPayloadV2): Normalised => ({
	budgets: payload.budgets ?? null,
	conversationCount: null,
	counts: payload.counts ?? null,
	nodes: payload.overBudget ? [] : (payload.nodes ?? []),
	overBudget: Boolean(payload.overBudget),
	related: payload.related ?? [],
	relations: payload.relations ?? [],
	resultId: payload.snapshot?.id ?? "",
	scope: {
		resultScope: payload.scope?.resultScope ?? null,
		types: Array.isArray(payload.scope?.types)
			? payload.scope.types.filter(isObjectType)
			: null,
	},
	snapshotId: payload.snapshot?.id ?? null,
	stale: payload.snapshot?.stale ?? [],
	unplaced: payload.unplaced ?? [],
	version: 2,
});

const zeroCounts = (): Record<ObjectType, number> =>
	Object.fromEntries(OBJECT_TYPES.map((type) => [type, 0])) as Record<
		ObjectType,
		number
	>;

/**
 * Shapes a v2 payload or a legacy v1 result into typed map nodes and
 * partitions them by embedding. Node ids are revision ids. Objects without a
 * usable vector are listed as unplaced, never dropped. Fact-check state stays
 * out of these nodes so a check never changes their identity; see
 * withFactChecks.
 */
export function buildMapGraph(input: MapGraphResponse): MapGraphData {
	const data = isMapPayloadV2(input)
		? fromV2(input)
		: fromLegacy(input as MapResult);
	const legacy = data.version === 1;

	const evidenceById = new Map<string, EvidenceGroup[]>();
	const objectsById = new Map<string, MapObjectInfo>();
	const allNodes: MapGraphNode[] = [];
	// Which conversation every node came from, one entry per contributing
	// member, and when that conversation started. The slots themselves are
	// assigned once every node has been read, below.
	const sourcesById = new Map<string, string[]>();
	const slotsById = new Map<string, number[]>();
	const startedAt = new Map<string, string>();

	for (const item of data.nodes) {
		if (!isObjectType(item.type) || !item.revisionId) continue;
		const type = item.type;
		const id = item.revisionId;
		const label = asString(item.label);
		const evidence = detailEvidence(item.detail);
		evidenceById.set(id, groupEvidence(evidence));

		const rawKind = item.attributes?.epistemicKind;
		const epistemicKind: MapEpistemicKind | undefined =
			rawKind === "claim" || rawKind === "argument" ? rawKind : undefined;
		const rawValence = item.attributes?.valence;
		const valence =
			rawValence && VALENCES.has(rawValence)
				? (rawValence as MapValence)
				: undefined;
		const eligible = Boolean(item.factCheck?.eligible);
		const detailRecord = asRecord(item.detail);

		const parsedDetail = parseDetail(type, label, item.detail);
		// A merge counts once per member, so a blend follows the weight of each
		// conversation in it; anything else counts each of its conversations once.
		const members =
			parsedDetail.type === "argument" ||
			parsedDetail.type === "deduplicated_argument"
				? parsedDetail.consolidation?.members
				: undefined;
		const sources = members?.length
			? members.flatMap((member) =>
					member.evidence.map((group) => group.conversationId),
				)
			: evidence.map((entry) => entry.conversation_id);
		sourcesById.set(id, sources);
		if (Array.isArray(item.conversations)) {
			slotsById.set(
				id,
				item.conversations.filter(
					(slot): slot is number => Number.isInteger(slot) && slot >= 0,
				),
			);
		}
		for (const entry of evidence) {
			const known = startedAt.get(entry.conversation_id);
			const at = entry.created_at ?? "";
			if (at && (known === undefined || at < known)) {
				startedAt.set(entry.conversation_id, at);
			} else if (known === undefined) {
				startedAt.set(entry.conversation_id, "");
			}
		}
		objectsById.set(id, {
			detail: parsedDetail,
			factCheck: {
				claimKey: asStringOrNull(
					item.factCheck?.claimKey,
					detailRecord.claimKey,
				),
				eligible,
			},
			objectId: item.objectId || id,
			provenance: {
				legacy,
				origin: item.provenance?.origin ?? "imported",
				recipeId: item.provenance?.recipeId ?? null,
				recipeVersion: item.provenance?.recipeVersion ?? null,
				runId: item.provenance?.runId ?? null,
			},
			revisionId: id,
			type,
		});

		allNodes.push({
			// An absent vector becomes empty, which the partition reports as missing.
			embedding: Array.isArray(item.embedding) ? item.embedding : [],
			id,
			label,
			metadata: {
				consolidation:
					parsedDetail.type === "argument" ||
					parsedDetail.type === "deduplicated_argument"
						? parsedDetail.consolidation
							? { memberCount: parsedDetail.consolidation.memberCount }
							: undefined
						: undefined,
				conversationIds: Array.from(
					new Set(evidence.map((entry) => entry.conversation_id)),
				),
				// Filled in below, once every node's conversations are known.
				conversationSlots: [],
				createdAt: asStringOrNull(
					detailRecord.created_at,
					detailRecord.createdAt,
				),
				epistemicKind,
				factCheckEligible: eligible,
				kind: epistemicKind ?? "argument",
				objectId: item.objectId || id,
				objectType: type,
				quotes: evidence.flatMap((entry) => entry.quotes ?? []),
				revisionId: id,
				sizeScale: sizeScaleFor(type),
				valence,
			},
		});
	}

	// Palette slots, in the order popcorn hands its markers out: oldest
	// conversation first, so a conversation keeps its colour as later ones
	// join. The room's projection assigns the slots itself and says so per
	// node; there the ids never leave the server.
	const slotOf = new Map<string, number>(
		Array.from(startedAt.entries())
			.sort(
				(a, b) =>
					(a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) ||
					(a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
			)
			.map(([conversationId], slot) => [conversationId, slot] as const),
	);
	let conversationSlotCount = slotOf.size;
	for (const node of allNodes) {
		const given = slotsById.get(node.id);
		const slots =
			given ??
			(sourcesById.get(node.id) ?? [])
				.map((conversationId) => slotOf.get(conversationId))
				.filter((slot): slot is number => slot !== undefined);
		node.metadata.conversationSlots = [...slots].sort((a, b) => a - b);
		for (const slot of slots) {
			conversationSlotCount = Math.max(conversationSlotCount, slot + 1);
		}
	}

	const partition = partitionByEmbedding(allNodes);
	const unplaced: UnplacedObject[] = [...partition.invalid];
	const reported = new Set(unplaced.map((item) => item.id));
	const known = new Set(allNodes.map((node) => node.id));
	const placedNodes: MapGraphNode[] = [];
	const serverMissing = new Set(data.unplaced);

	for (const node of partition.valid) {
		// The server lists objects whose vector could not be loaded; never
		// place those, even if a stale vector came along.
		if (serverMissing.has(node.id)) {
			unplaced.push({ id: node.id, reason: "missing" });
			reported.add(node.id);
			continue;
		}
		placedNodes.push(node);
	}
	for (const id of serverMissing) {
		if (!reported.has(id) && known.has(id)) {
			unplaced.push({ id, reason: "missing" });
			reported.add(id);
		}
	}

	const relations: MapRelation[] = [];
	for (const relation of data.relations) {
		if (!relation?.from || !relation?.to || !relation.type) continue;
		relations.push({
			basis: BASES.has(relation.basis) ? relation.basis : "inferred",
			id: relation.id || `${relation.type}:${relation.from}:${relation.to}`,
			source: relation.from,
			target: relation.to,
			type: relation.type,
		});
	}

	const relatedStubs = new Map<string, RelatedStub>();
	for (const stub of data.related) {
		if (!stub?.revisionId || !isObjectType(stub.type)) continue;
		relatedStubs.set(stub.revisionId, stub);
	}

	const counts = zeroCounts();
	if (data.counts) {
		for (const type of OBJECT_TYPES) {
			const value = data.counts[type];
			counts[type] = typeof value === "number" && value > 0 ? value : 0;
		}
	} else {
		for (const node of allNodes) counts[node.metadata.objectType] += 1;
	}

	return {
		allNodes,
		budgetBounds: data.budgets
			? { ceilings: data.budgets.ceilings, defaults: data.budgets.defaults }
			: null,
		conversationCount: data.conversationCount,
		conversationSlotCount,
		counts,
		evidenceById,
		objectsById,
		overBudget: data.overBudget,
		placedNodes,
		relatedStubs,
		relations,
		resultId: data.resultId,
		scope: data.scope,
		serverBudgets: data.budgets
			? { edgeLimit: data.budgets.edgeLimit, nodeLimit: data.budgets.nodeLimit }
			: null,
		snapshotId: data.snapshotId,
		stale: data.stale,
		unplaced,
		version: data.version,
	};
}

const isEligible = (node: Pick<MapGraphNode, "metadata">) =>
	isFactCheckEligible(attributeInputsOf(node.metadata));

/** The fact-check state an eligible claim shows: server state, else idle. */
export const factCheckFor = (
	node: Pick<MapGraphNode, "id" | "metadata">,
	states: FactCheckStates | undefined,
): FactCheckState | undefined =>
	isEligible(node) ? (states?.[node.id] ?? { status: "idle" }) : undefined;

/**
 * A string that changes only when a claim's displayed verdict changes. The
 * renderers restyle from node metadata, so memoising node arrays on this keeps
 * a justification or timestamp update from rebuilding the graphs.
 */
export function factCheckSignature(
	nodes: ReadonlyArray<MapGraphNode>,
	states: FactCheckStates | undefined,
): string {
	const parts: string[] = [];
	for (const node of nodes) {
		if (!isEligible(node)) continue;
		const state = factCheckFor(node, states);
		// Errors show apart from unverified, so they are part of the signature.
		const shown =
			state?.status === "error" ? "error" : deriveDisplayVerdict(state);
		parts.push(`${node.id}:${shown}`);
	}
	return parts.join("|");
}

/**
 * Nodes with their claim's fact-check state in metadata. Embeddings, ids and
 * labels are shared with the input; other nodes keep their node object.
 */
export function withFactChecks(
	nodes: ReadonlyArray<MapGraphNode>,
	states: FactCheckStates | undefined,
): MapGraphNode[] {
	return nodes.map((node) => {
		if (!isEligible(node)) return node;
		return {
			...node,
			metadata: { ...node.metadata, factCheck: factCheckFor(node, states) },
		};
	});
}
