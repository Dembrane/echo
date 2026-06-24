import { t } from "@lingui/core/macro";
import { Badge, Box, Stack, Text } from "@mantine/core";
import { IconLock } from "@tabler/icons-react";

/**
 * Overlay shown in place of gated content (summary / transcript) on a locked
 * conversation.
 *
 * Two lock reasons share this surface:
 *   - "hours_cap": the workspace passed its free recording cap; new
 *     conversations lock until upgrade.
 *   - "free_tier": the free plan includes one conversation; every other
 *     conversation is gated.
 *
 * Audio playback stays accessible: only text content is gated. Upgrading
 * unlocks everything on the next load (live computation, no batch update).
 */
export function LockedTranscriptOverlay({
	compact = false,
	variant = "transcript",
	reason = "hours_cap",
	context = "view",
}: {
	compact?: boolean;
	variant?: "transcript" | "summary";
	reason?: "hours_cap" | "free_tier" | null;
	context?: "view" | "selection";
}) {
	const isFreeTier = reason === "free_tier";

	const label = isFreeTier
		? context === "selection"
			? t`Upgrade to add this to the chat`
			: t`Upgrade to view this`
		: variant === "summary"
			? t`You've reached your summary limit`
			: t`You've reached your transcript limit`;

	const description = isFreeTier
		? context === "selection"
			? t`Your free plan includes one conversation. Upgrade to add more to the chat.`
			: t`Your free plan includes one conversation. Upgrade to open the rest.`
		: variant === "summary"
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
					color="primary"
					variant="light"
					leftSection={<IconLock size={12} />}
				>
					{label}
				</Badge>
				{!compact && (
					<Text size="sm" ta="center">
						{description}
					</Text>
				)}
			</Stack>
		</Box>
	);
}
