import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import {
	Badge,
	Button,
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
import { PeriodSelect } from "@/components/workspace/PeriodSelect";
import { API_BASE_URL } from "@/config";
import {
	useWorkspaceUsage,
	type WorkspaceUsageData,
} from "@/hooks/useWorkspaceUsage";
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

/**
 * Workspace usage card (matrix v1.1 §8).
 *
 * Role-aware rendering:
 *   - Member: hours / seats / projects, raw numbers.
 *   - Admin + Billing: adds overage forecast and next-tier recommendation.
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

	const { data, isLoading, isError, refetch, dataUpdatedAt } =
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
						<Progress value={hoursPct} size="xs" color={audioColor} />
					)}
				</Stack>

				{/* Seats — unified pool (members + externals). Breakdown
				    rows sit beneath the bar; zero-count rows hide so a
				    workspace with only members reads cleanly. */}
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
