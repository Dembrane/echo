import { deriveDisplayVerdict } from "../graph/nodeStyle";
import {
	type EmbeddingRejection,
	partitionByEmbedding,
} from "../graph/validate";
import type { FactCheckStates, MapEvidence, MapResult } from "../hooks";
import type { FactCheckState, MapGraphNode } from "../types";

export type EvidenceGroup = {
	conversationId: string;
	label: string;
	quotes: string[];
};

export type UnplacedArgument = {
	id: string;
	reason: EmbeddingRejection;
};

export type MapGraphData = {
	/** Every argument, placed or not. Fact-check state is not merged in. */
	allNodes: MapGraphNode[];
	/** Arguments with a usable embedding, in result order. */
	placedNodes: MapGraphNode[];
	/** Arguments the map cannot place, with the reason. */
	unplaced: UnplacedArgument[];
	/** Quotes per source conversation, by argument id. */
	evidenceById: Map<string, EvidenceGroup[]>;
};

const groupEvidence = (evidence: MapEvidence[]): EvidenceGroup[] => {
	const groups = new Map<string, EvidenceGroup>();
	for (const item of evidence ?? []) {
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
 * Shapes a ready result into map nodes and partitions them by embedding.
 * Fact-check state stays out of these nodes so a check never changes their
 * identity; see withFactChecks.
 */
export function buildMapGraph(result: MapResult): MapGraphData {
	const evidenceById = new Map<string, EvidenceGroup[]>();
	const allNodes = result.arguments.map((argument): MapGraphNode => {
		const evidence = argument.evidence ?? [];
		evidenceById.set(argument.id, groupEvidence(evidence));
		return {
			// An absent vector becomes empty, which the partition reports as missing.
			embedding: Array.isArray(argument.embedding) ? argument.embedding : [],
			id: argument.id,
			label: argument.statement,
			metadata: {
				conversationIds: Array.from(
					new Set(evidence.map((item) => item.conversation_id)),
				),
				createdAt: argument.created_at,
				kind: argument.kind,
				quotes: evidence.flatMap((item) => item.quotes ?? []),
				valence: argument.valence,
			},
		};
	});

	const partition = partitionByEmbedding(allNodes);
	const unplaced: UnplacedArgument[] = [...partition.invalid];
	const reported = new Set(unplaced.map((item) => item.id));
	const known = new Set(allNodes.map((node) => node.id));
	const placedNodes: MapGraphNode[] = [];
	const serverMissing = new Set(result.missing_embeddings ?? []);

	for (const node of partition.valid) {
		// The server lists arguments whose vector could not be loaded; never
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

	return { allNodes, evidenceById, placedNodes, unplaced };
}

/** The fact-check state a claim shows: server state, else idle. */
export const factCheckFor = (
	node: Pick<MapGraphNode, "id" | "metadata">,
	states: FactCheckStates | undefined,
): FactCheckState | undefined =>
	node.metadata.kind === "claim"
		? (states?.[node.id] ?? { status: "idle" })
		: undefined;

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
		if (node.metadata.kind !== "claim") continue;
		parts.push(
			`${node.id}:${deriveDisplayVerdict(factCheckFor(node, states))}`,
		);
	}
	return parts.join("|");
}

/**
 * Nodes with their claim's fact-check state in metadata. Embeddings, ids and
 * labels are shared with the input; arguments keep their node object.
 */
export function withFactChecks(
	nodes: ReadonlyArray<MapGraphNode>,
	states: FactCheckStates | undefined,
): MapGraphNode[] {
	return nodes.map((node) => {
		if (node.metadata.kind !== "claim") return node;
		return {
			...node,
			metadata: { ...node.metadata, factCheck: factCheckFor(node, states) },
		};
	});
}
