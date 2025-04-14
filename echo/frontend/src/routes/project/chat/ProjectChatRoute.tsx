import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ChatContextProgress } from "@/components/chat/ChatContextProgress";
import { ChatMessage } from "@/components/chat/ChatMessage";
import {
  useAddChatMessageMutation,
  useChatHistory,
  useLockConversationsMutation,
  useChat as useProjectChat,
  useProjectChatContext,
} from "@/lib/query";
import {
  Alert,
  Box,
  Button,
  Divider,
  Group,
  LoadingOverlay,
  Stack,
  Text,
  Textarea,
  Title,
  Progress,
} from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import {
  IconAlertCircle,
  IconRefresh,
  IconSend,
  IconSquare,
  IconCheck,
} from "@tabler/icons-react";
import { useParams } from "react-router-dom";
import { useChat } from "ai/react";
import { API_BASE_URL } from "@/config";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLanguage } from "@/hooks/useLanguage";
import { CopyRichTextIconButton } from "@/components/common/CopyRichTextIconButton";
import { ConversationLinks } from "@/components/conversation/ConversationLinks";
import { ChatHistoryMessage } from "@/components/chat/ChatHistoryMessage";
import { ChatTemplatesMenu } from "@/components/chat/ChatTemplatesMenu";
import { formatMessage } from "@/components/chat/chatUtils";

const useDembraneChat = ({ chatId }: { chatId: string }) => {
  const chatHistoryQuery = useChatHistory(chatId);
  const chatContextQuery = useProjectChatContext(chatId);

  const [showProgress, setShowProgress] = useState(false);
  const [progressValue, setProgressValue] = useState(0);
  const [showSuccessMessage, setShowSuccessMessage] = useState(false);

  const addChatMessageMutation = useAddChatMessageMutation();
  const lockConversationsMutation = useLockConversationsMutation();

  const lastInput = useRef("");
  const lastMessageRef = useRef<HTMLDivElement>(null);

  const contextToBeAdded = useMemo(() => {
    if (!chatContextQuery.data) {
      return null;
    }
    return {
      conversations: chatContextQuery.data.conversations.filter(
        (c) => !c.locked,
      ),
      auto_select_bool: chatContextQuery.data.auto_select_bool ?? false,
    };
  }, [chatContextQuery.data, chatHistoryQuery.data]);

  const { iso639_1 } = useLanguage();

  const {
    setMessages,
    messages,
    input,
    setInput,
    handleInputChange,
    handleSubmit,
    isLoading,
    error,
    stop,
    reload,
  } = useChat({
    api: `${API_BASE_URL}/chats/${chatId}?language=${iso639_1 ?? "en"}`,
    credentials: "include",
    // @ts-expect-error chatHistoryQuery.data is not typed
    initialMessages: chatHistoryQuery.data ?? [],
    streamProtocol: "data",
    onError: (error) => {
      if (lastInput.current) {
        setInput(lastInput.current);
      }
      console.log("onError", error);
    },
    onFinish: async (message) => {
      // this uses the response stream from the backend and makes a chat message IN THE FRONTEND
      // do this for now because - i dont want to do the stream text processing again in the backend
      // if someone navigates away before onFinish is completed, the message will be lost
      addChatMessageMutation.mutate({
        project_chat_id: {
          id: chatId,
        } as ProjectChat,
        text: message.content,
        message_from: "assistant",
        date_created: new Date().toISOString(),
      });
      // scroll to the last message
      lastMessageRef.current?.scrollIntoView({ behavior: "smooth" });
    },
  });

  const customHandleStop = () => {
    stop();

    const incompleteMessage = messages[messages.length - 1];

    const body = {
      project_chat_id: {
        id: chatId,
      } as ProjectChat,
      text: incompleteMessage.content,
      message_from: "assistant",
      date_created: new Date(
        incompleteMessage.createdAt ?? new Date(),
      ).toISOString(),
    };

    // publish the incomplete result to the backend
    addChatMessageMutation.mutate(body);
  };

  const customHandleSubmit = async () => {
    lastInput.current = input;

    try {
      if (contextToBeAdded?.auto_select_bool) {
        setShowProgress(true);
        setProgressValue(0);
        setShowSuccessMessage(false);
        const interval = setInterval(() => {
          setProgressValue((prev: any) => {
            if (prev >= 100) {
              clearInterval(interval);
              return 100;
            }
            return prev + 10;
          });
        }, 200);
      }

      // Lock conversations first
      await lockConversationsMutation.mutateAsync({ chatId });

      // Wait for queries to settle
      await Promise.all([
        chatHistoryQuery.refetch(),
        chatContextQuery.refetch(),
      ]);

      // Submit the chat
      handleSubmit();

      if (contextToBeAdded?.auto_select_bool) {
        setTimeout(() => {
          setShowProgress(false);
          setProgressValue(0);
          setShowSuccessMessage(true);
        }, 1000);
      }
    } catch (error) {
      console.error("Error in customHandleSubmit:", error);
      setShowProgress(false);
      setProgressValue(0);
      setShowSuccessMessage(false);
    }
  };

  // reconcile for "dembrane" messages
  useEffect(() => {
    if (isLoading || chatHistoryQuery.isLoading || !chatHistoryQuery.data) {
      return;
    }

    if (
      chatHistoryQuery.data &&
      chatHistoryQuery.data.length > (messages?.length ?? 0)
    ) {
      // @ts-expect-error chatHistoryQuery.data is not typed
      setMessages(chatHistoryQuery.data ?? messages);
    }
  }, [
    chatHistoryQuery.data,
    isLoading,
    chatHistoryQuery.isLoading,
    messages,
    setMessages,
  ]);

  return {
    isInitializing: chatHistoryQuery.isLoading,
    isLoading,
    messages,
    contextToBeAdded,
    input,
    error,
    lastInputRef: lastInput,
    lastMessageRef,
    reload,
    setInput,
    handleInputChange,
    handleSubmit: customHandleSubmit,
    stop: customHandleStop,
    showProgress,
    progressValue,
    showSuccessMessage,
  };
};

