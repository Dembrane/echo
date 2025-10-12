import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ActionIcon, Button, Modal, Stack, TextInput } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconDownload } from "@tabler/icons-react";
import { useState } from "react";
import { useGetConversationTranscriptStringMutation } from "./hooks";

export const DownloadConversationTranscriptModalActionIcon = ({
	conversationId,
}: {
	conversationId: string;
}) => {
	const [opened, { open, close }] = useDisclosure(false);

	return (
		<>
			<ActionIcon onClick={open} size="md" variant="subtle" color="gray">
				<IconDownload size={20} />
			</ActionIcon>
			<DownloadConversationTranscriptModal
				conversationId={conversationId}
				opened={opened}
				onClose={close}
			/>
		</>
	);
};

export const DownloadConversationTranscriptModal = (props: {
	opened: boolean;
	onClose: () => void;
	conversationId: string;
	defaultFilename?: string;
}) => {
	const { opened, onClose, conversationId, defaultFilename } = props;

	const getConversationTranscriptStringMutation =
		useGetConversationTranscriptStringMutation();

	const [filenameDownload, setFilenameDownload] = useState<string>(
		defaultFilename ?? "",
	);

	const handleDownloadTranscript = async () => {
		const transcript =
			await getConversationTranscriptStringMutation.mutateAsync(conversationId);
		const blob = new Blob([transcript], { type: "text/markdown" });
		const url = window.URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;

		if (transcript) {
			a.download =
				filenameDownload !== ""
					? filenameDownload
					: `Conversation-${conversationId}-transcript.md`;
		}

		a.click();

		window.URL.revokeObjectURL(url);
	};

	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={t`Download Transcript Options`}
		>
			<Stack>
				<TextInput
					disabled={getConversationTranscriptStringMutation.isPending}
					label={t`Custom Filename`}
					value={filenameDownload}
					onChange={(e) => setFilenameDownload(e.currentTarget.value)}
				/>
				<Button
					loading={getConversationTranscriptStringMutation.isPending}
					disabled={getConversationTranscriptStringMutation.isPending}
					onClick={async () => {
						await handleDownloadTranscript();
						onClose();
					}}
					rightSection={<IconDownload />}
				>
					<Trans>Download</Trans>
				</Button>
			</Stack>
		</Modal>
	);
};
