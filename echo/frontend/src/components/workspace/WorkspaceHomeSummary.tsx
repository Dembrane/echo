import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Badge,
	Group,
	Paper,
	Progress,
	Stack,
	Text,
	Tooltip,
} from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
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

async function fetchUsage(workspaceId: string): Promise<UsageLite | null> {
	const res = await fetch(
		`${API_BASE_URL}/v2/workspaces/${workspaceId}/usage`,
		{ credentials: "include" },
	);
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
	const { data, isLoading } = useQuery({
		queryKey: ["v2", "workspace-usage", workspaceId],
		queryFn: () => fetchUsage(workspaceId),
		staleTime: 60_000,
	});

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
					{data.pilot_hard_block_active && (
						<Badge size="xs" color="red" variant="light">
							<Trans>At limit</Trans>
						</Badge>
					)}
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
								color={
									data.pilot_hard_block_active
										? "red"
										: pct >= 80
											? "yellow"
											: "blue"
								}
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

					{data.overage_forecast_eur != null && data.overage_forecast_eur > 0 && (
						<Stack gap={2}>
							<Text size="sm" fw={500}>
								{formatEur(data.overage_forecast_eur)}
							</Text>
							<Text size="xs" c="dimmed">
								<Trans>overage forecast</Trans>
							</Text>
						</Stack>
					)}
				</Group>
			</Stack>
		</Paper>
	);
};
