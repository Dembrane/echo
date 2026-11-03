import { useQuery } from "@tanstack/react-query";
import { API_BASE_URL } from "@/config";
import { ensureOk } from "@/lib/errors/read";

// A staff AI budget override; all empty means the free default applies.
export interface AiBudgetOverride {
	amount_micro_eur: number | null;
	unlimited: boolean;
	until: string | null;
}

export interface AiCostAccount {
	billing_account_id: string;
	name: string;
	tier: string | null;
	cost_micro_eur: number;
	budget_micro_eur: number | null;
	percent_used: number | null;
	unlimited: boolean;
	override_until: string | null;
	by_feature: { operation: string; cost_micro_eur: number }[];
	by_model: { model: string; cost_micro_eur: number }[];
}

export interface AiCostView {
	period_start: string;
	accounts: AiCostAccount[];
	unattributed_micro_eur: number;
	by_provider: { provider: string; cost_micro_eur: number }[];
}

export const AI_COSTS_QUERY_KEY = ["v2", "admin", "ai-costs"] as const;

// 0 is this month, 1 last month.
export const useAiCosts = (monthOffset: 0 | 1) =>
	useQuery({
		queryFn: async () => {
			const res = await ensureOk(
				await fetch(
					`${API_BASE_URL}/v2/admin/ai-costs?month_offset=${monthOffset}`,
					{ credentials: "include" },
				),
			);
			return (await res.json()) as AiCostView;
		},
		queryKey: [...AI_COSTS_QUERY_KEY, monthOffset],
		staleTime: 60_000,
	});

export const MICRO_PER_EUR = 1_000_000;
// EUR 1,000, the most a budget may be.
export const MAX_AI_BUDGET_MICRO_EUR = 1_000_000_000;

// Whole micro-euros from at most two decimals of euros.
export const eurosToMicro = (euros: number): number =>
	Math.round(euros * 100) * 10_000;

export const microToEuros = (micro: number): number =>
	Math.round(micro / 10_000) / 100;

export const formatMicroEur = (micro: number): string =>
	`€${microToEuros(micro).toLocaleString("en-US", {
		maximumFractionDigits: 2,
		minimumFractionDigits: 2,
	})}`;

// NumberInput hands back a string for values like "0.00".
export const numberFromInput = (draft: string | number): number =>
	typeof draft === "number"
		? draft
		: draft.trim() === ""
			? Number.NaN
			: Number(draft);
