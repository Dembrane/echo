import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Icons } from "@/icons";
import {
  useAddChatContextMutation,
  useConversationsByProjectId,
  useDeleteChatContextMutation,
  useProjectChatContext,
  useMoveConversationMutation,
  useInfiniteProjects,
} from "@/lib/query";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import {
  Accordion,
  ActionIcon,
  Anchor,
  Checkbox,
  Group,
  Loader,
  LoadingOverlay,
  Menu,
  Pill,
  Radio,
  Skeleton,
  Stack,
  Text,
  TextInput,
  Title,
  Tooltip,
  Modal,
  Button,
  ScrollArea,
  Center,
} from "@mantine/core";
import { useState, useRef, useEffect } from "react";
import { useLocation, useParams } from "react-router-dom";
import { UploadConversationDropzone } from "../dropzone/UploadConversationDropzone";
import { useDebouncedValue } from "@mantine/hooks";
import {
  IconFilter,
  IconSearch,
  IconX,
  IconArrowsExchange,
} from "@tabler/icons-react";
import { formatRelative } from "date-fns";
import { NavigationButton } from "../common/NavigationButton";
import { cn } from "@/lib/utils";
import { I18nLink } from "@/components/common/i18nLink";
import { useSessionStorage } from "@mantine/hooks";
import { useDisclosure } from "@mantine/hooks";

import { useIntersection } from "@mantine/hooks";
import { useForm, Controller } from "react-hook-form";
import { FormLabel } from "@/components/form/FormLabel";

type SortOption = {
  label: string;
  value:
    | "-created_at"
    | "created_at"
    | "-participant_name"
    | "participant_name";
};

const ConversationAccordionLabelChatSelection = ({
  conversation,
}: {
  conversation: Conversation;
}) => {
  const { chatId } = useParams();
  const projectChatContextQuery = useProjectChatContext(chatId ?? "");
  const addChatContextMutation = useAddChatContextMutation();
  const deleteChatContextMutation = useDeleteChatContextMutation();

  if (
    projectChatContextQuery.isLoading ||
    addChatContextMutation.isPending ||
    deleteChatContextMutation.isPending
  ) {
    return (
      <Tooltip label={t`Loading...`}>
        <Loader size="xs" />
      </Tooltip>
    );
  }

  const isSelected = !!projectChatContextQuery.data?.conversations?.find(
    (c) => c.conversation_id === conversation.id,
  );
  const isLocked = !!projectChatContextQuery.data?.conversations?.find(
    (c) => c.conversation_id === conversation.id && c.locked,
  );

  const handleSelectChat = () => {
    if (!isSelected) {
      addChatContextMutation.mutate({
        chatId: chatId ?? "",
        conversationId: conversation.id,
      });
    } else {
      deleteChatContextMutation.mutate({
        chatId: chatId ?? "",
        conversationId: conversation.id,
      });
    }
  };

  const tooltipLabel = isLocked
    ? t`Already added to this chat`
    : isSelected
      ? t`Remove from this chat`
      : t`Add to this chat`;

  return (
    <Tooltip label={tooltipLabel}>
      <Checkbox
        size="md"
        checked={isSelected}
        disabled={isLocked}
        onChange={handleSelectChat}
      />
    </Tooltip>
  );
};

type MoveConversationFormData = {
  search: string;
  targetProjectId: string;
};

