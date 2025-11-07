import { Trans } from "@lingui/react/macro";
import { Button, Group, Text } from "@mantine/core";
import { IconPlus, IconReload } from "@tabler/icons-react";

type ConversationErrorViewProps = {
	conversationDeletedDuringRecording: boolean;
	newConversationLink: string | null;
};

export const ConversationErrorView = ({
	conversationDeletedDuringRecording,
	newConversationLink,
}: ConversationErrorViewProps) => {
	return (
		<div className="container mx-auto flex h-full max-w-2xl flex-col items-center justify-center">
			<div className="p-8 text-center">
				<Text size="xl" fw={500} c="red" mb="md">
					{conversationDeletedDuringRecording ? (
						<Trans id="participant.conversation.ended">
							Conversation Ended
						</Trans>
					) : (
						<Trans id="participant.conversation.error">
							Something went wrong
						</Trans>
					)}
				</Text>
				<Text size="md" c="dimmed" mb="lg">
					{conversationDeletedDuringRecording ? (
						<Trans id="participant.conversation.error.deleted">
							It looks like the conversation was deleted while you were
							recording. We've stopped the recording to prevent any issues. You
							can start a new one anytime.
						</Trans>
					) : (
						<Trans id="participant.conversation.error.loading">
							The conversation could not be loaded. Please try again or contact
							support.
						</Trans>
					)}
				</Text>
				<Group justify="center" gap="md">
					<Button
						variant="light"
						size="md"
						onClick={() => window.location.reload()}
						leftSection={<IconReload />}
					>
						<Trans id="participant.button.reload">Reload Page</Trans>
					</Button>
					{newConversationLink && (
						<Button
							leftSection={<IconPlus size={16} />}
							variant="filled"
							size="md"
							component="a"
							href={newConversationLink}
						>
							<Trans id="participant.button.start.new.conversation">
								Start New Conversation
							</Trans>
						</Button>
					)}
				</Group>
			</div>
		</div>
	);
};
