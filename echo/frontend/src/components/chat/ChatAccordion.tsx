import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { useDeleteChatMutation, useProjectChats, useUpdateChatMutation } from "./hooks";
import {
  Accordion,
  ActionIcon,
  Group,
  LoadingOverlay,
  Menu,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useParams } from "react-router-dom";
import { IconDotsVertical, IconPencil, IconTrash } from "@tabler/icons-react";
import { formatRelative } from "date-fns";
import { NavigationButton } from "../common/NavigationButton";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";

const ChatAccordionItemMenu = ({ chat }: { chat: Partial<ProjectChat> }) => {
  const deleteChatMutation = useDeleteChatMutation();
  const updateChatMutation = useUpdateChatMutation();
  const navigate = useI18nNavigate();

  return (
    <Menu shadow="md" position="right">
      <Menu.Target>
        <ActionIcon
          variant="transparent"
          c="gray"
          className="flex items-center justify-center"
        >
          <IconDotsVertical />
        </ActionIcon>
      </Menu.Target>

      <Menu.Dropdown>
        <Stack gap="xs">
          <Menu.Item
            leftSection={<IconPencil />}
            disabled={deleteChatMutation.isPending}
            onClick={() => {
              const newName = prompt(
                t`Enter new name for the chat:`,
                chat.name ?? "",
              );
              if (newName) {
                updateChatMutation.mutate({
                  chatId: chat.id ?? "",
                  projectId: (chat.project_id as string) ?? "",
                  payload: { name: newName },
                });
              }
            }}
          >
            <Trans>Rename</Trans>
          </Menu.Item>
          <Menu.Item
            leftSection={<IconTrash />}
            disabled={deleteChatMutation.isPending}
            onClick={() => {
              deleteChatMutation.mutate({
                chatId: chat.id ?? "",
                projectId: (chat.project_id as string) ?? "",
              });
              navigate(`/projects/${chat.project_id}/overview`);
            }}
          >
            <Trans>Delete</Trans>
          </Menu.Item>
        </Stack>
      </Menu.Dropdown>
    </Menu>
  );
};

// Chat Accordion
export const ChatAccordion = ({ projectId }: { projectId: string }) => {
  const { chatId: activeChatId } = useParams();

  const chatsQuery = useProjectChats(projectId, {
    filter: {
      project_id: {
        _eq: projectId,
      },
      _or: [
        // @ts-ignore
        ...(activeChatId
          ? [
              {
                id: {
                  _eq: activeChatId,
                },
              },
            ]
          : []),
        // @ts-ignore
        {
          "count(project_chat_messages)": {
            _gt: 0,
          },
        },
      ],
    },
  });

  return (
    <Accordion.Item value="chat">
      <Accordion.Control>
        <Group justify="space-between">
          <Title order={3}>
            <span className="min-w-[48px] pr-2 font-normal text-gray-500">
              {chatsQuery.data?.length ?? 0}
            </span>
            <Trans>Chats</Trans>
          </Title>
        </Group>
      </Accordion.Control>

      <Accordion.Panel>
        <Stack gap="xs">
          <LoadingOverlay visible={chatsQuery.isLoading} />
          {chatsQuery.data?.length === 0 && (
            <Text size="sm">
              <Trans>
                No chats found. Start a chat using the "Ask" button.
              </Trans>
            </Text>
          )}
          {chatsQuery.data?.map((item) => (
            <NavigationButton
              key={item.id}
              to={`/projects/${projectId}/chats/${item.id}`}
              active={item.id === activeChatId}
              rightSection={
                <ChatAccordionItemMenu chat={item as ProjectChat} />
              }
            >
              <Text size="xs">
                {item.name
                  ? item.name
                  : formatRelative(
                      new Date(item.date_created ?? new Date()),
                      new Date(),
                    )}
              </Text>
            </NavigationButton>
          ))}
        </Stack>
      </Accordion.Panel>
    </Accordion.Item>
  );
};
