import { t } from "@lingui/core/macro";
import { ActionIcon, Loader, Tooltip } from "@mantine/core";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import { toast } from "@/components/common/Toaster";
import { testId } from "@/lib/testUtils";
import useCopyToRichText from "@/hooks/useCopyToRichText";
import { useGetConversationTranscriptStringMutation } from "./hooks";

export const CopyConversationTranscriptActionIcon = (props: {
	conversationId: string;
	/** Icon size in px. Defaults to 20 (transcript header). */
	size?: number;
}) => {
	const { conversationId, size = 20 } = props;

	const { copy, copied } = useCopyToRichText();

	const getConversationTranscriptStringMutation =
		useGetConversationTranscriptStringMutation();

	const handleCopy = () => {
		if (isLoading) return;

		const promise =
			getConversationTranscriptStringMutation.mutateAsync(conversationId);

		toast.promise(promise, {
			error: t`Failed to copy transcript. Please try again.`,
			loading: t`Loading transcript...`,
			success: t`Transcript copied to clipboard`,
		});

		copy(promise);
	};

	const isLoading = getConversationTranscriptStringMutation.isPending;

	return (
		<Tooltip
			label={
				isLoading
					? t`Loading transcript...`
					: copied
						? t`Copied`
						: t`Copy to clipboard`
			}
		>
			<ActionIcon
				variant="transparent"
				color={copied ? "blue" : "gray"}
				onClick={(e) => {
					// Stop the click bubbling to an enclosing card anchor (the
					// conversations list rows are clickable links).
					e.stopPropagation();
					handleCopy();
				}}
				{...testId("transcript-copy-button")}
			>
				{isLoading ? (
					<Loader size={size} />
				) : copied ? (
					<IconCheck size={size} />
				) : (
					<IconCopy size={size} />
				)}
			</ActionIcon>
		</Tooltip>
	);
};