export const ProjectChatRoute = () => {
  useDocumentTitle(t`Chat | Dembrane`);

  const { chatId } = useParams();
  const chatQuery = useProjectChat(chatId ?? "");

  const {
    isInitializing,
    isLoading,
    messages,
    input,
    error,
    contextToBeAdded,
    lastMessageRef,
    setInput,
    handleInputChange,
    handleSubmit,
    stop,
    reload,
    showProgress,
    progressValue,
    showSuccessMessage,
  } = useDembraneChat({ chatId: chatId ?? "" });

  const computedChatForCopy = useMemo(() => {
    const messagesList = messages.map((message) =>
      // @ts-expect-error chatHistoryQuery.data is not typed
      formatMessage(message, "User", "Dembrane"),
    );

    return messagesList.join("\n\n\n\n");
  }, [messages]);

  if (isInitializing || chatQuery.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoadingOverlay visible={true} />
      </div>
    );
  }

  return (
    <Stack className="relative flex min-h-full flex-col px-2 pr-4">
      {/* Header */}
      <Stack className="top-0 w-full bg-white pt-6">
        <Group justify="space-between">
          <Title order={1}>{chatQuery.data?.name ?? t`Chat`}</Title>
          <Group>
            <CopyRichTextIconButton
              markdown={
                `# ${chatQuery.data?.name ?? t`Chat`}\n\n` + computedChatForCopy
              }
            />
          </Group>
        </Group>
        <Divider />
      </Stack>
      {/* Body */}
      <Box className="flex-grow">
        <Stack py="sm" pb="xl" className="relative h-full w-full">
          <ChatHistoryMessage
            // @ts-expect-error chatHistoryQuery.data is not typed
            message={{
              id: "init",
              role: "assistant",
              content: t`Welcome to Dembrane Chat! Use the sidebar to select resources and conversations that you want to analyse. Then, you can ask questions about the selected resources and conversations.`,
            }}
          />

          {/* get everything except the last message */}
          {messages &&
            messages.length > 0 &&
            messages.slice(0, -1).map((message, idx) => (
              <div key={message.id + idx}>
                {/* @ts-expect-error chatHistoryQuery.data is not typed */}
                <ChatHistoryMessage message={message} />
              </div>
            ))}

          {messages &&
            messages.length > 0 &&
            messages[messages.length - 1].role === "user" && (
              <div ref={lastMessageRef}>
                <ChatHistoryMessage
                  // @ts-expect-error chatHistoryQuery.data is not typed
                  message={messages[messages.length - 1]}
                  section={
                    !isLoading && (
                      <Button onClick={handleSubmit}>Regenerate</Button>
                    )
                  }
                />
              </div>
            )}

          {showProgress && (
            <Box className="rounded-bl-0 w-fit rounded-br-[0.75rem] rounded-tl-[0.75rem] rounded-tr-[0.75rem] border border-green-500 px-4 py-3">
              <Text size="sm" className="mb-2 text-center">
                <Trans>Searching through the most relevant sources</Trans>
              </Text>
              <Progress value={progressValue} color="green" size="sm" />
            </Box>
          )}
          {showSuccessMessage && (
            <>
              <Box className="rounded-bl-0 w-fit rounded-br-[0.75rem] rounded-tl-[0.75rem] rounded-tr-[0.75rem] border border-green-500 px-4 py-3">
                <Group>
                  <Box className="rounded-full bg-green-500 p-1">
                    <IconCheck size={16} color="white" />
                  </Box>
                  <Text size="sm">
                    <Trans>Searched through the most relevant sources</Trans>
                  </Text>
                </Group>
              </Box>
              <Box className="mt-2">
                <Text size="sm" fw={500}>
                  Citing the following sources
                </Text>
                <Group gap="xs" mt="sm">
                  <Box className="mr-2 rounded bg-gray-100 p-2">
                    <Text size="xs">Source 1</Text>
                  </Box>
                  <Box className="mr-2 rounded bg-gray-100 p-2">
                    <Text size="xs">Source 2</Text>
                  </Box>
                  <Box className="mr-2 rounded bg-gray-100 p-2">
                    <Text size="xs">Source 3</Text>
                  </Box>
                  <Box className="rounded bg-gray-100 p-2">
                    <Text size="xs">+5 more</Text>
                  </Box>
                </Group>
              </Box>
            </>
          )}

          {isLoading && (
            <Group>
              <Text size="sm" className="italic">
                <Trans>Assistant is typing...</Trans>
              </Text>
              <Button
                onClick={() => stop()}
                variant="outline"
                color="gray"
                size="sm"
                rightSection={<IconSquare size={14} />}
              >
                <Trans>Stop</Trans>
              </Button>
            </Group>
          )}

          {messages &&
            messages.length > 0 &&
            messages[messages.length - 1].role === "assistant" && (
              <div ref={lastMessageRef}>
                {/* @ts-expect-error chatHistoryQuery.data is not typed */}
                <ChatHistoryMessage message={messages[messages.length - 1]} />
              </div>
            )}

          {error && (
            <Alert
              icon={<IconAlertCircle size="1rem" />}
              title="Error"
              color="red"
              variant="outline"
            >
              <Text>
                <Trans>An error occurred.</Trans>
              </Text>
              <Button
                color="red"
                onClick={() => reload()}
                leftSection={<IconRefresh size="1rem" />}
                mt="md"
              >
                <Trans>Retry</Trans>
              </Button>
            </Alert>
          )}
        </Stack>
      </Box>
      {/* Footer */}
      <Box className="bottom-0 w-full border-t bg-white py-4 lg:sticky">
        <Stack>
          {contextToBeAdded && contextToBeAdded.conversations.length > 0 && (
            <ChatMessage role="dembrane">
              <Group gap="xs" align="baseline">
                <Text size="xs">
                  <Trans>Adding Context:</Trans>
                </Text>
                <ConversationLinks
                  // @ts-expect-error conversation_id is not typed
                  conversations={contextToBeAdded.conversations.map((c) => ({
                    id: c.conversation_id,
                    participant_name: c.conversation_participant_name,
                  }))}
                />
              </Group>
            </ChatMessage>
          )}
          <Box className="flex-grow">
            <ChatContextProgress chatId={chatId ?? ""} />
          </Box>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSubmit();
            }}
          >
            <Group>
              <Box className="grow">
                <Textarea
                  placeholder={t`Type a message...`}
                  minRows={4}
                  maxRows={10}
                  autosize
                  value={input}
                  onChange={handleInputChange}
                  disabled={isLoading}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      e.stopPropagation();
                      handleSubmit();
                    }
                  }}
                  color="gray"
                />
              </Box>
              <Stack className="h-full" gap="xs">
                <Box>
                  <Button
                    size="lg"
                    type="submit"
                    variant="primary"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      handleSubmit();
                    }}
                    rightSection={<IconSend size={24} />}
                    disabled={input.trim() === "" || isLoading}
                  >
                    <Trans>Send</Trans>
                  </Button>
                </Box>

                <ChatTemplatesMenu input={input} setInput={setInput} />
              </Stack>
            </Group>

            <Text size="xs" className="mt-1 italic" c="dimmed">
              <Trans>Use Shift + Enter to add a new line</Trans>
            </Text>
          </form>
        </Stack>
      </Box>
    </Stack>
  );
};
