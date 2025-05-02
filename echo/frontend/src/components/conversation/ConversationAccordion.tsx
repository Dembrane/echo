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
  Badge,
} from "@mantine/core";
import {
  useState,
  useRef,
  useEffect,
  useReducer,
  useMemo,
  useCallback,
} from "react";
import { useLocation, useParams } from "react-router-dom";
import { UploadConversationDropzone } from "../dropzone/UploadConversationDropzone";
import { useDebouncedValue } from "@mantine/hooks";
import {
  IconFilter,
  IconSearch,
  IconX,
  IconArrowsExchange,
  IconPinnedFilled,
  IconPinned,
  IconQrcode,
  IconFileUpload,
  IconSort09,
  IconArrowsUpDown,
  IconDotsVertical,
} from "@tabler/icons-react";
import { formatDuration, formatRelative, intervalToDuration } from "date-fns";
import { NavigationButton } from "../common/NavigationButton";
import { cn } from "@/lib/utils";
import { I18nLink } from "@/components/common/i18nLink";
import { useSessionStorage } from "@mantine/hooks";
import { useDisclosure } from "@mantine/hooks";

import { useIntersection } from "@mantine/hooks";
import { useForm, Controller } from "react-hook-form";
import { FormLabel } from "@/components/form/FormLabel";
import { AutoSelectConversations } from "./AutoSelectConversations";
import { ENABLE_CHAT_AUTO_SELECT } from "@/config";

