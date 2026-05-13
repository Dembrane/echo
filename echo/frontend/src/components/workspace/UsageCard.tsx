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
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "@/components/common/Toaster";
import { UsageFreshness } from "@/components/common/UsageFreshness";
import { type Tier, UpgradeModal } from "@/components/workspace/FeatureGate";
import { PeriodSelect } from "@/components/workspace/PeriodSelect";
import { API_BASE_URL } from "@/config";
import { useWorkspace } from "@/hooks/useWorkspace";
import { useWorkspaceUsage, type WorkspaceUsageData } from "@/hooks/useWorkspaceUsage";
import { isTier } from "@/lib/tiers";
import { formatDurationFromHours } from "@/lib/time";

async function fetchUsageFresh(
	workspaceId: string,
	monthOffset = 0,
): Promise<WorkspaceUsageData> {
	const params = new URLSearchParams();
	if (monthOffset > 0) params.set("month_offset", String(monthOffset));
	params.set("refresh", "true");
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

	const { data, isLoading, isError, refetch, dataUpdatedAt } = useWorkspaceUsage(
		workspaceId,
		{ monthOffset },
	);

	const handleRefresh = async () => {
		setRefreshing(true);
		try {
			const fresh = await fetchUsageFresh(workspaceId, monthOffset);
			queryClient.setQueryData(
				["v2", "workspace-usage", workspaceId, monthOffset],
				fresh,
			);
		} catch (err) {
			toast.error(
				err instanceof Error
					? err.message
					: t`Couldn't refresh usage. Try again.`,
			);
		} finally {
			setRefreshing(false);
		}
	};

	if (isLoading) return null;

	if (isError || !data) {
		return (
			<Paper p="md" radius="md" withBorder>
				<Stack gap="xs">
					<Text size="sm" c="red">
						<Trans>We couldn't load this workspace's usage.</Trans>
					</Text>
					<Group>
						<Button
							size="xs"
							variant="default"
							loading={refreshing}
							onClick={() => refetch()}
						>
							<Trans>Retry</Trans>
						</Button>
					</Group>
				</Stack>
			</Paper>
		);
	}

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

			{/* Seats (unified — guests share this pool) */}
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
				{data.guest_count > 0 && (
					<Text size="xs" c="dimmed">
						({data.seat_count - data.guest_count}{" "}
						<Plural
							value={data.seat_count - data.guest_count}
							one="member"
							other="members"
						/>{" "}
						+ {data.guest_count}{" "}
						<Plural
							value={data.guest_count}
							one="guest"
							other="guests"
						/>)
					</Text>
				)}
			</Stack>

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
