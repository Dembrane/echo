import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Button,
	Modal,
	Stack,
	TextInput,
	Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { DownloadSimpleIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { testId } from "@/lib/testUtils";
import { useGetConversationTranscriptStringMutation } from "./hooks";

export const DownloadConversationTranscriptModalActionIcon = ({
	conversationId,
}: {
	conversationId: string;
}) => {
	const [opened, { open, close }] = useDisclosure(false);

	return (
		<>
			<Tooltip label={t`Download transcript`}>
				<ActionIcon
					aria-label={t`Download transcript`}
					onClick={open}
					variant="subtle"
					color="gray"
					{...testId("transcript-download-button")}
				>
					<DownloadSimpleIcon size={20} />
				</ActionIcon>
			</Tooltip>
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
			title={t`Download transcript options`}
			{...testId("transcript-download-modal")}
		>
			<Stack>
				<TextInput
					disabled={getConversationTranscriptStringMutation.isPending}
					label={t`Custom filename`}
					value={filenameDownload}
					onChange={(e) => setFilenameDownload(e.currentTarget.value)}
					{...testId("transcript-download-filename-input")}
				/>
				<Button
					mt="xs"
					variant="filled"
					loading={getConversationTranscriptStringMutation.isPending}
					disabled={getConversationTranscriptStringMutation.isPending}
					onClick={async () => {
						await handleDownloadTranscript();
						onClose();
					}}
					leftSection={<DownloadSimpleIcon size={20} />}
					{...testId("transcript-download-confirm-button")}
				>
					<Trans>Download</Trans>
				</Button>
			</Stack>
		</Modal>
	);
};
