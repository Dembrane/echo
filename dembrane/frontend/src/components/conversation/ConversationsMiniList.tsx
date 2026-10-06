import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Badge,
	Box,
	Button,
	Center,
	Checkbox,
	Group,
	Loader,
	MultiSelect,
	Popover,
	Select,
	Skeleton,
	Stack,
	Switch,
	Text,
	TextInput,
	Title,
	UnstyledButton,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
	DotsThreeIcon,
	MagnifyingGlassIcon,
	SealCheckIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { I18nLink } from "@/components/common/i18nLink";
import { UpgradeModal } from "@/components/workspace/FeatureGate";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useWorkspace } from "@/hooks/useWorkspace";
import { canUseChat } from "@/lib/roles";
import { testId } from "@/lib/testUtils";
import { SELLABLE_TIER, type Tier } from "@/lib/tiers";
import {
	type ConversationSort,
	formatStartedAt,
	getTagText,
	hasVerifiedArtifacts,
	SORT_OPTIONS,
	useConversationList,
} from "./useConversationList";
import { getConversationStartTime } from "./utils";

type MiniConversation = Conversation & { live?: boolean };

const formatDuration = (seconds: number) => {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = Math.floor(seconds % 60);
	const pad = (n: number) => n.toString().padStart(2, "0");
	return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
};

/** Live (red) first, then what the host would act on. */
const ConversationStatus = ({
	conversation,
}: {
	conversation: MiniConversation;
}) => {
	if (conversation.live)
		return (
			<Group gap={4} wrap="nowrap" c="red">
				<Box w={8} h={8} bg="red" className="rounded-full" />
				<Text size="xs" c="red">
					<Trans>Live</Trans>
				</Text>
			</Group>
		);
	if (conversation.has_transcription_error)
		return (
			<Text size="xs" c="red">
				<Trans>Transcription error</Trans>
			</Text>
		);
	const isTranscribing =
		!conversation.has_only_text_chunks &&
		(conversation.is_finished === false ||
			conversation.is_all_chunks_transcribed === false);
	if (isTranscribing)
		return (
			<Text size="xs" c="dimmed">
				<Trans>Transcribing</Trans>
			</Text>
		);
	if (hasVerifiedArtifacts(conversation))
		return (
			<Group gap={4} wrap="nowrap">
				<SealCheckIcon size={16} />
				<Text size="xs">
					<Trans>Verified</Trans>
				</Text>
			</Group>
		);
	return (
		<Text size="xs" c="dimmed">
			<Trans>Done</Trans>
		</Text>
	);
};

type ConversationsMiniListProps = {
	projectId: string;
	workspaceId: string;
	/** Shows the "Conversations" title and count above the list. */
	withTitle?: boolean;
};

/** The project's conversations, newest first, always selectable: tick some
 * and "Ask about these" starts a chat on them. Filters sit behind "…". */
export const ConversationsMiniList = ({
	projectId,
	workspaceId,
	withTitle = false,
}: ConversationsMiniListProps) => {
	const navigate = useI18nNavigate();
	const { workspace } = useWorkspace();
	const canAsk = !!workspace && canUseChat(workspace.role);
	const [selection, setSelection] = useState<string[]>([]);
	const [upgradeOpened, upgradeHandlers] = useDisclosure(false);
	const list = useConversationList(projectId, { pageSize: 10 });
	const base = `/w/${workspaceId}/projects/${projectId}`;

	const toggle = (id: string) =>
		setSelection((current) =>
			current.includes(id)
				? current.filter((other) => other !== id)
				: [...current, id],
		);

	const filtersChanged =
		list.activeFiltersCount > 0 || list.sortBy !== "-created_at";

	return (
		<Stack gap="md" style={{ minWidth: 0 }}>
			<Group gap="xs" align="center">
				{withTitle && (
					<>
						<Title order={4}>
							<Trans>Conversations</Trans>
						</Title>
						{list.conversationsCountQuery.data !== undefined && (
							<Badge color="gray">{list.conversationsCountQuery.data}</Badge>
						)}
					</>
				)}
				<Popover position="bottom-start" width={320} shadow="md">
					<Popover.Target>
						<ActionIcon
							variant="subtle"
							color="gray"
							aria-label={t`Filter and sort`}
							{...testId("mini-conversations-filters")}
						>
							<DotsThreeIcon size={20} />
						</ActionIcon>
					</Popover.Target>
					<Popover.Dropdown>
						<Stack gap="md">
							<TextInput
								label={t`Search`}
								placeholder={t`Title or participant`}
								leftSection={<MagnifyingGlassIcon size={16} />}
								value={list.search}
								onChange={(event) => list.setSearch(event.currentTarget.value)}
							/>
							<Select
								label={t`Sort`}
								value={list.sortBy}
								onChange={(value) =>
									value && list.setSortBy(value as ConversationSort)
								}
								data={SORT_OPTIONS}
								allowDeselect={false}
								comboboxProps={{ withinPortal: false }}
							/>
							<MultiSelect
								label={t`Tags`}
								placeholder={t`Any tag`}
								value={list.selectedTagIds}
								onChange={list.setSelectedTagIds}
								data={list.tagOptions}
								searchable
								clearable
								comboboxProps={{ withinPortal: false }}
							/>
							<Switch
								label={t`Verified`}
								checked={list.showOnlyVerified}
								onChange={(event) =>
									list.setShowOnlyVerified(event.currentTarget.checked)
								}
							/>
							{filtersChanged && (
								<Box>
									<Button
										variant="subtle"
										color="gray"
										onClick={list.resetFilters}
									>
										<Trans>Reset filters</Trans>
									</Button>
								</Box>
							)}
						</Stack>
					</Popover.Dropdown>
				</Popover>
				{list.activeFiltersCount > 0 && (
					<Text size="sm" c="dimmed">
						<Plural
							value={list.activeFiltersCount}
							one="# filter"
							other="# filters"
						/>
					</Text>
				)}
				{/* In the title row, so ticking a row never moves the list. */}
				{canAsk && selection.length > 0 && (
					<>
						<Button
							variant="filled"
							onClick={() =>
								navigate(`${base}/chats/new`, {
									state: { selectedConversationIds: selection },
								})
							}
							{...testId("mini-conversations-ask")}
						>
							<Plural
								value={selection.length}
								one="Ask about this"
								other="Ask about these (#)"
							/>
						</Button>
						<Button
							variant="subtle"
							color="gray"
							onClick={() => setSelection([])}
						>
							<Trans>Clear</Trans>
						</Button>
					</>
				)}
			</Group>

			{list.conversationsQuery.isLoading ? (
				<Stack gap={0}>
					<Skeleton height={72} />
					<Skeleton height={72} />
					<Skeleton height={72} />
				</Stack>
			) : list.allConversations.length === 0 ? (
				<Stack gap="sm" align="flex-start">
					<Text size="sm" c="dimmed">
						{list.hasActiveFilters ? (
							<Trans>No conversations match these filters.</Trans>
						) : (
							<Trans>No conversations yet.</Trans>
						)}
					</Text>
					{list.hasActiveFilters && (
						<Button size="xs" onClick={list.resetFilters}>
							<Trans>Clear filters</Trans>
						</Button>
					)}
				</Stack>
			) : (
				<Stack gap={0}>
					{list.allConversations.map((conversation, index) => (
						<MiniRow
							key={conversation.id}
							conversation={conversation as MiniConversation}
							href={`${base}/conversations/${conversation.id}`}
							selectable={canAsk}
							selected={selection.includes(conversation.id)}
							onToggle={() => toggle(conversation.id)}
							onLocked={upgradeHandlers.open}
							rowRef={
								index === list.allConversations.length - 1
									? list.loadMoreRef
									: undefined
							}
						/>
					))}
				</Stack>
			)}

			{list.conversationsQuery.isFetchingNextPage && (
				<Center py="sm">
					<Loader size="sm" />
				</Center>
			)}

			<UpgradeModal
				opened={upgradeOpened}
				onClose={upgradeHandlers.close}
				currentTier={(workspace?.tier ?? "free") as Tier}
				requiredTier={SELLABLE_TIER}
				canRequestUpgrade={
					workspace?.role === "admin" || workspace?.role === "owner"
				}
				workspaceId={workspaceId}
				wallKey="transcription_cap"
				projectId={projectId}
			/>
		</Stack>
	);
};

