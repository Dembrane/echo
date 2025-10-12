import { t } from "@lingui/core/macro";
import { ActionIcon, CopyButton, Tooltip } from "@mantine/core";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import { useCallback, useState } from "react";
import { useGetConversationTranscriptStringMutation } from "./hooks";

export const CopyConversationTranscriptActionIcon = (props: {
	conversationId: string;
}) => {
	const { conversationId } = props;

	const [transcript, setTranscript] = useState<string>("");

	const getConversationTranscriptStringMutation =
		useGetConversationTranscriptStringMutation();

	const preCopy = useCallback(async () => {
		getConversationTranscriptStringMutation.mutate(conversationId, {
			onSuccess: (data) => {
				setTranscript(data);
			},
		});
	}, [getConversationTranscriptStringMutation, conversationId]);

	return (
		<CopyButton value={transcript}>
			{({ copied, copy }) => (
				<Tooltip label={copied ? t`Copied` : t`Copy to clipboard`}>
					<ActionIcon
						variant="transparent"
						color={copied ? "blue" : "gray"}
						onClick={async () => {
							await preCopy();
							// hmm this is a hack to wait for the transcript to be set. not rly a best practice
							// i rly wanted to use the CopyButton haha
							await new Promise((resolve) => setTimeout(resolve, 500));
							copy();
						}}
						disabled={getConversationTranscriptStringMutation.isPending}
					>
						{copied ? <IconCheck size={20} /> : <IconCopy size={20} />}
					</ActionIcon>
				</Tooltip>
			)}
		</CopyButton>
	);
};
