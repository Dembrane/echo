import { t } from "@lingui/core/macro";
import { useQuery } from "@tanstack/react-query";
import { API_BASE_URL } from "@/config";
import type { TierPricing } from "@/lib/tiers";

export interface UsageGates {
	over_cap_active: boolean;
	uploads_locked: boolean;
	upgrade_cta_tier: string | null;
}

export interface WorkspaceUsageData {
	cycle_start: string;
	cycle_end_exclusive: string;
	tier: string;
	tier_tagline: string;
	audio_hours: number;
	audio_hours_included: number | null;
	seat_count: number;
	seat_count_included: number | null;
	guest_count: number;
	project_count: number;
	projects: {
		id: string;
		name: string;
		audio_hours: number;
		conversation_count: number;
	}[];
	pilot_hard_block_active: boolean;
	seat_invite_blocked?: boolean;
	usage_gates: UsageGates;
	overage_forecast_eur?: number | null;
	seat_overage_eur?: number | null;
	next_tier?: {
		tier: string;
		tagline: string;
		pricing: TierPricing | null;
		included_hours: number | null;
		included_seats: number | null;
	} | null;
}

async function fetchWorkspaceUsage(
	workspaceId: string,
	monthOffset = 0,
	refresh = false,
): Promise<WorkspaceUsageData> {
	const params = new URLSearchParams();
	if (monthOffset > 0) params.set("month_offset", String(monthOffset));
	if (refresh) params.set("refresh", "true");
	const qs = params.toString();
	const url = `${API_BASE_URL}/v2/workspaces/${workspaceId}/usage${qs ? `?${qs}` : ""}`;
	const res = await fetch(url, { credentials: "include" });
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(
			typeof data.detail === "string"
				? data.detail
				: t`Couldn't load usage (${res.status})`,
		);
	}
	return res.json();
}

export function useWorkspaceUsage(
	workspaceId: string | null | undefined,
	options?: { monthOffset?: number; enabled?: boolean },
) {
	const monthOffset = options?.monthOffset ?? 0;
	const enabled = options?.enabled !== false && !!workspaceId;

	const query = useQuery({
		enabled,
		queryFn: () => fetchWorkspaceUsage(workspaceId as string, monthOffset),
		queryKey: ["v2", "workspace-usage", workspaceId, monthOffset],
		refetchOnMount: "always" as const,
		refetchOnWindowFocus: "always" as const,
		staleTime: 60_000,
	});

	const usageGates: UsageGates = query.data?.usage_gates ?? {
		over_cap_active: false,
		upgrade_cta_tier: null,
		uploads_locked: false,
	};

	return {
		...query,
		usageGates,
	};
}