export const MoveConversationButton = ({
  conversation,
}: {
  conversation: Conversation;
}) => {
  const [opened, { open, close }] = useDisclosure(false);
  const lastItemRef = useRef<HTMLDivElement>(null);
  const { ref, entry } = useIntersection({
    root: lastItemRef.current,
    threshold: 1,
  });

  const form = useForm<MoveConversationFormData>({
    defaultValues: {
      search: "",
      targetProjectId: "",
    },
  });

  const { watch } = form;
  const search = watch("search");

  const projectsQuery = useInfiniteProjects({
    query: {
      sort: ["-updated_at"],
      filter: {
        // @ts-expect-error not tyed
        _and: [{ id: { _neq: conversation.project_id } }],
      },
      search: search,
    },
    enabled: opened,
  });

  const moveConversationMutation = useMoveConversationMutation();

  // Reset form when modal closes
  useEffect(() => {
    if (!opened) {
      form.reset();
    }
  }, [opened]);

  const handleMove = (data: MoveConversationFormData) => {
    if (!data.targetProjectId) return;
    moveConversationMutation.mutate(
      {
        conversationId: conversation.id,
        targetProjectId: data.targetProjectId,
      },
      {
        onSuccess: () => {
          close();
        },
      },
    );
  };

  useEffect(() => {
    if (entry?.isIntersecting && projectsQuery.hasNextPage) {
      projectsQuery.fetchNextPage();
    }
  }, [entry?.isIntersecting]);

  const allProjects =
    projectsQuery.data?.pages.flatMap((page) => page.projects) ?? [];

  return (
    <>
      <Button
        onClick={open}
        variant="outline"
        color="blue"
        rightSection={<IconArrowsExchange size={16} />}
      >
        <Trans>Move to Project</Trans>
      </Button>

      <Modal opened={opened} onClose={close} title={t`Move Conversation`}>
        <form onSubmit={form.handleSubmit(handleMove)}>
          <Stack>
            <Controller
              name="search"
              control={form.control}
              render={({ field }) => (
                <TextInput
                  label={
                    <FormLabel
                      label={t`Search Projects`}
                      isDirty={form.formState.dirtyFields.search}
                    />
                  }
                  placeholder={t`Search projects...`}
                  leftSection={<IconSearch size={16} />}
                  {...field}
                />
              )}
            />

            <ScrollArea h={300}>
              {projectsQuery.isLoading ? (
                <Center h={200}>
                  <Loader />
                </Center>
              ) : (
                <Controller
                  name="targetProjectId"
                  control={form.control}
                  render={({ field }) => (
                    <Radio.Group
                      label={
                        <FormLabel
                          label={t`Select Project`}
                          isDirty={form.formState.dirtyFields.targetProjectId}
                        />
                      }
                      {...field}
                    >
                      <Stack>
                        {allProjects.map((project, index) => (
                          <div
                            key={project.id}
                            ref={
                              index === allProjects.length - 1 ? ref : undefined
                            }
                          >
                            <Radio value={project.id} label={project.name} />
                          </div>
                        ))}
                        {projectsQuery.isFetchingNextPage && (
                          <Center>
                            <Loader size="sm" />
                          </Center>
                        )}
                      </Stack>
                    </Radio.Group>
                  )}
                />
              )}
            </ScrollArea>

            <Group justify="flex-end" mt="md">
              <Button
                variant="subtle"
                onClick={close}
                disabled={moveConversationMutation.isPending}
              >
                {t`Cancel`}
              </Button>
              <Button
                type="submit"
                loading={moveConversationMutation.isPending}
                disabled={
                  !form.watch("targetProjectId") ||
                  moveConversationMutation.isPending
                }
              >
                {t`Move`}
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>
    </>
  );
};

const ConversationAccordionItem = ({
  conversation,
  highlight = false,
}: {
  conversation: Conversation;
  highlight?: boolean;
}) => {
  const location = useLocation();
  const inChatMode = location.pathname.includes("/chats/");

  const { chatId } = useParams();
  const chatContextQuery = useProjectChatContext(chatId ?? "");

  if (inChatMode && chatContextQuery.isLoading) {
    return <Skeleton height={60} />;
  }

  const isLocked = chatContextQuery.data?.conversations?.find(
    (c) => c.conversation_id === conversation.id && c.locked,
  );

  return (
    <NavigationButton
      to={`/projects/${conversation.project_id}/conversation/${conversation.id}/overview`}
      active={highlight}
      className={cn("w-full", {
        "!bg-primary-50": isLocked,
      })}
      rightSection={
        inChatMode && (
          <ConversationAccordionLabelChatSelection
            conversation={conversation}
          />
        )
      }
    >
      <Stack gap="4" className="pb-[3px]">
        <div>
          <Text className="pl-[4px] text-sm font-normal">
            {conversation.participant_email ?? conversation.participant_name}
          </Text>
        </div>
        <div>
          <Text size="xs" c="gray.6" className="pl-[4px]">
            {formatRelative(
              new Date(conversation.created_at ?? new Date()),
              new Date(),
            )}
          </Text>
        </div>
        <Group gap="4" pr="sm" wrap="wrap">
          {conversation.tags &&
            conversation.tags
              .filter((tag) => tag.project_tag_id && tag.project_tag_id != null)
              .map((tag) => (
                <Pill
                  key={`${tag.id}-${(tag?.project_tag_id as unknown as ProjectTag)?.text}`}
                  size="sm"
                  className="font-normal"
                >
                  {(tag?.project_tag_id as unknown as ProjectTag)?.text}
                </Pill>
              ))}
        </Group>
      </Stack>
    </NavigationButton>
  );
};

