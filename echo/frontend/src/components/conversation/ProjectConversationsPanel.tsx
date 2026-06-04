import type { Query } from "@directus/sdk";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Badge,
	Box,
	Button,
	Center,
	Checkbox,
	Divider,
	Group,
	Loader,
	Modal,
	MultiSelect,
	Paper,
	Select,
	Skeleton,
	Stack,
	Switch,
	Text,
	TextInput,
	ThemeIcon,
	Title,
	Tooltip,
} from "@mantine/core";
import { useDebouncedValue, useDisclosure } from "@mantine/hooks";
import { DetectiveIcon } from "@phosphor-icons/react";
import {
	IconEdit,
	IconExternalLink,
	IconInfoCircle,
	IconLock,
	IconRosetteDiscountCheck,
	IconSearch,
	IconSelectAll,
	IconUpload,
	IconX,
} from "@tabler/icons-react";
import { formatDistanceToNowStrict } from "date-fns";
import { useEffect, useMemo, useState } from "react";
import { useInView } from "react-intersection-observer";
import { useIsMutating } from "@tanstack/react-query";
import { useProjectChatContext } from "@/components/chat/hooks";
import { toast } from "@/components/common/Toaster";
import { AutoSelectConversations } from "@/components/conversation/AutoSelectConversations";
import { SelectAllConfirmationModal } from "@/components/conversation/SelectAllConfirmationModal";
import { UploadConversationDropzone } from "@/components/dropzone/UploadConversationDropzone";
import { useProjectById } from "@/components/project/hooks";
import { UploadLockedCard } from "@/components/project/UploadLockedCard";
import { ENABLE_CHAT_AUTO_SELECT, ENABLE_CHAT_SELECT_ALL } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useWorkspaceUsage } from "@/hooks/useWorkspaceUsage";
import { testId } from "@/lib/testUtils";
import { ConversationStatusIndicators } from "./ConversationAccordion";
import { ConversationEdit } from "./ConversationEdit";
import {
	useAddChatContextMutation,
	useConversationsCountByProjectId,
	useDeleteChatContextMutation,
	useInfiniteConversationsByProjectId,
	useRemainingConversationsCount,
	useSelectAllContextMutation,
} from "./hooks";

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

type ProjectConversationsPanelProps = {
	projectId: string;
	workspaceId?: string | null;
	selectionChatId?: string;
	selectionMode?: boolean;
	showUpload?: boolean;
};

const lineClampStyle = {
	display: "-webkit-box",
	overflow: "hidden",
	WebkitBoxOrient: "vertical",
	WebkitLineClamp: 2,
} as const;

const SORT_OPTIONS: SortOption[] = [
	{ label: t`Newest first`, value: "-created_at" },
	{ label: t`Oldest first`, value: "created_at" },
	{ label: t`Name A-Z`, value: "participant_name" },
	{ label: t`Name Z-A`, value: "-participant_name" },
	{ label: t`Longest first`, value: "-duration" },
	{ label: t`Shortest first`, value: "duration" },
];

const getTagText = (tag: ConversationProjectTag) => {
	const projectTag = tag.project_tag_id as ProjectTag | string | null;
	return typeof projectTag === "object" && projectTag ? projectTag.text : null;
};

const hasTranscriptContent = (conversation: Conversation) =>
	conversation.chunks?.some((chunk) => {
		const transcript = (chunk as ConversationChunk).transcript;
		return typeof transcript === "string" && transcript.trim().length > 0;
	}) ?? false;

const hasVerifiedArtifacts = (conversation: Conversation) =>
	conversation.conversation_artifacts?.some(
		(artifact) => (artifact as ConversationArtifact).approved_at,
	) ?? false;

const formatCreatedAt = (createdAt: string | null) => {
	if (!createdAt) return t`Unknown date`;
	return t`${formatDistanceToNowStrict(new Date(createdAt), {
		addSuffix: true,
	})}`;
};

