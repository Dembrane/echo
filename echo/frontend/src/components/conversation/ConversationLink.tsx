import { Trans } from "@lingui/react/macro";
import { Group, Anchor, List, Stack, Text } from "@mantine/core";
import { I18nLink } from "@/components/common/i18nLink";

interface ConversationLinkProps {
  conversation: Conversation;
  // TODO: remove this prop can read from conversation
  projectId: string;
}

const ConversationAnchor = ({ to, name }: { to: string; name: string }) => (
  <I18nLink to={to}>
    <Anchor size="sm" c="blue">
      {name}
    </Anchor>
  </I18nLink>
);

/**
 * input:
{
  projectId: string;
  linkingConversations: {
    sourceConversationId: {
      id: string;
      participantName: string;
    }
  }[]
  linkedConversations: {
    targetConversationId: {
      id: string;
      participantName: string;
    }
  }[]
}
*/

export const ConversationLink = ({
  conversation,
  projectId,
}: ConversationLinkProps) => {
  return (
    <>
      {conversation?.linking_conversations &&
        conversation?.linking_conversations.length > 0 && (
          <Group gap="sm">
            {conversation.linking_conversations[0]?.source_conversation_id
              ?.id ? (
              <>
                <Trans id="conversation.linking_conversations.description">
                  This conversation is a copy of
                </Trans>

                <ConversationAnchor
                  key={conversation?.linking_conversations?.[0]?.id}
                  to={`/projects/${projectId}/conversation/${conversation?.linking_conversations?.[0]?.source_conversation_id?.id}/overview`}
                  name={
                    conversation?.linking_conversations?.[0]
                      ?.source_conversation_id?.participant_name ?? ""
                  }
                />
              </>
            ) : (
              <Text c="gray" fs="italic">
                <Trans id="conversation.linking_conversations.deleted">
                  The source conversation was deleted
                </Trans>
              </Text>
            )}
          </Group>
        )}

      {conversation?.linked_conversations &&
        conversation?.linked_conversations.length > 0 && (
          <Stack gap="xs">
            <Trans id="conversation.linked_conversations.description">
              This conversation has the following copies:
            </Trans>
            <List>
              {conversation.linked_conversations.map(
                (conversationLink: ConversationLink) =>
                  conversationLink?.target_conversation_id?.id && (
                    <List.Item key={conversationLink?.id}>
                      <ConversationAnchor
                        to={`/projects/${projectId}/conversation/${conversationLink?.target_conversation_id?.id}/overview`}
                        name={
                          conversationLink?.target_conversation_id
                            ?.participant_name ?? ""
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
