import { t } from "@lingui/core/macro";
import { Alert } from "@mantine/core";
import { LockIcon } from "@phosphor-icons/react";

/**
 * Overlay shown in place of gated content (summary / transcript) on a locked
 * conversation.
 *
 * Legacy: the free tier now stops recording at its monthly limit instead of
 * locking, so "hours_cap" no longer occurs. Audio playback stays accessible.
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
