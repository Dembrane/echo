import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Button, Group, Stack, Tooltip } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconDownload, IconTrash } from "@tabler/icons-react";
import { useParams } from "react-router";
import { ConfirmModal } from "@/components/common/ConfirmModal";
import { MoveConversationButton } from "@/components/conversation/MoveConversationButton";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { analytics } from "@/lib/analytics";
import { AnalyticsEvents as events } from "@/lib/analyticsEvents";
import { getConversationContentLink } from "@/lib/api";
import { testId } from "@/lib/testUtils";
import { useDeleteConversationByIdMutation } from "./hooks";

export const ConversationDangerZone = ({
	conversation,
	disableDownloadAudio = false,
}: {
	conversation: Conversation;
	disableDownloadAudio?: boolean;
}) => {
	const deleteConversationByIdMutation = useDeleteConversationByIdMutation();
	const navigate = useI18nNavigate();
	const { projectId } = useParams();
	const [confirmOpened, { open: openConfirm, close: closeConfirm }] =
		useDisclosure(false);

	const handleDownloadAudio = () => {
		try {
			analytics.trackEvent(events.DOWNLOAD_AUDIO);
		} catch (error) {
			console.warn("Analytics tracking failed:", error);
		}
	};

	return (
		<Stack gap="3rem">
			<Stack gap="1.5rem">
				<div className="flex">
					<Stack gap="1rem">
						<MoveConversationButton conversation={conversation} />

						<Tooltip
							label={t`Audio download not available for anonymized conversations`}
							disabled={!disableDownloadAudio}
						>
							<Button
								variant="outline"
								rightSection={<IconDownload size={16} />}
								component="a"
								target="_blank"
								href={
									disableDownloadAudio
										? undefined
										: getConversationContentLink(conversation.id)
								}
								onClick={disableDownloadAudio ? undefined : handleDownloadAudio}
								disabled={disableDownloadAudio}
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
					try {
						analytics.trackEvent(events.DELETE_CONVERSATION);
					} catch (error) {
						console.warn("Analytics tracking failed:", error);
					}
					deleteConversationByIdMutation.mutate(conversation.id);
					navigate(`/projects/${projectId}/overview`);
					closeConfirm();
				}}
			/>
		</Stack>
	);
};
