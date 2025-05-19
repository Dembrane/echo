import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ChatMessage } from "@/components/chat/ChatMessage";
import {
  Badge,
  Box,
  Group,
  Text,
  ActionIcon,
  Tooltip,
  Collapse,
  Divider,
} from "@mantine/core";
import { Markdown } from "@/components/common/Markdown";
import React, { useEffect, useState } from "react";
import { formatDate } from "date-fns";
import { cn } from "@/lib/utils";
import { CopyRichTextIconButton } from "@/components/common/CopyRichTextIconButton";
import { ConversationLinks } from "@/components/conversation/ConversationLinks";
import SourcesSearched from "./SourcesSearched";
import { I18nLink } from "@/components/common/i18nLink";
import { useParams } from "react-router-dom";
import { IconInfoCircle } from "@tabler/icons-react";
import { Sources } from "./Sources";
import { ReferencesIconButton } from "../common/ReferencesIconButton";
import { References } from "./References";
import { ENABLE_CHAT_AUTO_SELECT } from "@/config";
import { extractMessageMetadata } from "./chatUtils";

export const ChatHistoryMessage = ({
  message,
  section,
  referenceIds,
  setReferenceIds,
}: {
  message: ChatHistory[number];
  section?: React.ReactNode;
  referenceIds?: string[];
  setReferenceIds?: (ids: string[]) => void;
}) => {
  const [metadata, setMetadata] = useState<any[]>([]);
  const { projectId } = useParams();

  useEffect(() => {
    const flattenedItems = extractMessageMetadata(message);
    setMetadata(flattenedItems);
  }, [message]);

  const isSelected = referenceIds?.includes(message.id) ?? false;

  if (message.role === "system") {
    return null;
  }

  if (["user", "assistant"].includes(message.role)) {
    return (
      <>
        {ENABLE_CHAT_AUTO_SELECT &&
          metadata?.length > 0 &&
          metadata?.some((item) => item.type === "reference") && (
            <div className="mb-3">
              <Sources metadata={metadata} projectId={projectId} />
            </div>
          )}
        {message?.metadata?.some(
          (metadata) => metadata.type === "reference",
        ) && (
          <div className="mb-3">
            <Sources metadata={message.metadata} projectId={projectId} />
          </div>
        )}

        {message.content && (
          <ChatMessage
            key={message.id}
            role={message.role}
            section={
              <Group w="100%" gap="lg">
                <Text className={cn("italic")} size="xs" c="gray.7">
                  {formatDate(
                    // @ts-expect-error message is not typed
                    new Date(message.createdAt ?? new Date()),
                    "MMM d, h:mm a",
                  )}
                </Text>
                <Group gap="sm">
                  <CopyRichTextIconButton markdown={message.content} />

                  {/* Info button for citations */}
                  {ENABLE_CHAT_AUTO_SELECT &&
                    metadata?.length > 0 &&
                    metadata?.some((item) => item.type === "citation") && (
                      <ReferencesIconButton
                        showCitations={isSelected}
                        setShowCitations={(show) => {
                          if (setReferenceIds) {
                            setReferenceIds(
                              show
                                ? [...(referenceIds || []), message.id]
                                : (referenceIds || []).filter(
                                    (id) => id !== message.id,
                                  ),
                            );
                          }
                        }}
                      />
                    )}
                  {message?.metadata?.length > 0 &&
                    message?.metadata?.some(
                      (item) => item.type === "citation",
                    ) && (
                      <ReferencesIconButton
                        showCitations={isSelected}
                        setShowCitations={(show) => {
                          if (setReferenceIds) {
                            setReferenceIds(
                              show
                                ? [...(referenceIds || []), message.id]
                                : (referenceIds || []).filter(
                                    (id) => id !== message.id,
                                  ),
                            );
                          }
                        }}
                      />
                    )}
                </Group>
              </Group>
            }
          >
            <Markdown className="prose-sm" content={message.content} />

            {/* Show citations inside the chat bubble when toggled */}
            <Collapse in={isSelected} transitionDuration={200}>
              <Divider className="my-7" />
              <div className="my-3">
                {ENABLE_CHAT_AUTO_SELECT &&
                  metadata.length > 0 &&
                  metadata.some((item) => item.type === "citation") && (
                    <References metadata={metadata} projectId={projectId} />
                  )}
                {message?.metadata?.length > 0 &&
                  message?.metadata?.some(
                    (item) => item.type === "citation",
                  ) && (
                    <References
                      metadata={message.metadata}
                      projectId={projectId}
                    />
                  )}
              </div>
            </Collapse>
          </ChatMessage>
        )}
      </>
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

  if (message?._original?.added_conversations?.length > 0) {
    const conversations = message?._original?.added_conversations
      .map((ac) => ac.conversation_id)
      .filter((conv) => conv != null);

    return conversations.length > 0 ? (
      <ChatMessage key={message.id} role="dembrane" section={section}>
        <Group gap="xs" align="baseline">
          <Text size="xs">
            <Trans>Context added:</Trans>
          </Text>
          <ConversationLinks
            conversations={conversations}
          />
        </Group>
      </ChatMessage>
    ) : null;
  }

  return null;
};