const ConversationSelectionCheckbox = ({
	conversation,
	chatId,
}: {
	conversation: Conversation;
	chatId: string;
}) => {
	const chatContextQuery = useProjectChatContext(chatId);
	const addChatContextMutation = useAddChatContextMutation();
	const deleteChatContextMutation = useDeleteChatContextMutation();
	// Global mutation cache so pending state survives modal unmount/remount.
	const globalPendingForRow = useIsMutating({
		mutationKey: ["chat-context"],
		predicate: (mutation) => {
			const vars = mutation.state.variables as
				| { chatId?: string; conversationId?: string }
				| undefined;
			return (
				vars?.chatId === chatId && vars?.conversationId === conversation.id
			);
		},
	});
	const isPending =
		chatContextQuery.isLoading ||
		globalPendingForRow > 0 ||
		addChatContextMutation.isPending ||
		deleteChatContextMutation.isPending;

	if (isPending) {
		return (
			<Tooltip label={t`Loading...`}>
				<Loader size="xs" color={MODE_COLOR} />
			</Tooltip>
		);
	}

	const isSelected = !!chatContextQuery.data?.conversations?.some(
		(c) => c.conversation_id === conversation.id,
	);
	const isChatLocked = !!chatContextQuery.data?.conversations?.some(
		(c) => c.conversation_id === conversation.id && c.locked,
	);
	const isOverCapLocked = !!conversation.locked;
	const hasContent = hasTranscriptContent(conversation);
	const isDisabled = isChatLocked || isOverCapLocked || !hasContent;

	const tooltipLabel = isOverCapLocked
		? t`Conversation locked. Upgrade to add it.`
		: isChatLocked
			? t`Already used in this chat`
			: !hasContent
				? t`This conversation has no transcript yet`
				: isSelected
					? t`Remove from chat`
					: t`Add to chat`;

	const handleChange = () => {
		if (isSelected) {
			deleteChatContextMutation.mutate({
				chatId,
				conversationId: conversation.id,
			});
			return;
		}
		if (!isDisabled) {
			addChatContextMutation.mutate({
				chatId,
				conversationId: conversation.id,
			});
		}
	};

	return (
		<Tooltip label={tooltipLabel}>
			<span>
				<Checkbox
					aria-label={isSelected ? t`Remove from chat` : t`Add to chat`}
					checked={isSelected}
					disabled={isDisabled}
					onChange={handleChange}
					color={MODE_COLOR}
					{...testId(`conversation-picker-checkbox-${conversation.id}`)}
				/>
			</span>
		</Tooltip>
	);
};

const MODE_COLOR = "blue";

type ConversationRowProps = {
	conversation: Conversation & { live?: boolean };
	isActive?: boolean;
	isSelected?: boolean;
	onEdit: (conversation: Conversation) => void;
	onOpen: (conversation: Conversation) => void;
	selectionChatId?: string;
	selectionMode?: boolean;
};

