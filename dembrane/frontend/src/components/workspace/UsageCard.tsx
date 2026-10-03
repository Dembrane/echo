import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import {
	Badge,
	Group,
	Paper,
	Progress,
	Skeleton,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { UsageFreshness } from "@/components/common/UsageFreshness";
import { ErrorNotice } from "@/components/error/ErrorNotice";
import { notifyError } from "@/components/error/notifyError";
import { PeriodSelect } from "@/components/workspace/PeriodSelect";
import { tierName } from "@/components/workspace/TierBadge";
import { API_BASE_URL } from "@/config";
import {
	useWorkspaceUsage,
	type WorkspaceUsageData,
} from "@/hooks/useWorkspaceUsage";
import { ApiRequestError } from "@/lib/errors/read";
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
		throw new ApiRequestError(res.status, data);
	}
	return res.json();
}

// Shown when the query has no data and no error of its own. Module-level so
// ErrorNotice sees the same object on every render.
const USAGE_UNAVAILABLE = new Error("Workspace usage unavailable");

function formatCycleMonth(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

/**
 * Workspace usage card (matrix v1.1 §8).
 *
 * Role-aware rendering:
 *   - Member: hours / seats / projects, raw numbers.
 *   - Admin + Billing: adds the next-tier recommendation.
 *
 * Seat block: single bar over the unified pool (members + externals),
 * with three optional sub-rows beneath — Members, Externals, Pending
 * invites. Rows with count zero are hidden. The bar numerator
 * (data.seat_count) is the value enforcement code (assert_can_add_seat)
 * counts against — they always agree.
 */
export const UsageCard = ({ workspaceId }: { workspaceId: string }) => {
	const queryClient = useQueryClient();
	const [refreshing, setRefreshing] = useState(false);
	const [monthOffset, setMonthOffset] = useState(0);

	const { data, isLoading, isError, error, refetch, dataUpdatedAt } =
		useWorkspaceUsage(workspaceId, { monthOffset });

	const handleRefresh = async () => {
		setRefreshing(true);
		try {
			const fresh = await fetchUsageFresh(workspaceId, monthOffset);
			queryClient.setQueryData(
				["v2", "workspace-usage", workspaceId, monthOffset],
				fresh,
			);
		} catch (err) {
			void notifyError(err);
		} finally {
			setRefreshing(false);
		}
	};

	if (isLoading) {
		return (
			<Paper p="lg" withBorder>
				<Stack gap="md">
					<Skeleton height={20} width="40%" />
					<Skeleton height={32} />
					<Skeleton height={32} />
				</Stack>
			</Paper>
		);
	}

	if (isError || !data) {
		return (
			<ErrorNotice
				error={error ?? USAGE_UNAVAILABLE}
				title={t`We couldn't load this workspace's usage.`}
				onRetry={() => refetch()}
			/>
		);
	}

	const hoursPct =
		data.audio_hours_included && data.audio_hours_included > 0
			? Math.min(100, (data.audio_hours / data.audio_hours_included) * 100)
			: null;

	const seatsPct =
		data.seat_count_included && data.seat_count_included > 0
			? Math.min(100, (data.seat_count / data.seat_count_included) * 100)
			: null;

	const pilotExhausted = data.pilot_hard_block_active;

	const audioColor =
		pilotExhausted || (hoursPct != null && hoursPct >= 90)
			? "red"
			: hoursPct != null && hoursPct >= 60
				? "yellow"
				: "primary";

	const seatsColor =
		seatsPct != null && seatsPct >= 90
			? "red"
			: seatsPct != null && seatsPct >= 60
				? "yellow"
				: "primary";

	return (
		<Paper p="lg" withBorder radius="sm">
			<Stack gap="md">
				<Group justify="space-between" align="flex-start" wrap="nowrap">
					<Stack gap="xs" style={{ minWidth: 0 }}>
						<Title order={5}>
							<Trans>Usage · {formatCycleMonth(data.cycle_start)}</Trans>
						</Title>
						{data.tier_tagline && (
							<Text size="xs" c="dimmed">
								{tierName(data.tier)}
								{" · "}
								{data.tier_tagline}
							</Text>
						)}
					</Stack>
					<Group gap="sm" wrap="nowrap">
						{pilotExhausted && (
							<Badge size="sm" color="red" variant="light">
								<Trans>Included hours used up</Trans>
							</Badge>
						)}
						<PeriodSelect value={monthOffset} onChange={setMonthOffset} />
					</Group>
				</Group>

				{/* Audio hours */}
				<Stack gap="xs">
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
						<Progress value={hoursPct} size="xs" color={audioColor} />
					)}
				</Stack>

				{/* Seats — unified pool (members + externals). Breakdown
				    rows sit beneath the bar; zero-count rows hide so a
				    workspace with only members reads cleanly. */}
				<Stack gap="xs">
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
						<Progress value={seatsPct} size="xs" color={seatsColor} />
					)}
					{data.member_count > 0 && (
						<Group justify="space-between">
							<Text size="xs" c="dimmed">
								<Trans>Members</Trans>
							</Text>
							<Text size="xs" c="dimmed">
								{data.member_count}
							</Text>
						</Group>
					)}
					{data.external_count > 0 && (
						<Group justify="space-between">
							<Text size="xs" c="dimmed">
								<Trans>Externals</Trans>
							</Text>
							<Text size="xs" c="dimmed">
								{data.external_count}
							</Text>
						</Group>
					)}
					{data.observer_count > 0 && (
						<Group justify="space-between">
							<Text size="xs" c="dimmed">
								<Trans>Observers (free)</Trans>
							</Text>
							<Text size="xs" c="dimmed">
								{data.observer_count}
							</Text>
						</Group>
					)}
					{data.pending_count > 0 && (
						<Group justify="space-between">
							<Text size="xs" c="dimmed">
								<Trans>Pending invites</Trans>
							</Text>
							<Text size="xs" c="dimmed">
								{data.pending_count}
							</Text>
						</Group>
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
			</Stack>
		</Paper>
	);
};
