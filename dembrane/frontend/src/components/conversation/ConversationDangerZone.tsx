import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Button, Group, Stack, Tooltip } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconDownload, IconTrash } from "@tabler/icons-react";
import posthog from "posthog-js";
import { useParams } from "react-router";
import { ConfirmModal } from "@/components/common/ConfirmModal";
import { MoveConversationButton } from "@/components/conversation/MoveConversationButton";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { getConversationContentLink } from "@/lib/api";
import { testId } from "@/lib/testUtils";
import { useDeleteConversationByIdMutation } from "./hooks";

export const ConversationDangerZone = ({
	conversation,
	disableDownloadAudio = false,
	locked = false,
	onAfterDelete,
}: {
	conversation: Conversation;
	disableDownloadAudio?: boolean;
	locked?: boolean;
	/** Called after a delete is dispatched, e.g. to close a host modal. */
	onAfterDelete?: () => void;
}) => {
	const deleteConversationByIdMutation = useDeleteConversationByIdMutation();
	const navigate = useI18nNavigate();
	const { projectId, workspaceId } = useParams();
	const [confirmOpened, { open: openConfirm, close: closeConfirm }] =
		useDisclosure(false);

	const handleDownloadAudio = () => {
		posthog.capture("conversation_audio_downloaded");
	};

	return (
		<Stack gap="3rem">
			<Stack gap="1.5rem">
				<div className="flex">
					<Stack gap="1rem">
						<MoveConversationButton conversation={conversation} />

						<Tooltip
							label={
								locked
									? t`Upgrade your workspace to download audio for conversations recorded after the cap`
									: disableDownloadAudio
										? t`Audio download not available for anonymized conversations`
										: undefined
							}
							disabled={!disableDownloadAudio && !locked}
							maw={250}
							multiline
						>
							<Button
								variant="outline"
								rightSection={<IconDownload size={16} />}
								component="a"
								target="_blank"
								href={
									disableDownloadAudio || locked
										? undefined
										: getConversationContentLink(conversation.id)
								}
								onClick={
									disableDownloadAudio || locked
										? undefined
										: handleDownloadAudio
								}
								disabled={disableDownloadAudio || locked}
								{...testId("conversation-download-audio-button")}
							>
								<Group>
									<Trans>Download Audio</Trans>
								</Group>
							</Button>
						</Tooltip>

						<Button
							onClick={openConfirm}
							color="red"
							variant="outline"
							rightSection={<IconTrash size={16} />}
							{...testId("conversation-delete-button")}
						>
							<Trans>Delete Conversation</Trans>
						</Button>
					</Stack>
				</div>
			</Stack>

			<ConfirmModal
				opened={confirmOpened}
				onClose={closeConfirm}
				title={t`Delete conversation`}
				data-testid="conversation-delete-modal"
				message={t`Are you sure you want to delete this conversation? This action cannot be undone.`}
				confirmLabel={<Trans>Delete</Trans>}
				confirmColor="red"
				onConfirm={() => {
					posthog.capture("conversation_deleted");
					deleteConversationByIdMutation.mutate(conversation.id);
					navigate(`/w/${workspaceId}/projects/${projectId}/conversations`);
					closeConfirm();
					onAfterDelete?.();
				}}
			/>
		</Stack>
	);
};
