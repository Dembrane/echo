import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Button, Stack, Tooltip } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { DownloadSimpleIcon, TrashIcon } from "@phosphor-icons/react";
import posthog from "posthog-js";
import { useParams } from "react-router";
import { ConfirmModal } from "@/components/common/ConfirmModal";
import { MoveConversationButton } from "@/components/conversation/MoveConversationButton";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useWorkspace } from "@/hooks/useWorkspace";
import { getConversationContentLink } from "@/lib/api";
import { isOutsiderRole } from "@/lib/roles";
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
	const { workspace } = useWorkspace();
	// conversation:delete is held by members and admins, not outsiders.
	const canDelete = !!workspace && !isOutsiderRole(workspace.role);
	const [confirmOpened, { open: openConfirm, close: closeConfirm }] =
		useDisclosure(false);

	const handleDownloadAudio = () => {
		posthog.capture("conversation_audio_downloaded");
	};

	return (
		<Stack gap="xl">
			<Stack gap="lg">
				<div className="flex">
					<Stack gap="md">
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
								leftSection={<DownloadSimpleIcon size={20} />}
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
								<Trans>Download audio</Trans>
							</Button>
						</Tooltip>

						{canDelete && (
							<Button
								onClick={openConfirm}
								color="red"
								leftSection={<TrashIcon size={20} />}
								{...testId("conversation-delete-button")}
							>
								<Trans>Delete conversation</Trans>
							</Button>
						)}
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
					// Leave only once deleted; a refusal keeps the user here (the hook toasts).
					deleteConversationByIdMutation.mutate(conversation.id, {
						onSuccess: () =>
							navigate(`/w/${workspaceId}/projects/${projectId}/conversations`),
					});
					closeConfirm();
					onAfterDelete?.();
				}}
			/>
		</Stack>
	);
};
