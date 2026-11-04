import { t } from "@lingui/core/macro";

// Below this many micro-euros (EUR 0.0001) a cost is dust.
const DUST_MICRO = 100;

/** A cost in euros, never a non-zero cost as zero: 2 decimals from EUR 1, else up to 4. */
export function formatAiCost(micro: number): string {
	if (micro <= 0) return "€0.00";
	if (micro < DUST_MICRO) return "< €0.0001";
	const eur = micro / 1_000_000;
	// Up to two significant digits below a euro.
	const digits =
		eur >= 1 ? 2 : Math.min(4, Math.max(2, 1 - Math.floor(Math.log10(eur))));
	return `€${eur.toLocaleString("en-US", {
		maximumFractionDigits: digits,
		minimumFractionDigits: 2,
	})}`;
}

export const formatShare = (share: number): string =>
	share > 0 && share < 0.005 ? "<1%" : `${Math.round(share * 100)}%`;

export type FeatureGroup =
	| "chat"
	| "assistant"
	| "reports"
	| "map"
	| "analysis"
	| "canvas"
	| "portal"
	| "recording"
	| "voice"
	| "other";

export const featureGroupLabel = (group: FeatureGroup): string =>
	({
		analysis: t`Analysis`,
		assistant: t`Assistant`,
		canvas: t`Canvas`,
		chat: t`Chat`,
		map: t`Map`,
		other: t`Other`,
		portal: t`Portal`,
		recording: t`Recording`,
		reports: t`Reports`,
		voice: t`Voice input`,
	})[group];

type Rule = [RegExp, FeatureGroup, () => string];

// Route operations are "METHOD /route" (correlation middleware); jobs and workflows use their name.
// First match wins: specific operations before their group's catch-all.
const RULES: Rule[] = [
	[/^POST \/api\/chats\/:chat_id$/, "chat", () => t`Replies`],
	[/^\w+ \/api\/chats\/:chat_id\/suggestions$/, "chat", () => t`Suggestions`],
	[
		/^\w+ \/api\/(chats|v2\/bff\/(chats|chat-messages))(\/|$)/,
		"chat",
		() => t`Chat`,
	],

	[/^agentic\.turn(\.|$)/, "assistant", () => t`Assistant turns`],
	[/^POST \/api\/agentic\/runs$/, "assistant", () => t`New runs`],
	[
		/^POST \/api\/agentic\/runs\/:run_id\/messages$/,
		"assistant",
		() => t`Follow-up messages`,
	],
	[/^(agentic\.|\w+ \/api\/agentic\/)/, "assistant", () => t`Assistant`],

	[/^reports\.generate$/, "reports", () => t`Report generation`],
	[
		/^(reports\.|\w+ \/api\/(projects\/:project_id\/(reports|create-report)|v2\/bff\/reports))/,
		"reports",
		() => t`Reports`,
	],

	[/^map\.group$/, "map", () => t`Groups`],
	[/^map\.fact_check$/, "map", () => t`Fact checks`],
	[/^(map\.|\w+ \/api\/v2\/bff\/map(\/|$))/, "map", () => t`Map`],

	[/^popcorn\.tick\.translation$/, "analysis", () => t`Popcorn translation`],
	[/^popcorn\.tick\./, "analysis", () => t`Popcorn ticks`],
	[
		/^(popcorn\.|\w+ \/api\/v2\/(bff\/)?popcorn(\/|$))/,
		"analysis",
		() => t`Popcorn`,
	],
	[/^analysis\.run$/, "analysis", () => t`Analysis runs`],
	[
		/^(analysis\.|\w+ \/api\/v2\/bff\/analysis(\/|$))/,
		"analysis",
		() => t`Analysis`,
	],

	[/^canvas\.tick$/, "canvas", () => t`Canvas ticks`],
	[/^(canvas\.|\w+ \/api\/v2\/bff\/canvases(\/|$))/, "canvas", () => t`Canvas`],

	[/^(verify(\.|$)|\w+ \/api\/verify\/)/, "portal", () => t`Verify`],
	[
		/^POST \/api\/conversations\/:conversation_id\/get-reply$/,
		"portal",
		() => t`Explore`,
	],

	[/^conversations\.chunk$/, "recording", () => t`Transcription`],
	[/^conversations\.finish$/, "recording", () => t`Finishing`],
	[/^conversations\.finalize$/, "recording", () => t`Finalize and summary`],
	[/^conversations\.final-transcript$/, "recording", () => t`Final transcript`],
	[
		/^(conversations\.summarize|POST \/api\/conversations\/:conversation_id\/summarize)$/,
		"recording",
		() => t`Conversation summaries`,
	],
	[
		/^POST \/api\/conversations\/:conversation_id\/generate-title$/,
		"recording",
		() => t`Titles and tags`,
	],
	[
		/^POST \/api\/conversations\/:conversation_id\/retranscribe$/,
		"recording",
		() => t`Retranscribe`,
	],
	[
		/^(conversations\.|\w+ \/api\/(conversations|participant)\/)/,
		"recording",
		() => t`Recording`,
	],

	[/^POST \/api\/stateless\/transcribe$/, "voice", () => t`Voice input`],
];

/** The feature group and plain name of a recorded operation; unknown ones keep their raw key. */
export function classifyOperation(operation: string): {
	group: FeatureGroup;
	label: string;
} {
	for (const [pattern, group, label] of RULES)
		if (pattern.test(operation)) return { group, label: label() };
	return { group: "other", label: operation || t`Unlabelled` };
}

export interface OperationCost {
	operation: string;
	label: string;
	cost_micro_eur: number;
	calls: number;
	share: number;
}

export interface GroupCost {
	group: FeatureGroup;
	label: string;
	cost_micro_eur: number;
	calls: number;
	share: number;
	operations: OperationCost[];
}

/** An account's operations rolled into feature groups; shares of the account's total. */
export function groupFeatures(
	features: { operation: string; cost_micro_eur: number; calls?: number }[],
): GroupCost[] {
	const total = features.reduce((s, f) => s + f.cost_micro_eur, 0);
	const share = (cost: number) => (total > 0 ? cost / total : 0);
	const groups = new Map<FeatureGroup, GroupCost>();
	for (const f of features) {
		const { group, label } = classifyOperation(f.operation);
		const g = groups.get(group) ?? {
			calls: 0,
			cost_micro_eur: 0,
			group,
			label: featureGroupLabel(group),
			operations: [],
			share: 0,
		};
		const calls = f.calls ?? 0;
		g.cost_micro_eur += f.cost_micro_eur;
		g.calls += calls;
		g.operations.push({
			calls,
			cost_micro_eur: f.cost_micro_eur,
			label,
			operation: f.operation,
			share: share(f.cost_micro_eur),
		});
		groups.set(group, g);
	}
	const byCost = (
		a: { cost_micro_eur: number },
		b: { cost_micro_eur: number },
	) => b.cost_micro_eur - a.cost_micro_eur;
	return [...groups.values()]
		.map((g) => ({
			...g,
			operations: g.operations.sort(byCost),
			share: share(g.cost_micro_eur),
		}))
		.sort(byCost);
}
