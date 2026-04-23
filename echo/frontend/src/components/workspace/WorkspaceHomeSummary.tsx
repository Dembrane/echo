import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Badge,
	Group,
	Paper,
	Progress,
	Stack,
	Text,
	Tooltip,
} from "@mantine/core";
import { IconRefresh } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { API_BASE_URL } from "@/config";
import { TierBadge } from "./TierBadge";

interface UsageLite {
	tier: string;
	tier_tagline: string;
	audio_hours: number;
	audio_hours_included: number | null;
	seat_count: number;
	seat_count_included: number | null;
	pilot_hard_block_active: boolean;
	overage_forecast_eur?: number | null;
	next_tier?: {
		tier: string;
		tagline: string;
		price_eur_monthly: number | null;
	} | null;
}

async function fetchUsage(
	workspaceId: string,
	refresh = false,
): Promise<UsageLite | null> {
	const url = `${API_BASE_URL}/v2/workspaces/${workspaceId}/usage${refresh ? "?refresh=true" : ""}`;
	const res = await fetch(url, { credentials: "include" });
	if (!res.ok) return null;
	return res.json();
}

function formatEur(value: number | null | undefined): string {
	if (value == null) return "—";
	if (value === 0) return "€0";
	return `€${Math.round(value)}`;
}

/**
 * Compact workspace-home summary tile. Sits above the project list to
 * give users a one-glance read on "is this workspace healthy?" without
 * leaving the home.
 *
 * Self-hides if the workspace has no tier cap (Guardian / legacy rows).
 * Role-aware: admins + billing see the €-forecast; members see raw
 * numbers only (server-gated).
 */
export const WorkspaceHomeSummary = ({
	workspaceId,
}: {
	workspaceId: string;
}) => {
	const queryClient = useQueryClient();
	const [refreshing, setRefreshing] = useState(false);
	const { data, isLoading } = useQuery({
		queryKey: ["v2", "workspace-usage", workspaceId, 0],
		queryFn: () => fetchUsage(workspaceId),
		staleTime: 60_000,
	});

	const handleRefresh = async () => {
		setRefreshing(true);
		try {
			const fresh = await fetchUsage(workspaceId, true);
			if (fresh) {
				queryClient.setQueryData(
					["v2", "workspace-usage", workspaceId, 0],
					fresh,
				);
			}
		} finally {
			setRefreshing(false);
		}
	};

	if (isLoading || !data) return null;

	const pct =
		data.audio_hours_included && data.audio_hours_included > 0
			? Math.min(100, (data.audio_hours / data.audio_hours_included) * 100)
			: null;

	return (
		<Paper withBorder p="md" radius="sm">
			<Stack gap={10}>
				<Group justify="space-between" wrap="nowrap">
					<TierBadge tier={data.tier} size="xs" showTagline />
					<Group gap={6} wrap="nowrap">
						{/* At-limit only on Pilot hard-block. Other tiers bill
						    overage and keep going; no alarm badge. */}
						{data.pilot_hard_block_active && (
							<Badge size="xs" color="red" variant="light">
								<Trans>Included hours used up</Trans>
							</Badge>
						)}
						<Tooltip label={t`Refresh usage`}>
							<ActionIcon
								size="sm"
								variant="subtle"
								color="gray"
								loading={refreshing}
								onClick={handleRefresh}
								aria-label={t`Refresh usage`}
							>
								<IconRefresh size={14} />
							</ActionIcon>
						</Tooltip>
					</Group>
				</Group>

				<Group gap="xl" wrap="wrap">
					<Stack gap={2} style={{ minWidth: 140 }}>
						<Group gap={6} wrap="nowrap">
							<Text size="sm" fw={500}>
								{data.audio_hours.toFixed(1)}
								{data.audio_hours_included != null && (
									<Text span c="dimmed" size="xs">
										{" / "}
										{data.audio_hours_included}
									</Text>
								)}
							</Text>
							<Tooltip
								label={t`Usage resets at the start of each calendar month.`}
							>
								<Text size="xs" c="dimmed" style={{ cursor: "help" }}>
									<Trans>hours this month</Trans>
								</Text>
							</Tooltip>
						</Group>
						{pct !== null && (
							<Progress
								value={pct}
								size="xs"
								color={data.pilot_hard_block_active ? "red" : "blue"}
							/>
						)}
					</Stack>

					<Stack gap={2}>
						<Text size="sm" fw={500}>
							{data.seat_count}
							{data.seat_count_included != null && (
								<Text span c="dimmed" size="xs">
									{" / "}
									{data.seat_count_included}
								</Text>
							)}
						</Text>
						<Text size="xs" c="dimmed">
							<Trans>seats</Trans>
						</Text>
					</Stack>

					{/* Overage forecast surface removed per demo feedback. */}
				</Group>
			</Stack>
		</Paper>
	);
};
