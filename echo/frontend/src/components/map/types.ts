export type ColorBy = "none" | "valence" | "factCheck";

export type MapKind = "argument" | "claim";

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
	id: string;
	label: string;
	embedding: number[];
	metadata: {
		kind: MapKind;
		valence: MapValence;
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
