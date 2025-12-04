import { t } from "@lingui/core/macro";
import { ActionIcon, Loader, Tooltip } from "@mantine/core";
import { useClipboard } from "@mantine/hooks";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import { toast } from "@/components/common/Toaster";
import { useGetConversationTranscriptStringMutation } from "./hooks";

export const CopyConversationTranscriptActionIcon = (props: {
	conversationId: string;
}) => {
	const { conversationId } = props;

	const clipboard = useClipboard({ timeout: 2000 });

	const getConversationTranscriptStringMutation =
		useGetConversationTranscriptStringMutation();

	const handleCopy = async () => {
		if (isLoading) return;

		const promise =
			getConversationTranscriptStringMutation.mutateAsync(conversationId);

		toast.promise(promise, {
			error: t`Failed to copy transcript. Please try again.`,
			loading: t`Loading transcript...`,
			success: t`Transcript copied to clipboard`,
		});

		try {
			const transcript = await promise;
			clipboard.copy(transcript);
		} catch (error) {
			// Error is already handled by toast.promise
			console.error("Failed to copy transcript:", error);
		}
	};

	const isLoading = getConversationTranscriptStringMutation.isPending;

	return (
		<Tooltip
			label={
				isLoading
					? t`Loading transcript...`
					: clipboard.copied
						? t`Copied`
						: t`Copy to clipboard`
			}
		>
			<ActionIcon
				variant="transparent"
				color={clipboard.copied ? "blue" : "gray"}
				onClick={handleCopy}
			>
				{isLoading ? (
					<Loader size={20} />
				) : clipboard.copied ? (
					<IconCheck size={20} />
				) : (
					<IconCopy size={20} />
				)}
			</ActionIcon>
		</Tooltip>
	);
};
