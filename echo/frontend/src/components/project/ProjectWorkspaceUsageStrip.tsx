import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Anchor, Group, Paper, Text, Tooltip } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { I18nLink } from "@/components/common/i18nLink";
import { API_BASE_URL } from "@/config";

interface UsagePayload {
	tier: string;
	audio_hours: number;
	audio_hours_included: number | null;
	pilot_hard_block_active: boolean;
}

async function fetchUsage(workspaceId: string): Promise<UsagePayload | null> {
	const res = await fetch(
		`${API_BASE_URL}/v2/workspaces/${workspaceId}/usage`,
		{ credentials: "include" },
	);
	if (!res.ok) return null;
	return res.json();
}

/**
 * Single-line workspace usage hint rendered inside a project page so the
 * person recording or chatting isn't blind to the parent cap. Intentionally
 * quiet — members see raw hours; Pilot workspaces that have hit the hard
 * block get a red warning since further recording will be refused.
 */
export const ProjectWorkspaceUsageStrip = ({
	workspaceId,
}: {
	workspaceId: string;
}) => {
	const { data } = useQuery({
		queryKey: ["v2", "workspace-usage", workspaceId],
		queryFn: () => fetchUsage(workspaceId),
		staleTime: 60_000,
	});

	if (!data) return null;

	const { audio_hours, audio_hours_included, pilot_hard_block_active } = data;
	const blocked = pilot_hard_block_active;
	const pct =
		audio_hours_included && audio_hours_included > 0
			? Math.min(100, (audio_hours / audio_hours_included) * 100)
			: null;
	const approaching = pct !== null && pct >= 80 && !blocked;

	const toneBg = blocked
		? "rgba(220, 38, 38, 0.06)"
		: approaching
			? "rgba(202, 138, 4, 0.06)"
			: "transparent";
	const toneBorder = blocked
		? "var(--mantine-color-red-3)"
		: approaching
			? "var(--mantine-color-yellow-4)"
			: "var(--mantine-color-default-border)";

	return (
		<Paper
			withBorder
			radius="sm"
			px="md"
			py={6}
			mx="xs"
			style={{ background: toneBg, borderColor: toneBorder }}
		>
			<Group justify="space-between" wrap="nowrap" gap="sm">
				<Group gap={8} wrap="nowrap">
					{blocked && (
						<IconAlertTriangle size={14} color="var(--mantine-color-red-6)" />
					)}
					<Text size="xs" c={blocked ? "red" : "dimmed"}>
						{audio_hours_included != null ? (
							<Trans>
								{audio_hours.toFixed(1)}h of {audio_hours_included}h used this
								month
							</Trans>
						) : (
							<Trans>
								{audio_hours.toFixed(1)}h recorded this month
							</Trans>
						)}
					</Text>
				</Group>
				<Tooltip
					label={t`Open workspace usage`}
					position="left"
					withArrow
					openDelay={400}
				>
					<Anchor
						component={I18nLink}
						to={`/w/${workspaceId}/settings/usage`}
						size="xs"
						c="dimmed"
					>
						<Trans>Details</Trans>
					</Anchor>
				</Tooltip>
			</Group>
		</Paper>
	);
};
