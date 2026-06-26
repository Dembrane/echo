import { Trans } from "@lingui/react/macro";
import { Anchor, Group, List, Stack } from "@mantine/core";
import { useParams } from "react-router";
import { I18nLink } from "@/components/common/i18nLink";

interface ConversationLinkProps {
	conversation: Conversation;
	projectId: string;
}

const ConversationAnchor = ({ to, name }: { to: string; name: string }) => (
	<I18nLink to={to}>
		<Anchor size="sm" c="blue">
			{name}
		</Anchor>
	</I18nLink>
);

export const ConversationLink = ({
	conversation,
	projectId,
}: ConversationLinkProps) => {
	const { workspaceId } = useParams();
	const linkingConversation = conversation
		.linking_conversations[0] as unknown as ConversationLink;
	const linkedConversations =
		conversation.linked_conversations as unknown as ConversationLink[];

	if (!linkingConversation || !linkedConversations) {
		return null;
	}

	return (
		<>
			<Group gap="sm">
				{(linkingConversation?.source_conversation_id as Conversation)?.id && (
					<>
						<Trans id="conversation.linking_conversations.description">
							This conversation is a copy of
						</Trans>

						<ConversationAnchor
							key={linkingConversation?.id}
							to={`/w/${workspaceId}/projects/${projectId}/conversations/${(linkingConversation?.source_conversation_id as Conversation)?.id}`}
							name={
								(linkingConversation?.source_conversation_id as Conversation)
									?.participant_name ?? ""
							}
						/>
					</>
				)}
			</Group>

			{linkedConversations && linkedConversations.length > 0 && (
				<Stack gap="xs">
					<Trans id="conversation.linked_conversations.description">
						This conversation has the following copies:
					</Trans>
					<List>
						{linkedConversations.map(
							(conversationLink: ConversationLink) =>
								(conversationLink?.target_conversation_id as Conversation)
									?.id && (
									<List.Item key={conversationLink?.id}>
										<ConversationAnchor
											to={`/w/${workspaceId}/projects/${projectId}/conversations/${(conversationLink?.target_conversation_id as Conversation)?.id}`}
											name={
												(
													conversationLink?.target_conversation_id as Conversation
												)?.participant_name ?? ""
											}
										/>
									</List.Item>
								),
						)}
					</List>
				</Stack>
			)}
		</>
	);
};
