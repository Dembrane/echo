import { t } from "@lingui/core/macro";
import { Badge, Box, Stack, Text } from "@mantine/core";
import { IconLock } from "@tabler/icons-react";

/**
 * Overlay shown in place of content on over-cap conversations.
 *
 * Audio playback remains accessible -- only the text content is gated.
 * Upgrading the workspace to a tier with overage billing immediately
 * unlocks all previously-locked conversations on the next page load
 * (live computation, no batch update).
 */
export function LockedTranscriptOverlay({
	compact = false,
	variant = "transcript",
}: {
	compact?: boolean;
	variant?: "transcript" | "summary";
}) {
	const label =
		variant === "summary"
			? t`You've reached your summary limit`
			: t`You've reached your transcript limit`;

	const description =
		variant === "summary"
			? t`Upgrade your workspace to view summaries for new conversations.`
			: t`Upgrade your workspace to view transcripts for new conversations.`;

	return (
		<Box
			style={{
				alignItems: "center",
				background:
					"repeating-linear-gradient(45deg, rgba(65,105,225,0.04) 0 8px, rgba(65,105,225,0.08) 8px 16px)",
				borderRadius: 8,
				display: "flex",
				justifyContent: "center",
				minHeight: compact ? 48 : 120,
			}}
		>
			<Stack gap={6} align="center" style={{ maxWidth: 320 }} p="md">
				<Badge
					color="blue"
					variant="light"
					leftSection={<IconLock size={12} />}
				>
					{label}
				</Badge>
				{!compact && (
					<Text size="sm" ta="center" c="dimmed">
						{description}
					</Text>
				)}
			</Stack>
		</Box>
	);
}