type SortOption = {
  label: string;
  value:
    | "-created_at"
    | "created_at"
    | "-participant_name"
    | "participant_name"
    | "-duration"
    | "duration";
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

  const isAutoSelectEnabled =
    projectChatContextQuery.data?.auto_select_bool ?? false;

  // Check if conversation has any content
  const hasContent = conversation.chunks?.some(
    (chunk) => chunk.transcript && chunk.transcript.trim().length > 0
  );

  const handleSelectChat = () => {
    if (!isSelected) {
      // Don't allow adding empty conversations to chat context
      if (!hasContent) {
        return;
      }
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
    : !hasContent
      ? t`Cannot add empty conversation`
      : isSelected
        ? t`Remove from this chat`
        : t`Add to this chat`;

  return (
    <Tooltip label={tooltipLabel}>
      <Checkbox
        size="md"
        checked={isSelected}
        disabled={isLocked || !hasContent}
        onChange={handleSelectChat}
        color={
          ENABLE_CHAT_AUTO_SELECT && isAutoSelectEnabled ? "green" : undefined
        }
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
  showDuration = false,
}: {
  conversation: Conversation;
  highlight?: boolean;
  showDuration?: boolean;
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

  const isAutoSelectEnabled = chatContextQuery.data?.auto_select_bool ?? false;

  // Check if conversation has any content
  const hasContent = conversation.chunks?.some(
    (chunk) => chunk.transcript && chunk.transcript.trim().length > 0
  );

  return (
    <NavigationButton
      to={`/projects/${conversation.project_id}/conversation/${conversation.id}/overview`}
      active={highlight}
      borderColor={
        ENABLE_CHAT_AUTO_SELECT && isAutoSelectEnabled
          ? "green"
          : undefined
      }
      className={cn("w-full", {
        "!bg-primary-50": isLocked,
      })}
      rightSection={
        (!ENABLE_CHAT_AUTO_SELECT || !isAutoSelectEnabled) && inChatMode && (
          <ConversationAccordionLabelChatSelection
            conversation={conversation}
          />
        )
      }
    >
      <Stack gap="4" className="pb-[3px]">
        <div>
          <Group gap="sm">
            <Text className="pl-[4px] text-sm font-normal">
              {conversation.participant_email ?? conversation.participant_name}
            </Text>

            {conversation.source?.toLocaleLowerCase().includes("upload") && (
              <Badge size="xs" color="blue" variant="light">
                {t`Uploaded`}
              </Badge>
            )}
            {!hasContent && (
              <Badge size="xs" color="red" variant="light">
                {t`Empty`}
              </Badge>
            )}
            {conversation.duration &&
              conversation.duration > 0 &&
              showDuration && (
                <Tooltip
                  label={formatDuration(
                    intervalToDuration({
                      start: 0,
                      end: conversation.duration * 1000,
                    }),
                    {
                      format: ["hours", "minutes", "seconds"],
                      zero: false,
                    },
                  )}
                >
                  <Badge size="xs" color="violet" variant="light">
                    {(() => {
                      const duration = intervalToDuration({
                        start: 0,
                        end: conversation.duration * 1000,
                      });

                      const hours = duration.hours || 0;
                      const minutes = duration.minutes || 0;
                      const seconds = duration.seconds || 0;

                      if (hours > 0) {
                        return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
                      } else {
                        return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
                      }
                    })()}
                  </Badge>
                </Tooltip>
              )}
          </Group>
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
    { label: t`Longest First`, value: "-duration" },
    { label: t`Shortest First`, value: "duration" },
  ];

  const location = useLocation();
  const inChatMode = location.pathname.includes("/chats/");
  // Temporarily disabled source filters
  // const FILTER_OPTIONS = [
  //   { label: t`Conversations from QR Code`, value: "PORTAL_AUDIO" },
  //   { label: t`Conversations from Upload`, value: "DASHBOARD_UPLOAD" },
  // ];

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

  // Track active filters (filters to include)
  // Temporarily disabled source filters
  // const [activeFilters, setActiveFilters] = useState<string[]>([
  //   "PORTAL_AUDIO",
  //   "DASHBOARD_UPLOAD",
  // ]);

  // Get total conversations count without filters
  const totalConversationsQuery = useConversationsByProjectId(
    projectId,
    false,
    false,
    {
      limit: 1,
    },
  );

  // Generalized toggle with improved UX
  // Temporarily disabled source filters
  // const toggleFilter = (filterValue: string) => {
  //   setActiveFilters((prev) => {
  //     const allFilterValues = FILTER_OPTIONS.map((opt) => opt.value);
  //     const isActive = prev.includes(filterValue);

  //     // Case 1: If all filters are active and user clicks one
  //     if (prev.length === allFilterValues.length) {
  //       // Exclude only the clicked filter (keep all others active)
  //       return prev.filter((f) => f !== filterValue);
  //     }

  //     // Case 2: If the filter is inactive, toggle it on
  //     if (!isActive) {
  //       return [...prev, filterValue];
  //     }

  //     // Case 3: If the filter is active but it's the only active filter
  //     // don't allow removing the last filter (prevent zero filters)
  //     if (prev.length === 1) {
  //       // Keep at least one filter active
  //       return prev;
  //     }

  //     // Case 4: If the filter is active and there are other active filters,
  //     // toggle it off
  //     return prev.filter((f) => f !== filterValue);
  //   });
  // };

  // Use memoized active filters for the query
  // const filterBySource = useMemo(() => activeFilters, [activeFilters]);

  const [showDuration, setShowDuration] = useSessionStorage<boolean>({
    key: "conversations-show-duration",
    defaultValue: true,
  });

  const conversationsQuery = useConversationsByProjectId(
    projectId,
    false,
    false,
    {
      search: debouncedConversationSearchValue,
      sort: sortBy,
    },
    // Temporarily disabled source filters
    // filterBySource,
  );

  const [parent2] = useAutoAnimate();

  const filterApplied = useMemo(
    () => debouncedConversationSearchValue !== "" || sortBy !== "-created_at",
    // Temporarily disabled source filters
    //   sortBy !== "-created_at" ||
    //   activeFilters.length !== FILTER_OPTIONS.length,
    // [debouncedConversationSearchValue, sortBy, activeFilters],
    [debouncedConversationSearchValue, sortBy],
  );

  const resetEverything = useCallback(() => {
    setConversationSearch("");
    setSortBy("-created_at");
    // Temporarily disabled source filters
    // setActiveFilters(["PORTAL_AUDIO", "DASHBOARD_UPLOAD"]);
    setShowDuration(true);
  }, []);

  // Temporarily disabled source filters
  // const FilterPin = ({
  //   option,
  // }: {
  //   option: { label: string; value: string };
  // }) => {
  //   const isActive = activeFilters.includes(option.value);

  //   // Determine which icon to use based on the filter type
  //   const getIcon = () => {
  //     if (option.value === "PORTAL_AUDIO") {
  //       return isActive ? (
  //         <IconQrcode size={18} stroke={1.5} />
  //       ) : (
  //         <IconQrcode size={18} stroke={1} opacity={0.6} />
  //       );
  //     } else {
  //       return isActive ? (
  //         <IconFileUpload size={18} stroke={1.5} />
  //       ) : (
  //         <IconFileUpload size={18} stroke={1} opacity={0.6} />
  //       );
  //     }
  //   };

  //   return (
  //     <Tooltip
  //       label={option.label}
  //       aria-label={
  //         isActive ? t`Hide ${option.label}` : t`Show ${option.label}`
  //       }
  //       position="bottom"
  //       withArrow
  //       arrowSize={6}
  //     >
  //       <ActionIcon
  //         variant={isActive ? "light" : "subtle"}
  //         color={isActive ? "blue" : "gray"}
  //         onClick={() => toggleFilter(option.value)}
  //         className="transition-all"
  //         radius="xl"
  //         size="md"
  //         aria-label={option.label}
  //       >
  //         {getIcon()}
  //       </ActionIcon>
  //     </Tooltip>
  //   );
  // };

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
          {inChatMode &&
            ENABLE_CHAT_AUTO_SELECT &&
            conversationsQuery.data?.length !== 0 && (
              <Stack gap="xs" className="relative">
                <LoadingOverlay visible={conversationsQuery.isLoading} />
                <AutoSelectConversations />
              </Stack>
            )}

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
                  <Tooltip label={t`Options`}>
                    <ActionIcon
                      variant="outline"
                      color={filterApplied ? "primary" : "gray"}
                      c={filterApplied ? "primary" : "gray"}
                    >
                      <IconDotsVertical size={16} />
                    </ActionIcon>
                  </Tooltip>
                </Menu.Target>
                <Menu.Dropdown>
                  <Stack py="md" px="lg" gap="md">
                    <Stack gap="xs">
                      <Text size="lg">
                        <Trans>Options</Trans>
                      </Text>
                      <Checkbox
                        label={t`Show duration`}
                        checked={showDuration}
                        onChange={(e) =>
                          setShowDuration(e.currentTarget.checked)
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
                    <Button variant="subtle" onClick={resetEverything}>
                      <Trans>Reset All Options</Trans>
                    </Button>
                  </Stack>
                </Menu.Dropdown>
              </Menu>
            </Group>
          )}

          {/* Filter icons that always appear under the search bar */}
          {/* Temporarily disabled source filters */}
          {/* {totalConversationsQuery.data?.length !== 0 && (
            <Group gap="xs" mt="xs" ml="xs">
              <Text size="sm">
                <Trans>Sources:</Trans>
              </Text>
              {FILTER_OPTIONS.map((option) => (
                <FilterPin key={option.value} option={option} />
              ))}
            </Group>
          )} */}

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
                showDuration={showDuration}
              />
            ))}
            {/* Temporarily disabled source filters */}
            {/* {conversationsQuery.data?.length === 0 &&
              filterBySource.length === 0 && (
                <Text size="sm">
                  <Trans>Please select at least one source</Trans>
                </Text>
              )} */}
          </Stack>
        </Stack>
      </Accordion.Panel>
    </Accordion.Item>
  );
};
