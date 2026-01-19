import { useAutoAnimate } from "@formkit/auto-animate/react";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Accordion,
	ActionIcon,
	Anchor,
	Badge,
	Box,
	Button,
	Center,
	Checkbox,
	Divider,
	Group,
	Loader,
	LoadingOverlay,
	Menu,
	Modal,
	Pill,
	Radio,
	ScrollArea,
	Skeleton,
	Stack,
	Text,
	TextInput,
	ThemeIcon,
	Title,
	Tooltip,
} from "@mantine/core";
import {
	useDebouncedValue,
	useDisclosure,
	useIntersection,
	useMediaQuery,
	useSessionStorage,
} from "@mantine/hooks";
import {
	IconArrowsExchange,
	IconArrowsUpDown,
	IconChevronDown,
	IconChevronUp,
	IconRosetteDiscountCheckFilled,
	IconSearch,
	IconSelectAll,
	IconTags,
	IconX,
} from "@tabler/icons-react";
import { formatRelative, intervalToDuration } from "date-fns";
import {
	type RefObject,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { Controller, useForm } from "react-hook-form";
import { useInView } from "react-intersection-observer";
import { useLocation, useParams } from "react-router";
import { MODE_COLORS } from "@/components/chat/ChatModeSelector";
import { useProjectChatContext } from "@/components/chat/hooks";
import { I18nLink } from "@/components/common/i18nLink";
import { toast } from "@/components/common/Toaster";
import { FormLabel } from "@/components/form/FormLabel";
import {
	useInfiniteProjects,
	useProjectById,
} from "@/components/project/hooks";
import { ENABLE_CHAT_AUTO_SELECT, ENABLE_CHAT_SELECT_ALL } from "@/config";
import { BaseSkeleton } from "../common/BaseSkeleton";
import { NavigationButton } from "../common/NavigationButton";
import { UploadConversationDropzone } from "../dropzone/UploadConversationDropzone";
import { AddTagFilterModal } from "./AddTagFilterModal";
import { AutoSelectConversations } from "./AutoSelectConversations";
import {
	useAddChatContextMutation,
	useConversationsCountByProjectId,
	useDeleteChatContextMutation,
	useInfiniteConversationsByProjectId,
	useMoveConversationMutation,
	useRemainingConversationsCount,
	useSelectAllContextMutation,
} from "./hooks";
import { SelectAllConfirmationModal } from "./SelectAllConfirmationModal";

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
				<Loader size="xs" color={MODE_COLORS.deep_dive.primary} />
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
	const hasContent = conversation.chunks?.some((chunk) => {
		const transcript = (chunk as unknown as ConversationChunk).transcript;
		return typeof transcript === "string" && transcript.trim().length > 0;
	});

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
			filter: {
				_and: [{ id: { _neq: conversation.project_id } }],
			},
			search: search,
			sort: ["-updated_at"],
		},
	});

	const moveConversationMutation = useMoveConversationMutation();

	// Reset form when modal closes
	useEffect(() => {
		if (!opened) {
			form.reset();
		}
	}, [opened, form.reset]);

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
	}, [
		entry?.isIntersecting,
		projectsQuery.fetchNextPage,
		projectsQuery.hasNextPage,
	]);

	const allProjects =
		(
			projectsQuery.data?.pages as
				| { projects: Project[]; nextOffset?: number }[]
				| undefined
		)?.flatMap((page) => page.projects) ?? [];

	return (
		<>
			<Button
				onClick={open}
				variant="outline"
				color="primary"
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

export const ConversationStatusIndicators = ({
	conversation,
	showDuration = false,
}: {
	conversation: Conversation;
	showDuration?: boolean;
}) => {
	const { projectId } = useParams();

	useProjectById({
		projectId: projectId ?? "",
		query: {
			fields: ["is_enhanced_audio_processing_enabled"],
		},
	});

	// const hasContent = useMemo(
	// 	() => conversation.chunks?.length && conversation.chunks.length > 0,
	// 	[conversation.chunks],
	// );

	const hasOnlyTextContent = useMemo(
		() =>
			conversation.chunks?.length > 0 &&
			conversation.chunks?.every(
				(chunk) =>
					(chunk as unknown as ConversationChunk).source === "PORTAL_TEXT",
			),
		[conversation.chunks],
	);

	const fDuration = useCallback((duration: number) => {
		const d = intervalToDuration({
			end: duration * 1000,
			start: 0,
		});

		const hours = d.hours || 0;
		const minutes = d.minutes || 0;
		const seconds = d.seconds || 0;

		if (hours > 0) {
			return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
		} else {
			return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
		}
	}, []);

	const isUpload =
		conversation.source?.toLowerCase().includes("upload") ?? false;

	return (
		<Group gap="sm">
			{isUpload && (
				<Badge size="xs" color="primary" variant="light">
					{t`Upload`}
				</Badge>
			)}

			{hasOnlyTextContent && (
				<Badge size="xs" color="primary" variant="light">
					<Trans>Text</Trans>
				</Badge>
			)}

			{conversation.duration && conversation.duration > 0 && showDuration && (
				<Badge size="xs" color="primary" variant="light">
					{fDuration(conversation.duration)}
				</Badge>
			)}

			{/* {!hasContent &&
				conversation.is_finished === true &&
				conversation.is_all_chunks_transcribed === true && (
					<Badge size="xs" color="red" variant="light">
						{t`Empty`}
					</Badge>
				)} */}

			{/* 
      {conversation.error != null && (
        <Tooltip
          label={t`Processing failed for this conversation. This conversation will not be available for analysis and chat.`}
        >
          <Badge size="xs" color="red" variant="light">
            <Group gap="xs">
              {t`Error`}
              <IconInfoCircle size={12} />
            </Group>
          </Badge>
        </Tooltip>
      )} */}
		</Group>
	);
};

const ConversationProjectTagPill = ({
	tag,
	onClick,
}: {
	tag: ConversationProjectTag;
	onClick?: (tag: ConversationProjectTag) => void;
}) => {
	const text = (tag?.project_tag_id as ProjectTag)?.text ?? "";

	if (!text) {
		return null;
	}

	const isClickable = ENABLE_CHAT_SELECT_ALL && onClick;

	return (
		<Pill
			size="sm"
			classNames={{
				root: `!bg-[var(--mantine-primary-color-light)] !font-medium ${
					isClickable
						? "cursor-pointer hover:opacity-80 transition-opacity"
						: ""
				}`,
			}}
			onClick={
				isClickable
					? (e) => {
							e.stopPropagation();
							e.preventDefault();
							onClick(tag);
						}
					: undefined
			}
		>
			{text}
		</Pill>
	);
};

const ConversationAccordionItem = ({
	conversation,
	highlight = false,
	showDuration = false,
	onTagClick,
}: {
	conversation?: Conversation & { live: boolean };
	highlight?: boolean;
	showDuration?: boolean;
	onTagClick?: (tag: ConversationProjectTag) => void;
}) => {
	const location = useLocation();
	const inChatMode = location.pathname.includes("/chats/");
	const isNewChatRoute = location.pathname.includes("/chats/new");

	const { chatId } = useParams();
	const chatContextQuery = useProjectChatContext(chatId ?? "");

	// Don't show loading skeleton for new chat route (no chat exists yet)
	if (inChatMode && !isNewChatRoute && chatContextQuery.isLoading) {
		return <Skeleton height={60} />;
	}

	if (!conversation) {
		return null;
	}

	const isLocked = chatContextQuery.data?.conversations?.find(
		(c) => c.conversation_id === conversation.id && c.locked,
	);

	const isAutoSelectEnabled = chatContextQuery.data?.auto_select_bool ?? false;
	const chatMode = chatContextQuery.data?.chat_mode;

	// Hide checkboxes when:
	// - In /chats/new (mode not yet selected)
	// - In overview mode (summaries, no manual selection)
	// - Chat mode is null/undefined for backward compatibility with legacy chats, still show checkboxes
	const shouldShowCheckboxes =
		inChatMode && !isNewChatRoute && chatMode !== "overview";

	// Check if conversation has approved artefacts
	const hasVerifiedArtefacts =
		conversation?.conversation_artifacts &&
		conversation?.conversation_artifacts?.length > 0 &&
		conversation?.conversation_artifacts?.some(
			(artefact) => (artefact as ConversationArtifact).approved_at,
		);

	// In overview mode, show a subtle "included" indicator
	const isOverviewMode = chatMode === "overview";

	// Mode-based styling
	const isDeepDiveWithSelection =
		inChatMode && !isNewChatRoute && chatMode === "deep_dive" && isLocked;

	return (
		<NavigationButton
			to={`/projects/${conversation.project_id}/conversation/${conversation.id}/overview`}
			active={highlight}
			borderColor={
				isOverviewMode
					? MODE_COLORS.overview.primary
					: isDeepDiveWithSelection
						? MODE_COLORS.deep_dive.primary
						: ENABLE_CHAT_AUTO_SELECT && isAutoSelectEnabled
							? "green"
							: undefined
			}
			className="w-full"
			rightSection={
				shouldShowCheckboxes ? (
					<ConversationAccordionLabelChatSelection
						conversation={conversation}
					/>
				) : null
			}
		>
			<Stack gap="4" className="pb-[3px]">
				<Stack gap="xs">
					<Group gap="sm">
						<Text className="pl-[4px] text-sm font-normal">
							{conversation.participant_email ?? conversation.participant_name}
						</Text>
						{hasVerifiedArtefacts && (
							<Tooltip label={t`Has verified artifacts`}>
								<ThemeIcon
									variant="subtle"
									color="primary"
									aria-label={t`verified artifacts`}
									size={18}
									style={{ cursor: "default" }}
								>
									<IconRosetteDiscountCheckFilled />
								</ThemeIcon>
							</Tooltip>
						)}
					</Group>
					<ConversationStatusIndicators
						conversation={conversation}
						showDuration={showDuration}
					/>
				</Stack>
				<div className="flex items-center justify-between gap-4">
					<Text size="xs" c="gray.6" className="pl-[4px]">
						{formatRelative(
							new Date(conversation.created_at ?? new Date()),
							new Date(),
						)}
					</Text>
					{
						// if from portal and not finished
						["portal_audio"].includes(
							conversation.source?.toLowerCase() ?? "",
						) &&
							conversation.live && (
								<Box className="flex items-baseline gap-1 pr-[4px]">
									<div className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
									<Text size="xs" fs="italic" fw={500}>
										<Trans id="conversation.ongoing">Ongoing</Trans>
									</Text>
								</Box>
							)
					}
				</div>
				<Group gap="4" pr="sm" wrap="wrap">
					{conversation.tags?.map((tag) => (
						<ConversationProjectTagPill
							key={(tag as ConversationProjectTag).id}
							tag={tag as ConversationProjectTag}
							onClick={onTagClick}
						/>
					))}
				</Group>
			</Stack>
		</NavigationButton>
	);
};

// Conversation Accordion
export const ConversationAccordion = ({
	projectId,
	qrCodeRef,
}: {
	projectId: string;
	qrCodeRef?: RefObject<HTMLDivElement | null>;
}) => {
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
	const isMobile = useMediaQuery("(max-width: 768px)");
	const { conversationId: activeConversationId, chatId } = useParams();
	const { ref: loadMoreRef, inView } = useInView();

	// Get chat context to check mode
	const chatContextQuery = useProjectChatContext(chatId ?? "");
	const chatMode = chatContextQuery.data?.chat_mode;
	const isOverviewMode = chatMode === "overview";

	// Temporarily disabled source filters
	// const FILTER_OPTIONS = [
	//   { label: t`Conversations from QR Code`, value: "PORTAL_AUDIO" },
	//   { label: t`Conversations from Upload`, value: "DASHBOARD_UPLOAD" },
	// ];

	const [sortBy, setSortBy] = useSessionStorage<SortOption["value"]>({
		defaultValue: "-created_at",
		key: "conversations-sort",
	});

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
		defaultValue: true,
		key: "conversations-show-duration",
	});

	// Tags filter state (fetch only tags for minimal payload)
	const { data: projectTags, isLoading: projectTagsLoading } = useProjectById({
		projectId,
		query: {
			deep: {
				tags: {
					_sort: "sort",
				},
			},
			fields: [
				{
					tags: ["id", "text", "sort"],
				},
			],
		},
	});
	const [tagSearch, setTagSearch] = useState("");
	const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
	const [showOnlyVerified, setShowOnlyVerified] = useState(false);
	const allProjectTags = useMemo(
		() => (projectTags?.tags as unknown as ProjectTag[]) ?? [],
		[projectTags?.tags],
	);
	const filteredProjectTags = useMemo(() => {
		const query = tagSearch.trim().toLowerCase();
		if (!query) return allProjectTags;
		return allProjectTags.filter((t) =>
			(t.text ?? "").toLowerCase().includes(query),
		);
	}, [allProjectTags, tagSearch]);

	const conversationsQuery = useInfiniteConversationsByProjectId(
		projectId,
		false,
		false,
		{
			deep: {
				chunks: {
					_limit: 25,
					_sort: ["-timestamp", "-created_at"],
				},
			},
			// Override filter to add tag filtering while preserving project scope
			filter: {
				project_id: { _eq: projectId },
				...(selectedTagIds.length > 0 && {
					tags: {
						_some: {
							project_tag_id: {
								id: { _in: selectedTagIds },
							},
						},
					},
				}),
				...(showOnlyVerified && {
					conversation_artifacts: {
						_some: {
							approved_at: {
								_nnull: true,
							},
						},
					},
				}),
			},
			search: debouncedConversationSearchValue,
			sort: sortBy,
		},
		// Temporarily disabled source filters
		// filterBySource,
		undefined,
		{
			initialLimit: 15,
		},
	);

	// Get total conversations count for display (unfiltered)
	const conversationsCountQuery = useConversationsCountByProjectId(projectId);
	const totalConversations = Number(conversationsCountQuery.data) ?? 0;

	// Load more conversations when user scrolls to bottom
	useEffect(() => {
		if (
			inView &&
			conversationsQuery.hasNextPage &&
			!conversationsQuery.isFetchingNextPage
		) {
			conversationsQuery.fetchNextPage();
		}
	}, [
		inView,
		conversationsQuery.hasNextPage,
		conversationsQuery.isFetchingNextPage,
		conversationsQuery.fetchNextPage,
	]);

	// Flatten all conversations from all pages
	const allConversations =
		conversationsQuery.data?.pages.flatMap((page) => page.conversations) ?? [];

	const [filterActionsParent] = useAutoAnimate();

	const filterApplied = useMemo(
		() =>
			debouncedConversationSearchValue !== "" ||
			sortBy !== "-created_at" ||
			selectedTagIds.length > 0 ||
			showOnlyVerified,
		// Temporarily disabled source filters
		//   sortBy !== "-created_at" ||
		//   activeFilters.length !== FILTER_OPTIONS.length,
		// [debouncedConversationSearchValue, sortBy, activeFilters],
		[
			debouncedConversationSearchValue,
			sortBy,
			selectedTagIds.length,
			showOnlyVerified,
		],
	);

	// Calculate remaining conversations (not yet in context)
	const conversationsInContext = useMemo(() => {
		const contextConversations = chatContextQuery.data?.conversations ?? [];
		return new Set(contextConversations.map((c) => c.conversation_id));
	}, [chatContextQuery.data?.conversations]);

	// Check if we have any filters applied (used for modal text wording)
	const hasActiveFilters =
		selectedTagIds.length > 0 ||
		showOnlyVerified ||
		debouncedConversationSearchValue !== "";

	// Check if we should show count in button (filters OR existing context)
	const shouldShowConversationCount =
		hasActiveFilters || conversationsInContext.size > 0;

	const remainingConversations = useMemo(() => {
		return allConversations.filter(
			(conv) => !conversationsInContext.has(conv.id),
		);
	}, [allConversations, conversationsInContext]);

	// Use the new hook to get accurate count independent of pagination
	// Only query when the feature is enabled and we're in deep dive mode
	const remainingCountQuery = useRemainingConversationsCount(
		projectId,
		chatId,
		{
			searchText: debouncedConversationSearchValue || undefined,
			tagIds: selectedTagIds.length > 0 ? selectedTagIds : undefined,
			verifiedOnly: showOnlyVerified || undefined,
		},
		{
			enabled: ENABLE_CHAT_SELECT_ALL && inChatMode && chatMode === "deep_dive",
		},
	);

	// Use the accurate count from the query, fallback to paginated count for display
	const remainingCount =
		remainingCountQuery.data ?? remainingConversations.length;

	// biome-ignore lint/correctness/useExhaustiveDependencies: <should update when sortBy or selectedTagIds.length changes>
	const appliedFiltersCount = useMemo(() => {
		return selectedTagIds.length + (showOnlyVerified ? 1 : 0);
	}, [sortBy, selectedTagIds.length, showOnlyVerified]);

	const [showFilterActions, setShowFilterActions] = useState(false);
	const [sortMenuOpened, setSortMenuOpened] = useState(false);
	const [tagsMenuOpened, setTagsMenuOpened] = useState(false);

	// Select All state
	const [selectAllModalOpened, setSelectAllModalOpened] = useState(false);
	const [selectAllResult, setSelectAllResult] =
		useState<SelectAllContextResponse | null>(null);
	const [selectAllLoading, setSelectAllLoading] = useState(false);
	const selectAllMutation = useSelectAllContextMutation();

	// Add Tag Filter Modal state
	const [addTagFilterModalOpened, addTagFilterModalHandlers] =
		useDisclosure(false);
	const [selectedTagForFilter, setSelectedTagForFilter] =
		useState<ConversationProjectTag | null>(null);

	// Handle tag click
	const handleTagClick = (tag: ConversationProjectTag) => {
		setSelectedTagForFilter(tag);
		addTagFilterModalHandlers.open();
	};

	// Handle tag filter confirmation
	const handleAddTagFilter = () => {
		if (!selectedTagForFilter) return;

		const tagId = (selectedTagForFilter.project_tag_id as ProjectTag)?.id;
		if (tagId && !selectedTagIds.includes(tagId)) {
			setSelectedTagIds((prev) => [...prev, tagId]);
		}
	};

	const handleTagFilterModalExitTransitionEnd = () => {
		// Clear data after modal has fully closed
		setSelectedTagForFilter(null);
	};

	// Handle select all
	const handleSelectAllClick = () => {
		setSelectAllModalOpened(true);
		setSelectAllResult(null);
	};

	const handleSelectAllConfirm = async () => {
		if (!chatId || !projectId) {
			toast.error(t`Failed to add conversations to context`);
			console.error("Missing required parameters for select all");
			return;
		}

		setSelectAllLoading(true);
		try {
			const result = await selectAllMutation.mutateAsync({
				chatId,
				projectId,
				searchText: debouncedConversationSearchValue || undefined,
				tagIds: selectedTagIds.length > 0 ? selectedTagIds : undefined,
				verifiedOnly: showOnlyVerified || undefined,
			});
			setSelectAllResult(result);
		} catch (_error) {
			toast.error(t`Failed to add conversations to context`);
			setSelectAllModalOpened(false);
		} finally {
			setSelectAllLoading(false);
		}
	};

	const handleSelectAllModalClose = () => {
		setSelectAllModalOpened(false);
	};

	const handleModalExitTransitionEnd = () => {
		// Clear data after modal has fully closed
		setSelectAllResult(null);
		setSelectAllLoading(false);
	};

	// Get selected tag names for display (excluding verified outcomes)
	const selectedTagNames = useMemo(() => {
		const names: string[] = [];
		for (const tagId of selectedTagIds) {
			const tag = allProjectTags.find((t) => t.id === tagId);
			if (tag?.text) {
				names.push(tag.text);
			}
		}
		return names;
	}, [selectedTagIds, allProjectTags]);

	const resetEverything = useCallback(() => {
		setConversationSearch("");
		setSortBy("-created_at");
		// Temporarily disabled source filters
		// setActiveFilters(["PORTAL_AUDIO", "DASHBOARD_UPLOAD"]);
		setShowDuration(true);
		setSelectedTagIds([]);
		setTagSearch("");
		setShowOnlyVerified(false);
		// not sure why only these 2 were needed. biome seems to shut up with these 2. i tried putting all. will need to investigate
	}, [setSortBy, setShowDuration]);

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
							{conversationsCountQuery.isLoading ? (
								<Loader size="xs" />
							) : (
								totalConversations
							)}
						</span>
						<Trans>Conversations</Trans>
					</Title>

					{/** biome-ignore lint/a11y/noStaticElementInteractions: <todo> */}
					{/** biome-ignore lint/a11y/useKeyWithClickEvents: <todo> */}
					<div onClick={(e) => e.stopPropagation()}>
						<UploadConversationDropzone projectId={projectId} />
					</div>
				</Group>
			</Accordion.Control>

			<Accordion.Panel>
				<Stack gap="sm" className="relative">
					{/* Only show auto-select in deep dive mode */}
					{inChatMode &&
						!isOverviewMode &&
						ENABLE_CHAT_AUTO_SELECT &&
						totalConversations > 0 && (
							<Stack gap="xs" className="relative">
								<LoadingOverlay visible={conversationsQuery.isLoading} />
								<AutoSelectConversations />
							</Stack>
						)}

					{!(
						totalConversations === 0 && debouncedConversationSearchValue === ""
					) && (
						<Group justify="space-between" align="center" gap="xs">
							<TextInput
								leftSection={<IconSearch />}
								rightSection={
									!!conversationSearch && (
										<ActionIcon
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
							<Tooltip label={t`Options`}>
								<Box className="relative">
									<ActionIcon
										variant="outline"
										color={filterApplied ? "primary" : "gray"}
										c={filterApplied ? "primary" : "gray"}
										onClick={() => setShowFilterActions((prev) => !prev)}
										aria-label={t`Options`}
									>
										{showFilterActions ? (
											<IconChevronUp size={16} />
										) : (
											<IconChevronDown size={16} />
										)}
									</ActionIcon>
									{appliedFiltersCount > 0 && (
										<Badge
											size="xs"
											variant="filled"
											color="primary"
											className="absolute -right-1 -top-1 px-1"
										>
											{appliedFiltersCount}
										</Badge>
									)}
								</Box>
							</Tooltip>
						</Group>
					)}

					<Box ref={filterActionsParent}>
						{showFilterActions && (
							<Group gap="xs" align="center" mb="sm">
								<Menu
									withArrow
									position="bottom-start"
									shadow="md"
									opened={sortMenuOpened}
									onChange={setSortMenuOpened}
								>
									<Menu.Target>
										<Button
											variant="outline"
											size="xs"
											color="gray"
											fw={500}
											leftSection={<IconArrowsUpDown size={16} />}
											rightSection={
												sortMenuOpened ? (
													<IconChevronUp size={16} />
												) : (
													<IconChevronDown size={16} />
												)
											}
											style={{ flexShrink: 0 }}
										>
											<Trans>Sort</Trans>
										</Button>
									</Menu.Target>
									<Menu.Dropdown>
										<Stack py="md" px="lg" gap="md">
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

								<Menu
									withArrow
									position="bottom-start"
									shadow="md"
									opened={tagsMenuOpened}
									onChange={setTagsMenuOpened}
								>
									<Menu.Target>
										<Button
											variant="outline"
											color="gray"
											size="xs"
											fw={500}
											leftSection={<IconTags size={16} />}
											rightSection={
												tagsMenuOpened ? (
													<IconChevronUp size={16} />
												) : (
													<IconChevronDown size={16} />
												)
											}
											style={{ flexShrink: 0 }}
										>
											{selectedTagIds.length > 0 ? (
												<Group gap={6} wrap="nowrap">
													<Badge
														size="sm"
														variant="light"
														color="primary"
														className="text-xs"
													>
														{selectedTagIds.length}
													</Badge>
													<Trans>Tags</Trans>
												</Group>
											) : (
												<Trans>Tags</Trans>
											)}
										</Button>
									</Menu.Target>
									<Menu.Dropdown>
										<Stack py="md" px="lg" gap="sm" w={280}>
											<TextInput
												placeholder={t`Search tags`}
												value={tagSearch}
												onChange={(e) => setTagSearch(e.currentTarget.value)}
												size="sm"
												rightSection={
													!!tagSearch && (
														<ActionIcon
															variant="transparent"
															onClick={() => setTagSearch("")}
															size="sm"
														>
															<IconX size={16} />
														</ActionIcon>
													)
												}
											/>

											{selectedTagIds.length > 0 && (
												<Group gap="xs" wrap="wrap" mt="sm">
													{selectedTagIds.map((tagId) => {
														const tag = allProjectTags.find(
															(t) => t.id === tagId,
														);
														if (!tag) return null;
														return (
															<Pill
																key={tagId}
																size="sm"
																withRemoveButton
																classNames={{
																	root: "!bg-[var(--mantine-primary-color-light)] !font-medium",
																}}
																onRemove={() =>
																	setSelectedTagIds((prev) =>
																		prev.filter((id) => id !== tagId),
																	)
																}
															>
																{tag.text}
															</Pill>
														);
													})}
												</Group>
											)}

											<Divider my="sm" />

											{projectTagsLoading ? (
												<Center h={220}>
													<Loader size="sm" />
												</Center>
											) : (
												<ScrollArea h={220} type="always" scrollbars="y">
													<Stack gap="sm">
														{filteredProjectTags.map((tag) => {
															const checked = selectedTagIds.includes(tag.id);
															return (
																<Checkbox
																	key={tag.id}
																	checked={checked}
																	label={tag.text}
																	onChange={(e) => {
																		const isChecked = e.currentTarget.checked;
																		setSelectedTagIds((prev) => {
																			if (isChecked) {
																				if (prev.includes(tag.id)) return prev;
																				return [...prev, tag.id];
																			}
																			return prev.filter((id) => id !== tag.id);
																		});
																	}}
																	styles={{
																		labelWrapper: {
																			width: "100%",
																		},
																	}}
																/>
															);
														})}
														{filteredProjectTags.length === 0 && (
															<Text size="sm" ta="center" c="dimmed">
																<Trans>No tags found</Trans>
															</Text>
														)}
													</Stack>
												</ScrollArea>
											)}
										</Stack>
									</Menu.Dropdown>
								</Menu>

								<Button
									variant={showOnlyVerified ? "filled" : "outline"}
									color={showOnlyVerified ? "blue" : "gray"}
									size="xs"
									fw={500}
									leftSection={<IconRosetteDiscountCheckFilled size={16} />}
									onClick={() => setShowOnlyVerified((prev) => !prev)}
									style={{ flexShrink: 0 }}
								>
									<Trans id="conversation.filters.verified.text">
										Verified
									</Trans>
								</Button>

								<Tooltip label={t`Reset to default`}>
									<ActionIcon
										variant="outline"
										color="gray"
										onClick={resetEverything}
										aria-label={t`Reset to default`}
										disabled={!filterApplied}
										size="md"
										py={14}
										style={{ flexShrink: 0, marginLeft: "auto" }}
									>
										<IconX size={16} />
									</ActionIcon>
								</Tooltip>
							</Group>
						)}
					</Box>

					{/* Select All - show in deep dive mode, disable when all relevant conversations are in context */}
					{ENABLE_CHAT_SELECT_ALL &&
						inChatMode &&
						chatMode === "deep_dive" &&
						allConversations.length > 0 && (
							<Tooltip
								label={
									remainingCount === 0
										? t`You have already added all the conversations related to this`
										: ""
								}
								disabled={remainingCount > 0}
							>
								<Button
									variant="light"
									size="sm"
									fullWidth
									leftSection={<IconSelectAll size={16} />}
									onClick={handleSelectAllClick}
									disabled={selectAllMutation.isPending || remainingCount === 0}
									loading={selectAllMutation.isPending}
								>
									{shouldShowConversationCount ? (
										<Trans>Select all ({remainingCount})</Trans>
									) : (
										<Trans>Select all</Trans>
									)}
								</Button>
							</Tooltip>
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

					{allConversations.length === 0 && !conversationsQuery.isLoading && (
						<Text size="sm">
							<Trans>
								No conversations found. Start a conversation using the
								participation invite link from the{" "}
								<I18nLink to={`/projects/${projectId}/overview`}>
									<Anchor
										onClick={(e) => {
											if (qrCodeRef?.current && isMobile) {
												e.preventDefault();
												qrCodeRef.current.scrollIntoView({
													behavior: "smooth",
													block: "center",
												});
											}
										}}
									>
										project overview.
									</Anchor>
								</I18nLink>
							</Trans>
						</Text>
					)}

					<Stack gap="xs" mt="sm" className="relative">
						{conversationsQuery.status === "pending" && (
							<BaseSkeleton count={3} height="80px" width="100%" radius="xs" />
						)}
						{allConversations.map((item, index) => (
							<div
								key={item.id}
								ref={
									index === allConversations.length - 1
										? loadMoreRef
										: undefined
								}
							>
								<ConversationAccordionItem
									highlight={item.id === activeConversationId}
									conversation={
										(item as Conversation & { live: boolean }) ?? null
									}
									showDuration={showDuration}
									onTagClick={handleTagClick}
								/>
							</div>
						))}
						{conversationsQuery.isFetchingNextPage && (
							<Center py="md">
								<Loader size="sm" color={MODE_COLORS.deep_dive.primary} />
							</Center>
						)}
						{/* {!conversationsQuery.hasNextPage &&
              allConversations.length > 0 &&
              debouncedConversationSearchValue === "" && (
                <Center py="md">
                  <Text size="xs" c="dimmed" ta="center" fs="italic">
                    <Trans>
                      End of list • All{" "}
                      {totalConversations ?? allConversations.length}{" "}
                      conversations loaded
                    </Trans>
                  </Text>
                </Center>
              )} */}
						{/* Temporarily disabled source filters */}
						{/* {allConversations.length === 0 &&
              filterBySource.length === 0 && (
                <Text size="sm">
                  <Trans>Please select at least one source</Trans>
                </Text>
              )} */}
					</Stack>
				</Stack>

				{/* Select All Confirmation Modal */}
				{ENABLE_CHAT_SELECT_ALL && (
					<SelectAllConfirmationModal
						opened={selectAllModalOpened}
						onClose={handleSelectAllModalClose}
						onExitTransitionEnd={handleModalExitTransitionEnd}
						onConfirm={handleSelectAllConfirm}
						totalCount={remainingCount}
						hasFilters={hasActiveFilters}
						isLoading={selectAllLoading}
						existingContextCount={conversationsInContext.size}
						filterNames={selectedTagNames}
						hasVerifiedOutcomesFilter={showOnlyVerified}
						searchText={debouncedConversationSearchValue || undefined}
						result={
							selectAllResult
								? {
										added: selectAllResult.added,
										contextLimitReached: selectAllResult.context_limit_reached,
										skipped: selectAllResult.skipped,
									}
								: null
						}
					/>
				)}

				{/* Add Tag Filter Modal */}
				{ENABLE_CHAT_SELECT_ALL && (
					<AddTagFilterModal
						opened={addTagFilterModalOpened}
						onClose={addTagFilterModalHandlers.close}
						onExitTransitionEnd={handleTagFilterModalExitTransitionEnd}
						onConfirm={handleAddTagFilter}
						tagName={
							(selectedTagForFilter?.project_tag_id as ProjectTag)?.text ?? ""
						}
					/>
				)}
			</Accordion.Panel>
		</Accordion.Item>
	);
};
