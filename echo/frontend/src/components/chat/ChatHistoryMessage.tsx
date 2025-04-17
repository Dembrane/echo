import { Trans } from "@lingui/react/macro";
import { ChatMessage } from "@/components/chat/ChatMessage";
import { Box, Group, Text } from "@mantine/core";
import { Markdown } from "@/components/common/Markdown";
import React from "react";
import { formatDate } from "date-fns";
import { cn } from "@/lib/utils";
import { CopyRichTextIconButton } from "@/components/common/CopyRichTextIconButton";
import { ConversationLinks } from "@/components/conversation/ConversationLinks";
import SourcesSearched from "./SourcesSearched";

export const ChatHistoryMessage = ({
  message,
  section,
}: {
  message: ChatHistory[number];
  section?: React.ReactNode;
}) => {
  if (message.role === "system") {
    return null;
  }

  if (["user", "assistant"].includes(message.role)) {
    return (
      <ChatMessage
        key={message.id}
        role={message.role}
        section={
          <Group w="100%" gap="xs">
            <Text className={cn("italic")} size="xs" c="gray.7">
              {formatDate(
                // @ts-expect-error message is not typed
                new Date(message.createdAt ?? new Date()),
                "MMM d, h:mm a",
              )}
            </Text>

            <CopyRichTextIconButton markdown={message.content} />
          </Group>
        }
      >
        <Markdown className="prose-sm" content={message.content} />
      </ChatMessage>
    );
  }

  if (message.role === "dembrane") {
    if (message.content === "searched") {
      return (
        <Box className="flex justify-start">
          <SourcesSearched />
        </Box>
      );
    }
  }

  if (message._original.added_conversations?.length > 0) {
    return (
      <ChatMessage key={message.id} role="dembrane" section={section}>
        <Group gap="xs" align="baseline">
          <Text size="xs">
            <Trans>Context added:</Trans>
          </Text>
          <ConversationLinks
            conversations={message._original.added_conversations.map(
              (ac) => ac.conversation_id,
            )}
          />
        </Group>
      </ChatMessage>
    );
  }

  return null;
};