// Conversation Accordion
export const ConversationAccordion = ({ projectId }: { projectId: string }) => {
  const SORT_OPTIONS: SortOption[] = [
    { label: t`Newest First`, value: "-created_at" },
    { label: t`Oldest First`, value: "created_at" },
    { label: t`Name A-Z`, value: "participant_name" },
    { label: t`Name Z-A`, value: "-participant_name" },
  ];

  const [hideConversationsWithoutContent, setHideConversationsWithoutContent] =
    useSessionStorage({
      key: "hide-empty-conversations",
      defaultValue: true,
    });

  const [sortBy, setSortBy] = useSessionStorage<SortOption["value"]>({
    key: "conversations-sort",
    defaultValue: "-created_at",
  });

  const { conversationId: activeConversationId } = useParams();
  const [conversationSearch, setConversationSearch] = useState("");
  const [debouncedConversationSearchValue] = useDebouncedValue(
    conversationSearch,
    200,
  );

  const conversationsQuery = useConversationsByProjectId(
    projectId,
    false,
    hideConversationsWithoutContent,
    {
      search: debouncedConversationSearchValue,
      sort: sortBy,
    },
  );

  const [parent2] = useAutoAnimate();

  const filterApplied =
    hideConversationsWithoutContent || debouncedConversationSearchValue !== "";

  return (
    <Accordion.Item value="conversations">
      <Accordion.Control>
        <Group justify="space-between">
          <Title order={3}>
            <span className="min-w-[48px] pr-2 font-normal text-gray-500">
              {conversationsQuery.data?.length ?? 0}
            </span>
            <Trans>Conversations</Trans>
          </Title>

          <Tooltip label={`Upload conversations`}>
            <div>
              <UploadConversationDropzone projectId={projectId}>
                <Icons.Plus stroke="black" fill="black" />
              </UploadConversationDropzone>
            </div>
          </Tooltip>
        </Group>
      </Accordion.Control>

      <Accordion.Panel>
        <Stack ref={parent2} className="relative">
          {!(
            conversationsQuery.data &&
            conversationsQuery.data.length === 0 &&
            debouncedConversationSearchValue === ""
          ) && (
            <Group justify="space-between" align="center" gap="xs">
              <TextInput
                leftSection={<IconSearch />}
                rightSection={
                  !!conversationSearch && (
                    <ActionIcon
                      disabled={conversationsQuery.isLoading}
                      variant="transparent"
                      onClick={() => {
                        setConversationSearch("");
                      }}
                    >
                      <IconX />
                    </ActionIcon>
                  )
                }
                placeholder={t`Search conversations`}
                value={conversationSearch}
                size="sm"
                onChange={(e) => setConversationSearch(e.currentTarget.value)}
                className="flex-grow"
              />
              <Menu withArrow position="right" shadow="md">
                <Menu.Target>
                  <ActionIcon
                    variant="outline"
                    color={filterApplied ? "primary" : "gray"}
                    c={filterApplied ? "primary" : "gray"}
                  >
                    <IconFilter size={24} />
                  </ActionIcon>
                </Menu.Target>
                <Menu.Dropdown>
                  <Stack py="md" px="lg" gap="md">
                    <Stack gap="xs">
                      <Text size="lg">
                        <Trans>Filter</Trans>
                      </Text>
                      <Checkbox
                        size="sm"
                        disabled={conversationsQuery.isLoading}
                        label={t`Hide Conversations Without Content`}
                        checked={hideConversationsWithoutContent}
                        onChange={(event) =>
                          setHideConversationsWithoutContent(
                            event.currentTarget.checked,
                          )
                        }
                      />
                    </Stack>
                    <Stack gap="xs">
                      <Text size="lg">
                        <Trans>Sort</Trans>
                      </Text>
                      <Stack gap="xs">
                        <Radio.Group
                          value={sortBy}
                          onChange={(value) =>
                            setSortBy(value as SortOption["value"])
                          }
                          name="sortOptions"
                        >
                          <Stack gap="xs">
                            {SORT_OPTIONS.map((option) => (
                              <Radio
                                key={option.value}
                                value={option.value}
                                label={option.label}
                                size="sm"
                              />
                            ))}
                          </Stack>
                        </Radio.Group>
                      </Stack>
                    </Stack>
                  </Stack>
                </Menu.Dropdown>
              </Menu>
            </Group>
          )}

          {conversationsQuery.data?.length === 0 && (
            <Text size="sm">
              <Trans>
                No conversations found. Start a conversation using the
                participation invite link from the{" "}
                <I18nLink to={`/projects/${projectId}/overview`}>
                  <Anchor>project overview.</Anchor>
                </I18nLink>
              </Trans>
            </Text>
          )}

          <Stack gap="xs" className="relative">
            <LoadingOverlay visible={conversationsQuery.isLoading} />
            {conversationsQuery.data?.map((item) => (
              <ConversationAccordionItem
                key={item.id}
                highlight={item.id === activeConversationId}
                conversation={item as Conversation}
              />
            ))}
          </Stack>
        </Stack>
      </Accordion.Panel>
    </Accordion.Item>
  );
};
