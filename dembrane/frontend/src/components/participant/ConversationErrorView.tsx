import { Trans } from "@lingui/react/macro";
import { Button, Group, Stack, Text, Title } from "@mantine/core";
import { ArrowsClockwiseIcon, PlusIcon } from "@phosphor-icons/react";

type ConversationErrorViewProps = {
	conversationDeletedDuringRecording: boolean;
	newConversationLink: string | null;
};

export const ConversationErrorView = ({
	conversationDeletedDuringRecording,
	newConversationLink,
}: ConversationErrorViewProps) => {
	const reloadButton = (
		<Button
			variant={newConversationLink ? undefined : "filled"}
			size="md"
			onClick={() => window.location.reload()}
			leftSection={<ArrowsClockwiseIcon size={20} />}
		>
			<Trans id="participant.button.reload">Reload page</Trans>
		</Button>
	);

	return (
		<div className="container mx-auto flex h-full max-w-2xl flex-col justify-center">
			<Stack gap="md" p="xl">
				<Title order={2}>
					{conversationDeletedDuringRecording ? (
						<Trans id="participant.conversation.ended">
							Conversation ended
						</Trans>
					) : (
						<Trans id="participant.conversation.error">
							Something went wrong
						</Trans>
					)}
				</Title>
				<Text c="dimmed">
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
				<Group gap="sm">
					{newConversationLink && (
						<Button
							leftSection={<PlusIcon size={20} />}
							variant="filled"
							size="md"
							component="a"
							href={newConversationLink}
						>
							<Trans id="participant.button.start.new.conversation">
								Start new conversation
							</Trans>
						</Button>
					)}
					{reloadButton}
				</Group>
			</Stack>
		</div>
	);
};