const ConversationRow = ({
	conversation,
	isActive,
	isSelected,
	onEdit,
	onOpen,
	selectionChatId,
	selectionMode,
}: ConversationRowProps) => {
	const primary =
		conversation.title?.trim() ||
		conversation.participant_name?.trim() ||
		t`Untitled conversation`;
	const participantLabel = conversation.participant_name?.trim() || t`No name`;
	const summary = conversation.summary?.trim();
	const tags =
		(conversation.tags as ConversationProjectTag[] | undefined) ?? [];
	const verified = hasVerifiedArtifacts(conversation);

	return (
		<Paper
			withBorder
			radius="sm"
			p="md"
			style={{
				background: isSelected ? "rgba(65, 105, 225, 0.06)" : "white",
				borderColor: isActive || isSelected ? "#4169e1" : undefined,
			}}
			{...testId(`project-conversation-row-${conversation.id}`)}
		>
			<Group align="flex-start" gap="md" wrap="nowrap">
				{selectionMode && selectionChatId && (
					<Box pt={4}>
						<ConversationSelectionCheckbox
							conversation={conversation}
							chatId={selectionChatId}
						/>
					</Box>
				)}

				<Stack gap="xs" style={{ flex: 1, minWidth: 0 }}>
					<Group justify="space-between" align="flex-start" wrap="nowrap">
						<Stack gap={2} style={{ minWidth: 0 }}>
							<Group gap="xs" wrap="nowrap">
								<Text size="sm" fw={500} truncate style={{ color: "#2d2d2c" }}>
									{primary}
								</Text>
								{conversation.title && conversation.participant_name && (
									<Tooltip label={t`Title generated from the conversation`}>
										<IconInfoCircle
											size={14}
											style={{ color: "#8a8f98", flexShrink: 0 }}
										/>
									</Tooltip>
								)}
								{verified && (
									<Tooltip label={t`Has verified artifacts`}>
										<ThemeIcon
											variant="subtle"
											color="blue"
											size={18}
											aria-label={t`Verified artifacts`}
										>
											<IconRosetteDiscountCheck size={16} />
										</ThemeIcon>
									</Tooltip>
								)}
								{conversation.is_anonymized && (
									<Tooltip label={t`Anonymized conversation`}>
										<ThemeIcon
											variant="subtle"
											color="blue"
											size={18}
											aria-label={t`Anonymized conversation`}
										>
											<DetectiveIcon size={16} />
										</ThemeIcon>
									</Tooltip>
								)}
								{conversation.locked && (
									<Tooltip
										label={t`Upgrade your workspace to view this conversation`}
									>
										<Badge
											size="xs"
											color="blue"
											variant="light"
											leftSection={<IconLock size={10} />}
										>
											<Trans>Locked</Trans>
										</Badge>
									</Tooltip>
								)}
							</Group>

							<Group gap="xs" wrap="wrap">
								<Tooltip
									label={conversation.participant_email ?? undefined}
									disabled={!conversation.participant_email}
								>
									<Text size="xs" c="dimmed">
										{participantLabel}
									</Text>
								</Tooltip>
								<Text size="xs" c="dimmed">
									{formatCreatedAt(conversation.created_at)}
								</Text>
								{conversation.live && (
									<Badge size="xs" color="red" variant="light">
										<Trans>Ongoing</Trans>
									</Badge>
								)}
								<ConversationStatusIndicators
									conversation={conversation}
									showDuration
								/>
							</Group>
						</Stack>

						<Group gap="xs" wrap="nowrap">
							{!selectionMode && (
								<Tooltip label={t`Edit details`}>
									<ActionIcon
										variant="subtle"
										color="gray"
										aria-label={t`Edit details`}
										onClick={() => onEdit(conversation)}
									>
										<IconEdit size={16} />
									</ActionIcon>
								</Tooltip>
							)}
							<Tooltip label={t`Open conversation`}>
								<ActionIcon
									variant="subtle"
									color="blue"
									aria-label={t`Open conversation`}
									onClick={() => onOpen(conversation)}
								>
									<IconExternalLink size={16} />
								</ActionIcon>
							</Tooltip>
						</Group>
					</Group>

					<Text
						size="sm"
						c={summary ? "gray.7" : "dimmed"}
						style={lineClampStyle}
					>
						{summary || <Trans>No summary yet</Trans>}
					</Text>

					{tags.length > 0 && (
						<Group gap={6} wrap="wrap">
							{tags.map((tag) => {
								const tagText = getTagText(tag);
								if (!tagText) return null;
								return (
									<Badge
										key={tag.id}
										size="xs"
										variant="light"
										color="gray"
										radius="sm"
									>
										{tagText}
									</Badge>
								);
							})}
						</Group>
					)}
				</Stack>
			</Group>
		</Paper>
	);
};

