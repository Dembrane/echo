import { t } from "@lingui/core/macro";
import { Alert } from "@mantine/core";
import { LockIcon } from "@phosphor-icons/react";

/**
 * Overlay shown in place of gated content (summary / transcript) on a locked
 * conversation.
 *
 * Conversations lock for one reason ("hours_cap"): the workspace passed its
 * free 1-hour recording cap, so conversations recorded past the cap lock until
 * upgrade. Audio playback stays accessible: only text content is gated.
 * Upgrading unlocks everything on the next load (live computation, no batch
 * update).
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
		<Alert color="gray" icon={<LockIcon size={20} />} title={label}>
			{compact ? null : description}
		</Alert>
	);
}
