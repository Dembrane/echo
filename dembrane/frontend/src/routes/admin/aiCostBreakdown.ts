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

// Display names for recorded providers; openai-compatible is our Scaleway deployment.
export function providerName(provider: string): string {
	if (provider === "vertex") return "Google Vertex";
	if (provider === "openai-compatible") return "Scaleway";
	if (provider === "fake") return t`Test`;
	if (provider === "unknown") return t`Unknown`;
	return provider;
}

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
	features: {
		operation: string;
		// Absent from an API older than this frontend.
		group?: FeatureGroup;
		group_label?: string;
		label?: string;
		cost_micro_eur: number;
		calls?: number;
	}[],
): GroupCost[] {
	const total = features.reduce((s, f) => s + f.cost_micro_eur, 0);
	const share = (cost: number) => (total > 0 ? cost / total : 0);
	const groups = new Map<FeatureGroup, GroupCost>();
	for (const f of features) {
		const group = f.group ?? "other";
		const g = groups.get(group) ?? {
			calls: 0,
			cost_micro_eur: 0,
			group,
			label: f.group_label ?? "Other",
			operations: [],
			share: 0,
		};
		const calls = f.calls ?? 0;
		g.cost_micro_eur += f.cost_micro_eur;
		g.calls += calls;
		g.operations.push({
			calls,
			cost_micro_eur: f.cost_micro_eur,
			label: f.label ?? (f.operation || "Unlabelled"),
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