const MiniRow = ({
	conversation,
	href,
	selectable,
	selected,
	onToggle,
	onLocked,
	rowRef,
}: {
	conversation: MiniConversation;
	href: string;
	selectable: boolean;
	selected: boolean;
	onToggle: () => void;
	onLocked: () => void;
	rowRef?: (node?: Element | null) => void;
}) => {
	const title =
		conversation.title?.trim() ||
		conversation.participant_name?.trim() ||
		t`Untitled conversation`;
	const tags =
		(conversation.tags as ConversationProjectTag[] | undefined) ?? [];
	const isLocked = !!conversation.locked;
	const when = formatStartedAt(getConversationStartTime(conversation));
	const duration =
		conversation.duration && conversation.duration > 0
			? formatDuration(conversation.duration)
			: null;

	// The whole row opens the conversation: the link stretches over it
	// (after:inset-0), and the checkbox sits above that layer as its own target,
	// so no control is nested inside another.
	const stretch = "after:absolute after:inset-0 after:content-['']";
	const body = (
		<Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
			<Group
				justify="space-between"
				align="flex-start"
				wrap="nowrap"
				gap="md"
				className="app-stack-narrow"
			>
				<Text size="sm" lineClamp={2}>
					{title}
				</Text>
				<Box style={{ flexShrink: 0 }}>
					<ConversationStatus conversation={conversation} />
				</Box>
			</Group>
			<Group gap="xs" wrap="wrap">
				<Text size="xs" c="dimmed">
					{duration ? `${when} · ${duration}` : when}
				</Text>
				{tags.map((tag) => {
					const text = getTagText(tag);
					return text ? (
						<Badge key={tag.id} size="xs" color="gray">
							{text}
						</Badge>
					) : null;
				})}
			</Group>
		</Stack>
	);

	return (
		<Group
			ref={rowRef}
			className="app-do"
			data-selected={selected || undefined}
			pos="relative"
			gap="md"
			align="flex-start"
			wrap="nowrap"
			px="md"
			py="sm"
			{...testId(`mini-conversation-row-${conversation.id}`)}
		>
			{selectable && (
				<Box pt={4} pos="relative" style={{ zIndex: 2 }}>
					<Checkbox
						aria-label={t`Select ${title}`}
						checked={selected}
						disabled={isLocked || conversation.has_transcript === false}
						onChange={onToggle}
						{...testId(`mini-conversation-checkbox-${conversation.id}`)}
					/>
				</Box>
			)}
			{isLocked ? (
				<UnstyledButton
					onClick={onLocked}
					aria-label={t`Locked conversation, upgrade to view`}
					className={stretch}
					style={{ flex: 1, minWidth: 0 }}
				>
					{body}
				</UnstyledButton>
			) : (
				<Box
					component={I18nLink}
					to={href}
					className={`${stretch} no-underline`}
					c="inherit"
					style={{ display: "flex", flex: 1, minWidth: 0 }}
				>
					{body}
				</Box>
			)}
		</Group>
	);
};
