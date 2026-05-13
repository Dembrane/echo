import { Trans } from "@lingui/react/macro";
import { Badge, Box, Stack, Text } from "@mantine/core";
import { IconLock } from "@tabler/icons-react";

/**
 * Overlay shown in place of transcript text on over-cap conversations.
 *
 * Audio playback remains accessible — only the transcript is gated.
 * Upgrading the workspace to a tier with overage billing immediately
 * unlocks all previously-locked conversations on the next page load
 * (live computation, no batch update).
 */
export function LockedTranscriptOverlay({ compact = false }: { compact?: boolean }) {
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
					<Trans>Transcript locked</Trans>
				</Badge>
				{!compact && (
					<Text size="sm" ta="center" c="dimmed">
						<Trans>
							Upgrade your workspace to view transcripts for
							conversations recorded after the cap.
						</Trans>
					</Text>
				)}
			</Stack>
		</Box>
	);
}
