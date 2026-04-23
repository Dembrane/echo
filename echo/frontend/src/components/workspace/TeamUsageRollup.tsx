import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Badge,
	Group,
	Paper,
	Stack,
	Text,
	Tooltip,
} from "@mantine/core";
import { IconRefresh } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { API_BASE_URL } from "@/config";

interface OrgUsage {
	cycle_start: string;
	cycle_end_exclusive: string;
	workspace_count: number;
	total_audio_hours: number;
	total_seat_count: number;
	total_guest_count: number;
	total_project_count: number;
	workspaces_at_cap: number;
	workspaces_approaching_cap: number;
	total_overage_forecast_eur: number | null;
}

async function fetchOrgUsage(
	orgId: string,
	refresh = false,
): Promise<OrgUsage | null> {
	const url = `${API_BASE_URL}/v2/orgs/${orgId}/usage${refresh ? "?refresh=true" : ""}`;
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
 * Team-level usage rollup strip (matrix §8 team scope).
 *
 * Rendered at the top of TeamRoute for team admins + billing + members.
 * Members see raw numbers. Admin/billing additionally see aggregate €
 * forecast across all workspaces they bill for (server-gated).
 *
 * Refresh button mirrors the per-workspace UsageCard pattern.
 */
export const TeamUsageRollup = ({ orgId }: { orgId: string }) => {
	const queryClient = useQueryClient();
	const [refreshing, setRefreshing] = useState(false);

	const { data, isLoading } = useQuery({
		queryKey: ["v2", "org-usage", orgId],
		queryFn: () => fetchOrgUsage(orgId),
		staleTime: 60_000,
	});

	const handleRefresh = async () => {
		setRefreshing(true);
		try {
			const fresh = await fetchOrgUsage(orgId, true);
			if (fresh) {
				queryClient.setQueryData(["v2", "org-usage", orgId], fresh);
			}
		} finally {
			setRefreshing(false);
		}
	};

	if (isLoading || !data) return null;

	const anyWarning =
		data.workspaces_at_cap > 0 || data.workspaces_approaching_cap > 0;

	return (
		<Paper p="md" withBorder radius="sm">
			<Stack gap={10}>
				<Group justify="space-between" wrap="nowrap">
					<Text size="xs" fw={500} tt="uppercase" c="dimmed" lts={0.5}>
						<Trans>Team usage · {formatCycleMonth(data.cycle_start)}</Trans>
					</Text>
					<Tooltip label={t`Refresh`}>
						<ActionIcon
							variant="subtle"
							color="gray"
							size="sm"
							loading={refreshing}
							onClick={handleRefresh}
							aria-label={t`Refresh team usage`}
						>
							<IconRefresh size={14} />
						</ActionIcon>
					</Tooltip>
				</Group>

				<Group gap="xl" wrap="wrap">
					<Stack gap={0}>
						<Text size="lg" fw={500}>
							{data.total_audio_hours.toFixed(1)}
							<Text span c="dimmed" size="sm">
								{" "}{t`hours`}
							</Text>
						</Text>
						<Text size="xs" c="dimmed">
							<Trans>across {data.workspace_count} workspaces</Trans>
						</Text>
					</Stack>

					<Stack gap={0}>
						<Text size="lg" fw={500}>{data.total_seat_count}</Text>
						<Text size="xs" c="dimmed">
							<Trans>seats</Trans>
						</Text>
					</Stack>

					<Stack gap={0}>
						<Text size="lg" fw={500}>{data.total_guest_count}</Text>
						<Text size="xs" c="dimmed">
							<Trans>guests</Trans>
						</Text>
					</Stack>

					<Stack gap={0}>
						<Text size="lg" fw={500}>{data.total_project_count}</Text>
						<Text size="xs" c="dimmed">
							<Trans>projects</Trans>
						</Text>
					</Stack>

					{data.total_overage_forecast_eur != null && (
						<Stack gap={0}>
							<Text size="lg" fw={500}>
								{formatEur(data.total_overage_forecast_eur)}
							</Text>
							<Text size="xs" c="dimmed">
								<Trans>overage forecast</Trans>
							</Text>
						</Stack>
					)}
				</Group>

				{anyWarning && (
					<Group gap="xs" mt={4}>
						{data.workspaces_at_cap > 0 && (
							<Badge size="sm" color="red" variant="light">
								<Trans>
									{data.workspaces_at_cap} at limit
								</Trans>
							</Badge>
						)}
						{data.workspaces_approaching_cap > 0 && (
							<Badge size="sm" color="yellow" variant="light">
								<Trans>
									{data.workspaces_approaching_cap} approaching limit
								</Trans>
							</Badge>
						)}
					</Group>
				)}
			</Stack>
		</Paper>
	);
};
