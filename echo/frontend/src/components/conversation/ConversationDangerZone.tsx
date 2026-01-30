import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Button, Group, Stack } from "@mantine/core";
import { IconDownload, IconTrash } from "@tabler/icons-react";
import { useParams } from "react-router";
import { MoveConversationButton } from "@/components/conversation/MoveConversationButton";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { analytics } from "@/lib/analytics";
import { AnalyticsEvents as events } from "@/lib/analyticsEvents";
import { getConversationContentLink } from "@/lib/api";
import { testId } from "@/lib/testUtils";
import { useDeleteConversationByIdMutation } from "./hooks";

export const ConversationDangerZone = ({
	conversation,
}: {
	conversation: Conversation;
}) => {
	const deleteConversationByIdMutation = useDeleteConversationByIdMutation();
	const navigate = useI18nNavigate();
	const { projectId } = useParams();

	const handleDelete = () => {
		if (
			window.confirm(
				t`Are you sure you want to delete this conversation? This action cannot be undone.`,
			)
		) {
			try {
				analytics.trackEvent(events.DELETE_CONVERSATION);
			} catch (error) {
				console.warn("Analytics tracking failed:", error);
			}
			deleteConversationByIdMutation.mutate(conversation.id);
			navigate(`/projects/${projectId}/overview`);
		}
	};

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

						<Button
							variant="outline"
							rightSection={<IconDownload size={16} />}
							component="a"
							target="_blank"
							href={getConversationContentLink(conversation.id)}
							onClick={handleDownloadAudio}
							{...testId("conversation-download-audio-button")}
						>
							<Group>
								<Trans>Download Audio</Trans>
							</Group>
						</Button>

						<Button
							onClick={handleDelete}
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
		</Stack>
	);
};