export const ProjectConversationsPanel = ({
	projectId,
	workspaceId,
	selectionChatId,
	selectionMode = false,
	showUpload = false,
}: ProjectConversationsPanelProps) => {
	const navigate = useI18nNavigate();
	const { ref: loadMoreRef, inView } = useInView();
	const [search, setSearch] = useState("");
	const [debouncedSearch] = useDebouncedValue(search, 200);
	const [sortBy, setSortBy] = useState<SortOption["value"]>("-created_at");
	const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
	const [showOnlyVerified, setShowOnlyVerified] = useState(false);
	const [selectAllModalOpened, setSelectAllModalOpened] = useState(false);
	const [selectAllResult, setSelectAllResult] =
		useState<SelectAllContextResponse | null>(null);
	const [selectAllLoading, setSelectAllLoading] = useState(false);
	const [editOpened, editHandlers] = useDisclosure(false);
	const [editingConversation, setEditingConversation] =
		useState<Conversation | null>(null);

	const projectQuery = useProjectById({
		projectId,
		query: {
			deep: {
				tags: {
					_sort: "sort",
				},
			},
			fields: [
				"id",
				"workspace_id",
				{
					tags: ["id", "text", "sort"],
				},
			],
		},
	});
	const resolvedWorkspaceId =
		workspaceId ??
		(projectQuery.data as { workspace_id?: string | null } | undefined)
			?.workspace_id ??
		null;
	const { usageGates } = useWorkspaceUsage(resolvedWorkspaceId);
	const selectAllMutation = useSelectAllContextMutation();

	const allProjectTags = useMemo(
		() =>
			((projectQuery.data as Project | undefined)?.tags as ProjectTag[]) ?? [],
		[projectQuery.data],
	);
	const tagOptions = useMemo(() => {
		const options: { label: string; value: string }[] = [];
		for (const tag of allProjectTags) {
			if (tag.id && tag.text) {
				options.push({ label: tag.text, value: tag.id });
			}
		}
		return options;
	}, [allProjectTags]);

	const conversationQuery = useMemo(
		() =>
			({
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
				search: debouncedSearch,
				sort: sortBy,
			}) as Partial<Query<CustomDirectusTypes, Conversation>>,
		[projectId, selectedTagIds, showOnlyVerified, debouncedSearch, sortBy],
	);

	const conversationsQuery = useInfiniteConversationsByProjectId(
		projectId,
		true,
		false,
		conversationQuery,
		undefined,
		{
			initialLimit: selectionMode ? 12 : 20,
		},
	);
	const conversationsCountQuery = useConversationsCountByProjectId(
		projectId,
		conversationQuery,
	);

	const allConversations =
		conversationsQuery.data?.pages.flatMap((page) => page.conversations) ?? [];

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

	const chatContextQuery = useProjectChatContext(selectionChatId ?? "");
	const selectedConversationIds = useMemo(
		() =>
			new Set(
				(chatContextQuery.data?.conversations ?? []).map(
					(c) => c.conversation_id,
				),
			),
		[chatContextQuery.data?.conversations],
	);
	const chatMode = chatContextQuery.data?.chat_mode;
	const hasActiveFilters =
		selectedTagIds.length > 0 || showOnlyVerified || debouncedSearch !== "";
	const selectedTagNames = useMemo(() => {
		return selectedTagIds
			.map((id) => allProjectTags.find((tag) => tag.id === id)?.text)
			.filter(Boolean) as string[];
	}, [selectedTagIds, allProjectTags]);

	const remainingCountQuery = useRemainingConversationsCount(
		projectId,
		selectionChatId,
		{
			searchText: debouncedSearch || undefined,
			tagIds: selectedTagIds.length > 0 ? selectedTagIds : undefined,
			verifiedOnly: showOnlyVerified || undefined,
		},
		{
			enabled:
				selectionMode &&
				ENABLE_CHAT_SELECT_ALL &&
				chatMode === "deep_dive" &&
				!!selectionChatId,
		},
	);
	const remainingCount =
		remainingCountQuery.data ??
		allConversations.filter((c) => !selectedConversationIds.has(c.id)).length;

	const openConversation = (conversation: Conversation) => {
		if (!resolvedWorkspaceId) return;
		navigate(
			`/w/${resolvedWorkspaceId}/projects/${projectId}/conversation/${conversation.id}`,
		);
	};

	const openEdit = (conversation: Conversation) => {
		setEditingConversation(conversation);
		editHandlers.open();
	};

	const closeEdit = () => {
		editHandlers.close();
		setEditingConversation(null);
	};

	const resetFilters = () => {
		setSearch("");
		setSelectedTagIds([]);
		setShowOnlyVerified(false);
		setSortBy("-created_at");
	};

	const handleSelectAllConfirm = async () => {
		if (!selectionChatId) return;
		setSelectAllLoading(true);
		try {
			const result = await selectAllMutation.mutateAsync({
				chatId: selectionChatId,
				projectId,
				searchText: debouncedSearch || undefined,
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

	const activeFiltersCount =
		selectedTagIds.length + (showOnlyVerified ? 1 : 0) + (search ? 1 : 0);

	return (
		<Stack gap="lg">
			<Stack gap="md">
				<Group justify="space-between" align="flex-start" gap="md">
					<Stack gap={4}>
						<Group gap="sm" align="baseline">
							<Title order={selectionMode ? 3 : 2} fw={500}>
								<Trans>Conversations</Trans>
							</Title>
							{conversationsCountQuery.isLoading ? (
								<Loader size="xs" />
							) : (
								<Badge variant="light" color="gray">
									{conversationsCountQuery.data ?? 0}
								</Badge>
							)}
						</Group>
						<Text size="sm" c="dimmed">
							{selectionMode ? (
								<Trans>
									Search and choose the conversations for this chat.
								</Trans>
							) : (
								<Trans>
									Review, edit, and open every conversation in this project.
								</Trans>
							)}
						</Text>
					</Stack>

					{showUpload && (
						<Box>
							{usageGates.uploads_locked ? (
								<Tooltip
									label={t`Upload limit reached. Upgrade your workspace.`}
								>
									<Button
										variant="outline"
										disabled
										leftSection={<IconUpload size={16} />}
									>
										<Trans>Upload</Trans>
									</Button>
								</Tooltip>
							) : (
								<UploadConversationDropzone projectId={projectId} />
							)}
						</Box>
					)}
				</Group>

				{showUpload && usageGates.uploads_locked && resolvedWorkspaceId && (
					<UploadLockedCard
						workspaceId={resolvedWorkspaceId}
						upgradeTier={usageGates.upgrade_cta_tier}
					/>
				)}

				{selectionMode &&
					ENABLE_CHAT_AUTO_SELECT &&
					chatMode !== "overview" &&
					(conversationsCountQuery.data ?? 0) > 0 && (
						<AutoSelectConversations />
					)}

				<Paper withBorder radius="sm" p="sm">
					<Group gap="sm" align="flex-end">
						<TextInput
							label={t`Search`}
							placeholder={t`Title or participant`}
							leftSection={<IconSearch size={16} />}
							rightSection={
								search ? (
									<ActionIcon
										variant="transparent"
										aria-label={t`Clear search`}
										onClick={() => setSearch("")}
									>
										<IconX size={16} />
									</ActionIcon>
								) : undefined
							}
							value={search}
							onChange={(event) => setSearch(event.currentTarget.value)}
							style={{ flex: "1 1 260px" }}
							{...testId("project-conversations-search")}
						/>
						<Select
							label={t`Sort`}
							value={sortBy}
							onChange={(value) =>
								value && setSortBy(value as SortOption["value"])
							}
							data={SORT_OPTIONS}
							allowDeselect={false}
							style={{ flex: "0 1 190px" }}
						/>
						<MultiSelect
							label={t`Tags`}
							placeholder={t`Any tag`}
							value={selectedTagIds}
							onChange={setSelectedTagIds}
							data={tagOptions}
							searchable
							clearable
							style={{ flex: "1 1 220px" }}
						/>
						<Switch
							label={t`Verified`}
							checked={showOnlyVerified}
							onChange={(event) =>
								setShowOnlyVerified(event.currentTarget.checked)
							}
							styles={{ root: { paddingBottom: 7 } }}
						/>
						<Tooltip label={t`Reset filters`}>
							<ActionIcon
								variant="subtle"
								color="gray"
								aria-label={t`Reset filters`}
								disabled={activeFiltersCount === 0 && sortBy === "-created_at"}
								onClick={resetFilters}
								mb={4}
							>
								<IconX size={16} />
							</ActionIcon>
						</Tooltip>
					</Group>
				</Paper>

				{selectionMode &&
					ENABLE_CHAT_SELECT_ALL &&
					chatMode === "deep_dive" &&
					allConversations.length > 0 && (
						<Button
							variant="outline"
							leftSection={<IconSelectAll size={16} />}
							onClick={() => {
								setSelectAllResult(null);
								setSelectAllModalOpened(true);
							}}
							disabled={remainingCount === 0 || selectAllMutation.isPending}
							loading={selectAllMutation.isPending}
							{...testId("conversation-select-all-button")}
						>
							{remainingCount > 0 ? (
								<Trans>Select all visible ({remainingCount})</Trans>
							) : selectedConversationIds.size > 0 ? (
								<Trans>All visible conversations selected</Trans>
							) : (
								<Trans>No selectable conversations</Trans>
							)}
						</Button>
					)}
			</Stack>

			<Divider />

			<Stack gap="sm">
				{conversationsQuery.isLoading && (
					<>
						<Skeleton height={98} radius="sm" />
						<Skeleton height={98} radius="sm" />
						<Skeleton height={98} radius="sm" />
					</>
				)}

				{!conversationsQuery.isLoading && allConversations.length === 0 && (
					<Paper withBorder radius="sm" p="xl">
						<Stack gap="xs" align="center">
							<Text size="sm" c="dimmed" ta="center">
								{hasActiveFilters ? (
									<Trans>No conversations match these filters.</Trans>
								) : (
									<Trans>No conversations yet.</Trans>
								)}
							</Text>
							{hasActiveFilters && (
								<Button variant="subtle" size="xs" onClick={resetFilters}>
									<Trans>Clear filters</Trans>
								</Button>
							)}
						</Stack>
					</Paper>
				)}

				{allConversations.map((conversation, index) => (
					<div
						key={conversation.id}
						ref={
							index === allConversations.length - 1 ? loadMoreRef : undefined
						}
					>
						<ConversationRow
							conversation={conversation as Conversation & { live?: boolean }}
							isSelected={selectedConversationIds.has(conversation.id)}
							onEdit={openEdit}
							onOpen={openConversation}
							selectionChatId={selectionChatId}
							selectionMode={selectionMode}
						/>
					</div>
				))}

				{conversationsQuery.isFetchingNextPage && (
					<Center py="md">
						<Loader size="sm" />
					</Center>
				)}
			</Stack>

			<Modal
				opened={editOpened}
				onClose={closeEdit}
				size="lg"
				{...testId("conversation-edit-modal")}
			>
				{editingConversation && (
					<ConversationEdit
						key={editingConversation.id}
						conversation={editingConversation}
						projectTags={allProjectTags}
						showSummary
					/>
				)}
			</Modal>

			{selectionMode && ENABLE_CHAT_SELECT_ALL && (
				<SelectAllConfirmationModal
					opened={selectAllModalOpened}
					onClose={() => setSelectAllModalOpened(false)}
					onExitTransitionEnd={() => {
						setSelectAllResult(null);
						setSelectAllLoading(false);
					}}
					onConfirm={handleSelectAllConfirm}
					totalCount={remainingCount}
					hasFilters={hasActiveFilters}
					isLoading={selectAllLoading}
					existingContextCount={selectedConversationIds.size}
					filterNames={selectedTagNames}
					hasVerifiedOutcomesFilter={showOnlyVerified}
					searchText={debouncedSearch || undefined}
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
		</Stack>
	);
};
