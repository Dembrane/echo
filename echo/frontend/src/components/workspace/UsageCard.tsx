import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import {
	Badge,
	Button,
	Divider,
	Group,
	Paper,
	Progress,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { UsageFreshness } from "@/components/common/UsageFreshness";
import { type Tier, UpgradeModal } from "@/components/workspace/FeatureGate";
import { PeriodSelect } from "@/components/workspace/PeriodSelect";
import { API_BASE_URL } from "@/config";
import { useWorkspace } from "@/hooks/useWorkspace";
import { isTier } from "@/lib/tiers";
import { formatDurationFromHours } from "@/lib/time";

interface ProjectUsage {
	id: string;
	name: string;
	audio_hours: number;
	conversation_count: number;
}

interface UsageResponse {
	cycle_start: string;
	cycle_end_exclusive: string;
	tier: string;
	tier_tagline: string;
	audio_hours: number;
	audio_hours_included: number | null;
	seat_count: number;
	seat_count_included: number | null;
	guest_count: number;
	guest_cap: number | null;
	project_count: number;
	projects: ProjectUsage[];
	pilot_hard_block_active: boolean;
	member_invite_blocked?: boolean;
	guest_invite_blocked?: boolean;
	overage_forecast_eur?: number | null;
	seat_overage_eur?: number | null;
	next_tier?: {
		tier: string;
		tagline: string;
		price_eur_monthly: number | null;
		price_note: string;
		included_hours: number | null;
		included_seats: number | null;
	} | null;
}

async function fetchUsage(
	workspaceId: string,
	monthOffset = 0,
	refresh = false,
): Promise<UsageResponse | null> {
	const params = new URLSearchParams();
	if (monthOffset > 0) params.set("month_offset", String(monthOffset));
	if (refresh) params.set("refresh", "true");
	const qs = params.toString();
	const url = `${API_BASE_URL}/v2/workspaces/${workspaceId}/usage${qs ? `?${qs}` : ""}`;
	const res = await fetch(url, { credentials: "include" });
	if (!res.ok) return null;
	return res.json();
}

function formatCycleMonth(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function formatEur(value: number | null | undefined): string {
	if (value == null) return "—";
	if (value === 0) return "€0";
	return `€${Math.round(value)}`;
}

/**
 * Workspace usage card (matrix v1.1 §8).
 *
 * Role-aware rendering:
 *   - Member: hours / seats / guests / projects, raw numbers.
 *   - Admin + Billing: adds overage forecast and next-tier recommendation.
 *
 * Source fields come pre-differentiated from the backend (next_tier +
 * overage_forecast_eur are null for members — `workspace:view_invoices`
 * gates them server-side).
 */
export const UsageCard = ({ workspaceId }: { workspaceId: string }) => {
	const queryClient = useQueryClient();
	const { workspace } = useWorkspace();
	const [refreshing, setRefreshing] = useState(false);
	const [upgradeOpen, setUpgradeOpen] = useState(false);
	const [monthOffset, setMonthOffset] = useState(0);

	const { data, isLoading, dataUpdatedAt } = useQuery({
		queryFn: () => fetchUsage(workspaceId, monthOffset),
		queryKey: ["v2", "workspace-usage", workspaceId, monthOffset],
		// Always refetch when the billing tab mounts, even if the cached
		// payload is still within staleTime. Users expect fresh seat/guest
		// counts every time they land on this surface — without this, a
		// member added in another tab or by another admin doesn't show
		// until a manual click on the refresh icon. The server-side cache
		// (30-min Redis TTL) still does its job; we're only overriding
		// React Query's "fresh = skip" optimization.
		refetchOnMount: "always",
		refetchOnWindowFocus: "always",
		staleTime: 60_000,
	});

	const handleRefresh = async () => {
		// Manual force-recompute. Bypasses the server's 30-min cache via
		// ?refresh=true, then writes the fresh payload into the React
		// Query cache so the card updates without a second fetch.
		setRefreshing(true);
		try {
			const fresh = await fetchUsage(workspaceId, monthOffset, true);
			if (fresh) {
				queryClient.setQueryData(
					["v2", "workspace-usage", workspaceId, monthOffset],
					fresh,
				);
			}
		} finally {
			setRefreshing(false);
		}
	};

	if (isLoading || !data) return null;

	// Matrix §11: admin + billing + owner can request upgrades. Role comes
	// from the workspace context (the selector response includes role).
	const role = workspace?.role;
	const canRequestUpgrade =
		role === "admin" || role === "owner" || role === "billing";

	const hoursPct =
		data.audio_hours_included && data.audio_hours_included > 0
			? Math.min(100, (data.audio_hours / data.audio_hours_included) * 100)
			: null;

	const seatsPct =
		data.seat_count_included && data.seat_count_included > 0
			? Math.min(100, (data.seat_count / data.seat_count_included) * 100)
			: null;

	const pilotExhausted = data.pilot_hard_block_active;

	const nextTier = data.next_tier;
	const currentTierName = isTier(data.tier) ? (data.tier as Tier) : "pioneer";
	const nextTierName =
		nextTier && isTier(nextTier.tier) ? (nextTier.tier as Tier) : null;

	return (
		<Paper p="lg" withBorder radius="sm">
			{nextTierName && (
				<UpgradeModal
					opened={upgradeOpen}
					onClose={() => setUpgradeOpen(false)}
					currentTier={currentTierName}
					requiredTier={nextTierName}
					featureName={t`Upgrade to ${nextTier?.tier ?? ""}`}
					benefit={nextTier?.tagline ?? ""}
					canRequestUpgrade={canRequestUpgrade}
					workspaceId={workspaceId}
				/>
			)}
			<Stack gap={16}>
				<Group justify="space-between" align="flex-start" wrap="nowrap">
					<Stack gap={2} style={{ minWidth: 0 }}>
						<Title order={5} fw={400}>
							<Trans>Usage · {formatCycleMonth(data.cycle_start)}</Trans>
						</Title>
						{data.tier_tagline && (
							<Text size="xs" c="dimmed">
								<span style={{ textTransform: "capitalize" }}>{data.tier}</span>
								{" · "}
								{data.tier_tagline}
							</Text>
						)}
					</Stack>
					<Group gap={8} wrap="nowrap">
						{pilotExhausted && (
							<Badge size="sm" color="red" variant="light">
								<Trans>Included hours used up</Trans>
							</Badge>
						)}
						<PeriodSelect value={monthOffset} onChange={setMonthOffset} />
					</Group>
				</Group>

				{/* Audio hours */}
				<Stack gap={6}>
					<Group justify="space-between">
						<Text size="sm" c="dimmed">
							<Trans>Audio</Trans>
						</Text>
						<Text size="sm">
							{formatDurationFromHours(data.audio_hours)}
							{data.audio_hours_included != null && (
								<Text span c="dimmed" size="sm">
									{" / "}
									{data.audio_hours_included}h
								</Text>
							)}
						</Text>
					</Group>
					{hoursPct !== null && (
						<Progress
							value={hoursPct}
							size="xs"
							color={pilotExhausted ? "red" : "blue"}
						/>
					)}
				</Stack>

				{/* Seats */}
				<Stack gap={6}>
					<Group justify="space-between">
						<Text size="sm" c="dimmed">
							<Trans>Seats</Trans>
						</Text>
						<Text size="sm">
							{data.seat_count}
							{data.seat_count_included != null && (
								<Text span c="dimmed" size="sm">
									{" / "}
									{data.seat_count_included}
								</Text>
							)}
						</Text>
					</Group>
					{seatsPct !== null && (
						<Progress value={seatsPct} size="xs" color="blue" />
					)}
				</Stack>

				{/* Guests + projects (compact row) */}
				<Group justify="space-between">
					<Text size="sm" c="dimmed">
						<Trans>Guests</Trans>
					</Text>
					<Text size="sm">
						{data.guest_count}
						{data.guest_cap != null && (
							<Text span c="dimmed" size="sm">
								{" / "}
								{data.guest_cap}
							</Text>
						)}
					</Text>
				</Group>
				<Group justify="space-between">
					<Text size="sm" c="dimmed">
						<Trans>Projects</Trans>
					</Text>
					{/* Uncapped metric — audit 2026-04-23 §4 Billing: render
					    as an info line, not quota. "1 project" / "2 projects",
					    no denominator, no progress bar. */}
					<Text size="sm">
						<Plural
							value={data.project_count}
							one="# project"
							other="# projects"
						/>
					</Text>
				</Group>

				<UsageFreshness
					dataUpdatedAt={dataUpdatedAt}
					refreshing={refreshing}
					onRefresh={handleRefresh}
				/>

				{/* Next-tier hint (admin / billing only). Overage forecast
				    removed per demo feedback; we'll put it back with a
				    clearer "what happens at overage" explanation later. */}
				{data.next_tier && (
					<>
						<Divider />
						<Group justify="space-between" align="center" wrap="nowrap">
							<Text size="xs" c="dimmed">
								<Trans>
									Next tier: {data.next_tier.tier} · {data.next_tier.tagline}
								</Trans>
								{data.next_tier.price_eur_monthly != null && (
									<>
										{" · "}
										{formatEur(data.next_tier.price_eur_monthly)}
										/mo
									</>
								)}
							</Text>
							{canRequestUpgrade && (
								<Button onClick={() => setUpgradeOpen(true)}>
									<Trans>Request upgrade</Trans>
								</Button>
							)}
						</Group>
					</>
				)}
			</Stack>
		</Paper>
	);
};
