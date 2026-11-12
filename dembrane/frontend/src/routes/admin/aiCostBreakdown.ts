import { t } from "@lingui/core/macro";
import { formatMicroEur } from "@/hooks/useAiCosts";

// Costs show four decimals, cut off and never rounded up; the hover has all six.
const SHOWN_STEP = 100;

/** A cost in euros cut off at four decimals; a non-zero cost never shows as zero. */
export function formatAiCost(micro: number): string {
	if (micro > 0 && micro < SHOWN_STEP) return "< €0.0001";
	const cut = Math.floor(Math.max(0, micro) / SHOWN_STEP) * SHOWN_STEP;
	return formatMicroEur(cut, 4);
}

/** The stored micro-euros in full, for a hover title. */
export const exactAiCost = (micro: number): string =>
	formatMicroEur(Math.max(0, micro), 6);

/** Whole percents of the parts' total that add to 100 (largest remainder); zeros when nothing was spent. */
export function sharePercents(costs: number[]): number[] {
	const total = costs.reduce((s, c) => s + c, 0);
	if (total <= 0) return costs.map(() => 0);
	const exact = costs.map((c) => (c * 100) / total);
	const out = exact.map(Math.floor);
	const left = 100 - out.reduce((s, p) => s + p, 0);
	const order = exact
		.map((e, i) => [e - Math.floor(e), i] as const)
		.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
	for (const [, i] of order.slice(0, left)) out[i] = (out[i] ?? 0) + 1;
	return out;
}

/** A whole percent from sharePercents; a non-zero cost never shows as 0%. */
export const formatShare = (percent: number, cost: number): string =>
	cost > 0 && percent === 0 ? "<1%" : `${percent}%`;

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
	| "samples"
	| "other";

export interface OperationCost {
	operation: string;
	label: string;
	cost_micro_eur: number;
	calls: number;
	// Fraction of the account's total, for bars.
	share: number;
	// Whole percent; operations add to 100 across the account, groups too.
	percent: number;
}

export interface GroupCost {
	group: FeatureGroup;
	label: string;
	cost_micro_eur: number;
	calls: number;
	share: number;
	percent: number;
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
	const opPercents = sharePercents(features.map((f) => f.cost_micro_eur));
	const groups = new Map<FeatureGroup, GroupCost>();
	for (const [i, f] of features.entries()) {
		const group = f.group ?? "other";
		const g = groups.get(group) ?? {
			calls: 0,
			cost_micro_eur: 0,
			group,
			label: f.group_label ?? "Other",
			operations: [],
			percent: 0,
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
			percent: opPercents[i] ?? 0,
			share: share(f.cost_micro_eur),
		});
		groups.set(group, g);
	}
	const byCost = (
		a: { cost_micro_eur: number },
		b: { cost_micro_eur: number },
	) => b.cost_micro_eur - a.cost_micro_eur;
	const sorted = [...groups.values()].sort(byCost);
	const percents = sharePercents(sorted.map((g) => g.cost_micro_eur));
	return sorted.map((g, i) => ({
		...g,
		operations: g.operations.sort(byCost),
		percent: percents[i] ?? 0,
		share: share(g.cost_micro_eur),
	}));
}
