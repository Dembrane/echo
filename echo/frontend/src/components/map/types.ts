export type ColorBy = "none" | "type" | "valence" | "factCheck";

/** Shared contract with the renderers: every node on the Map is one typed object. */
export type ObjectType =
	| "argument"
	| "deduplicated_argument"
	| "popcorn"
	| "tension"
	| "stakeholder";

export type MapRelation = {
	id: string;
	type: string;
	source: string;
	target: string;
	basis: "extracted" | "inferred" | "authored";
};

/** @deprecated use `metadata.epistemicKind`; kept while the renderers migrate. */
export type MapKind = "argument" | "claim";

export type MapEpistemicKind = "argument" | "claim";

export type MapValence = "positive" | "negative" | "neutral";

export type FactCheckVerdict = "true" | "false" | "contested" | "unknown";

export type FactCheckSource = { url: string; title: string };

export type FactCheckState =
	| { status: "idle" }
	| { status: "processing"; startedAt: string }
	| {
			status: "done";
			verdict: FactCheckVerdict;
			justification: string;
			sources: FactCheckSource[];
			checkedAt: string;
	  }
	| { status: "error"; message: string; at: string };

export type MapGraphNode = {
	/** The revision id of the object. */
	id: string;
	label: string;
	embedding: number[];
	metadata: {
		objectType: ObjectType;
		objectId: string;
		revisionId: string;
		/** 1 for most types, 1.5 for tension; from the type style definition. */
		sizeScale: number;
		/** Replaces `kind` for fact-check eligibility. */
		epistemicKind?: MapEpistemicKind;
		/** Missing means "Not assessed", which is not the same as neutral. */
		valence?: MapValence;
		/** @deprecated alias of `epistemicKind ?? "argument"`; kept while the renderers migrate. */
		kind: MapKind;
		/**
		 * Fact-check capability from the payload. When absent, claims of the
		 * argument types are eligible.
		 */
		factCheckEligible?: boolean;
		factCheck?: FactCheckState;
		quotes: string[];
		conversationIds: string[];
		createdAt: string | null;
	};
};

export type Edge = { source: string; target: string; distance: number };

export type HighlightSource =
	| "mst-hover"
	| "local-hover"
	| "history"
	| "project"
	| "system"
	| "unknown";
