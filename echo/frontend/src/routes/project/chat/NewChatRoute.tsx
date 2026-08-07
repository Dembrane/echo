import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Alert,
	Badge,
	Box,
	Button,
	Center,
	Group,
	Loader,
	Modal,
	Stack,
	Text,
	Textarea,
	TextInput,
	Title,
} from "@mantine/core";
import {
	useDebouncedValue,
	useDisclosure,
	useDocumentTitle,
} from "@mantine/hooks";
import {
	IconAlertCircle,
	IconSearch,
	IconSend,
	IconX,
} from "@tabler/icons-react";
import { formatRelative } from "date-fns";
import posthog from "posthog-js";
import { Suspense, useEffect, useRef, useState } from "react";
import { useInView } from "react-intersection-observer";
import { useLocation, useParams, useSearchParams } from "react-router";
import { AgenticIntroModal } from "@/components/chat/AgenticIntroModal";
import {
	ChatAccordionItemMenu,
	ChatModeIndicator,
} from "@/components/chat/ChatAccordion";
import {
	ChatComposerShell,
	ConversationFocusChips,
	ConversationPickerButton,
} from "@/components/chat/ChatComposer";
import { ChatModeSelector } from "@/components/chat/ChatModeSelector";
import { ChatUpgradeModal } from "@/components/chat/FreeTierChatGate";
import {
	useInfiniteProjectChats,
	useDeleteChatMutation,
	useInitializeChatModeMutation,
	usePrefetchSuggestions,
	useProjectChatContext,
	useProjectChatSearch,
	useProjectChatsCount,
} from "@/components/chat/hooks";
import { consumeChatPrefill } from "@/components/chat/prefill";
import { BaseSkeleton } from "@/components/common/BaseSkeleton";
import { NavigationButton } from "@/components/common/NavigationButton";
import { ProjectConversationsPanel } from "@/components/conversation/ProjectConversationsPanel";
import { PageContainer } from "@/components/layout/PageContainer";
import {
	useAttachChatConversationsMutation,
	useCreateChatMutation,
} from "@/components/project/hooks";
import { AGENTIC_CHAT_IS_DEFAULT, ENABLE_AGENTIC_CHAT } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useLanguage } from "@/hooks/useLanguage";
import { useWorkspace } from "@/hooks/useWorkspace";
import { useWorkspaceUsage } from "@/hooks/useWorkspaceUsage";
import type { ChatMode } from "@/lib/api";
import { isFreeTierLimitError } from "@/lib/freeTier";
import { isReadOnlyRole } from "@/lib/roles";
import { testId } from "@/lib/testUtils";

const CHATS_PAGE_SIZE = 10;

// Standalone fallback: ChatSkeleton renders a bare Accordion.Item and
// throws when mounted outside an <Accordion>.
const ChatsSectionSkeleton = () => (
	<Stack gap="lg">
		<BaseSkeleton width="120px" height="28px" radius="xs" />
		<BaseSkeleton count={3} height="40px" width="100%" radius="xs" />
	</Stack>
);

const ProjectChatsSection = ({
	projectId,
	workspaceId,
}: {
	projectId: string;
	workspaceId: string;
}) => {
	const { ref: loadMoreRef, inView } = useInView();
	const chatsCountQuery = useProjectChatsCount(projectId, undefined, {
		hasMessages: true,
	});
	const chatsQuery = useInfiniteProjectChats(projectId, undefined, {
		hasMessages: true,
		initialLimit: CHATS_PAGE_SIZE,
	});

	const [searchParams, setSearchParams] = useSearchParams();
	const rawSearch = searchParams.get("chatq") ?? "";
	const [debouncedSearch] = useDebouncedValue(rawSearch, 300);
	const searchQuery = useProjectChatSearch(projectId, debouncedSearch);
	const isSearching = debouncedSearch.trim().length > 0;

	const setSearch = (next: string) => {
		setSearchParams(
			(current) => {
				const params = new URLSearchParams(current);
				if (next) params.set("chatq", next);
				else params.delete("chatq");
				return params;
			},
			{ replace: true },
		);
	};

	useEffect(() => {
		if (inView && chatsQuery.hasNextPage && !chatsQuery.isFetchingNextPage) {
			chatsQuery.fetchNextPage();
		}
	}, [
		inView,
		chatsQuery.hasNextPage,
		chatsQuery.isFetchingNextPage,
		chatsQuery.fetchNextPage,
	]);

	const allChats =
		(
			chatsQuery.data?.pages as Array<{
				chats: ProjectChat[];
				nextOffset?: number;
			}>
		)?.flatMap((page) => page.chats) ?? [];

	const listedChats = isSearching ? (searchQuery.data?.chats ?? []) : allChats;
	const shownCount = isSearching
		? (searchQuery.data?.total ?? 0)
		: (chatsCountQuery.data ?? 0);

	// Hide the whole section only when the project genuinely has no chats and
	// the host is not searching; otherwise the empty states below do the talking.
	if (!isSearching && (chatsCountQuery.data ?? 0) === 0) return null;

	return (
		<Stack gap="lg" className="pt-4 transition-opacity">
			<Group gap="sm" align="center" justify="space-between" wrap="wrap">
				<Group gap="sm" align="center">
					<Title order={2} fw={500} style={{ color: "var(--app-text)" }}>
						<Trans>Chats</Trans>
					</Title>
					<Badge variant="light">{shownCount}</Badge>
				</Group>
				<TextInput
					size="sm"
					className="w-64"
					value={rawSearch}
					onChange={(event) => setSearch(event.currentTarget.value)}
					placeholder={t`Search chats`}
					aria-label={t`Search chats`}
					leftSection={<IconSearch size={14} />}
					rightSection={
						rawSearch ? (
							<ActionIcon
								variant="subtle"
								size="sm"
								aria-label={t`Clear search`}
								onClick={() => setSearch("")}
							>
								<IconX size={14} />
							</ActionIcon>
						) : null
					}
					{...testId("chats-search-input")}
				/>
			</Group>

			{isSearching && listedChats.length === 0 && !searchQuery.isFetching && (
				<Text size="sm">
					<Trans>No chats match your search.</Trans>
				</Text>
			)}
			{!isSearching && listedChats.length === 0 && (
				<Text size="sm">
					<Trans>No chats yet.</Trans>
				</Text>
			)}
			{isSearching && shownCount > listedChats.length && (
				<Text size="xs">
					<Trans>
						Showing the first {listedChats.length} of {shownCount} matches.
						Narrow the search to see the rest.
					</Trans>
				</Text>
			)}

			<Stack gap="xs">
				{listedChats.map((item, index) => {
					const chatMode = (item as ProjectChat & { chat_mode?: string })
						.chat_mode as
						| "overview"
						| "deep_dive"
						| "agentic"
						| null
						| undefined;
					return (
						<NavigationButton
							key={item.id}
							to={`/w/${workspaceId}/projects/${projectId}/chats/${item.id}`}
							rightSection={
								<Group gap="xs" wrap="nowrap">
									<ChatModeIndicator mode={chatMode} size="xs" />
									<ChatAccordionItemMenu chat={item as ProjectChat} />
								</Group>
							}
							ref={
								!isSearching && index === listedChats.length - 1
									? loadMoreRef
									: undefined
							}
						>
							<Stack gap={2}>
								<Text size="sm" lineClamp={1}>
									{item.name
										? item.name
										: formatRelative(
												new Date(item.date_created ?? new Date()),
												new Date(),
											)}
								</Text>
								{item.name && (
									<Text size="xs" c="gray.6">
										{formatRelative(
											new Date(item.date_created ?? new Date()),
											new Date(),
										)}
									</Text>
								)}
							</Stack>
						</NavigationButton>
					);
				})}
				{chatsQuery.isFetchingNextPage && (
					<Center py="md">
						<Loader size="sm" />
					</Center>
				)}
			</Stack>
		</Stack>
	);
};

export const NewChatRoute = () => {
	useDocumentTitle(t`Ask | dembrane`);
	const { projectId, workspaceId } = useParams();
	const navigate = useI18nNavigate();
	const location = useLocation();
	const { workspace } = useWorkspace();
	// Observers can't chat; gate before the chat-list section mounts, since its
	// queries 403 and otherwise surface as "Something went wrong".
	const isObserver = isReadOnlyRole(workspace?.role);
	const { language } = useLanguage();
	const createChatMutation = useCreateChatMutation();
	const attachConversationsMutation = useAttachChatConversationsMutation();
	const initializeModeMutation = useInitializeChatModeMutation();
	const prefetchSuggestions = usePrefetchSuggestions();
	const [isInitializing, setIsInitializing] = useState(false);
	const [draft, setDraft] = useState("");
	const { freeTier } = useWorkspaceUsage(workspaceId);
	const [upgradeOpened, upgradeHandlers] = useDisclosure(false);
	const atChatLimit = Boolean(
		freeTier?.active && freeTier.chats_used >= freeTier.chats_limit,
	);
	// Which mode the primary Start button (and the count line's wording)
	// targets. Agentic stays available via the "Try Agentic instead" link
	// regardless of this default.
	const modeToStart: ChatMode = AGENTIC_CHAT_IS_DEFAULT
		? "agentic"
		: "deep_dive";

	// Conversations picked before the chat exists, from either this screen's
	// own "Change" picker or the "Ask about these" action on the Conversations
	// page (router state). Held here, not written through, until the chat is
	// created.
	const [selectedConversationIds, setSelectedConversationIds] = useState<
		string[]
	>(() => {
		const state = location.state as {
			selectedConversationIds?: unknown;
		} | null;
		return Array.isArray(state?.selectedConversationIds)
			? state.selectedConversationIds.filter(
					(id): id is string => typeof id === "string",
				)
			: [];
	});
	const [pickerOpened, pickerHandlers] = useDisclosure(false);
	const [agenticIntroOpened, agenticIntroHandlers] = useDisclosure(false);
	// Draft chat behind the picker: created the moment the picker first
	// opens, so ticks and Select All write through the server like any other
	// chat, and the server keeps owning limits and counts. Handed off on
	// start; deleted on leaving this screen if no message was ever sent.
	const [draftChatId, setDraftChatId] = useState<string | null>(null);
	const draftChatIdRef = useRef<string | null>(null);
	const draftHandedOffRef = useRef(false);
	const deleteChatMutation = useDeleteChatMutation();
	const draftContextQuery = useProjectChatContext(draftChatId ?? "");
	const pickedCount = draftChatId
		? (draftContextQuery.data?.conversations?.length ?? 0)
		: selectedConversationIds.length;

	const handleModeSelected = async (
		mode: ChatMode,
		initialMessage?: string,
	) => {
		if (!projectId) return;

		// Free tier: one chat per workspace. Route to upgrade instead of creating.
		if (atChatLimit) {
			upgradeHandlers.open();
			return;
		}

		setIsInitializing(true);

		try {
			// Step 1: Reuse the draft chat the picker created (its context is
			// already server-side), or create a fresh one. It has no mode yet.
			let chatId = draftChatId;
			if (!chatId) {
				const chat = await createChatMutation.mutateAsync({
					navigateToNewChat: false, // Don't navigate yet
					project_id: { id: projectId },
				});
				if (!chat?.id) {
					throw new Error("Failed to create chat");
				}
				chatId = chat.id;
			}

			posthog.capture("chat_started", {
				chat_id: chatId,
				mode,
				project_id: projectId,
			});

			// Step 2: Initialize the mode (this attaches conversations for overview mode)
			await initializeModeMutation.mutateAsync({
				chatId,
				mode,
				projectId,
			});

			// Step 3: Attach the conversations picked up-front, in one request,
			// after the mode exists and before the first turn runs. Order
			// matters: the server only skips the transcript token budget once it
			// can see that the chat is agentic, so attaching first would make a
			// long selection fail with "Conversation is too long" even for
			// agentic.
			if (!draftChatId && selectedConversationIds.length > 0) {
				await attachConversationsMutation.mutateAsync({
					chatId,
					conversationIds: selectedConversationIds,
					projectId,
				});
			}

			// Step 4: For overview mode, prefetch suggestions (wait up to 5s for better UX)
			// For deep_dive mode, navigate immediately - suggestions will be fetched when context changes
			if (mode === "overview") {
				await prefetchSuggestions(chatId, language, 5000);
			}

			// Step 5: Navigate to the new chat; the panel sends the typed
			// question as the first message (router state, consumed once).
			draftHandedOffRef.current = true;
			navigate(`/w/${workspaceId}/projects/${projectId}/chats/${chatId}`, {
				state: initialMessage ? { initialMessage } : undefined,
			});
		} catch (error) {
			// Backend safety net: free-tier chat cap returns 402.
			if (isFreeTierLimitError(error) === "chats") {
				upgradeHandlers.open();
			} else {
				console.error("Failed to create chat with mode:", error);
			}
			setIsInitializing(false);
		}
	};

	const openPicker = async () => {
		if (!projectId || isPending) return;
		if (draftChatId) {
			pickerHandlers.open();
			return;
		}
		// Free tier: one chat per workspace. Route to upgrade before creating
		// the draft, same as starting a chat would.
		if (atChatLimit) {
			upgradeHandlers.open();
			return;
		}
		try {
			const chat = await createChatMutation.mutateAsync({
				navigateToNewChat: false,
				project_id: { id: projectId },
			});
			if (!chat?.id) {
				throw new Error("Failed to create chat");
			}
			// Carry over anything picked before the draft existed (e.g. "Ask
			// about these" router state) so the picker shows it as context.
			if (selectedConversationIds.length > 0) {
				await attachConversationsMutation.mutateAsync({
					chatId: chat.id,
					conversationIds: selectedConversationIds,
					projectId,
				});
			}
			draftChatIdRef.current = chat.id;
			setDraftChatId(chat.id);
			pickerHandlers.open();
		} catch (error) {
			if (isFreeTierLimitError(error) === "chats") {
				upgradeHandlers.open();
			} else {
				console.error("Failed to prepare the conversation picker:", error);
			}
		}
	};

	// Throwaway cleanup: leaving this screen without starting the chat
	// deletes the draft, so abandoned pickers do not litter the chat list.
	// biome-ignore lint/correctness/useExhaustiveDependencies: unmount-only cleanup over refs
	useEffect(() => {
		return () => {
			if (draftChatIdRef.current && !draftHandedOffRef.current && projectId) {
				deleteChatMutation.mutate({
					chatId: draftChatIdRef.current,
					projectId,
				});
			}
		};
	}, []);

	// Two ways to land here with the choice already made:
	//   - "Open the old chat experience" inside an agentic chat passes
	//     preferMode: "deep_dive".
	//   - Project creation with "Set up with the assistant" ticked passes
	//     preferMode: "agentic" plus the seed question.
	// Anything that arrives with only a seed follows the default mode rather
	// than assuming agentic.
	const preferredMode =
		typeof (location.state as { preferMode?: unknown } | null)?.preferMode ===
		"string"
			? ((location.state as { preferMode: ChatMode }).preferMode as ChatMode)
			: null;
	const queryPrefillStartedRef = useRef(false);
	const initialMessage =
		typeof (location.state as { initialMessage?: unknown } | null)
			?.initialMessage === "string"
			? (location.state as { initialMessage: string }).initialMessage
			: null;
	const autoStartMode: ChatMode | null =
		preferredMode ?? (initialMessage ? modeToStart : null);
	const autoStartedRef = useRef(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: handleModeSelected is recreated per render; the ref guards a single run
	useEffect(() => {
		if (!autoStartMode || autoStartedRef.current) return;
		if (autoStartMode === "agentic" && !ENABLE_AGENTIC_CHAT) return;
		autoStartedRef.current = true;
		window.history.replaceState({}, "");
		void handleModeSelected(autoStartMode, initialMessage ?? undefined);
	}, [autoStartMode]);

	useEffect(() => {
		if (queryPrefillStartedRef.current) return;
		const { prefill, search } = consumeChatPrefill(location.search);
		if (!prefill && search === location.search) return;
		queryPrefillStartedRef.current = true;
		window.history.replaceState(
			window.history.state,
			"",
			`${location.pathname}${search}${location.hash}`,
		);
		if (prefill) setDraft(prefill);
	}, [location.hash, location.pathname, location.search]);

	if (!projectId || !workspaceId) {
		return (
			<Box className="flex h-full items-center justify-center">
				<Text>
					<Trans>Project not found</Trans>
				</Text>
			</Box>
		);
	}

	// Observer read-only wall: no chat. Gate before the chat-list section mounts.
	if (isObserver) {
		return (
			<Box className="flex min-h-full items-center justify-center px-2 pr-4">
				<Alert
					icon={<IconAlertCircle size="1rem" />}
					color="primary"
					variant="light"
					maw={420}
				>
					<Text size="sm">
						<Trans>
							Chat isn't available on your access level. Reach out to your
							workspace admin to request an upgrade.
						</Trans>
					</Text>
				</Alert>
			</Box>
		);
	}

	const isPending =
		isInitializing ||
		createChatMutation.isPending ||
		attachConversationsMutation.isPending ||
		initializeModeMutation.isPending;

	const startChat = () => {
		if (isPending) return;
		void handleModeSelected(modeToStart, draft.trim() || undefined);
	};

	const startAgentic = () => {
		if (isPending) return;
		void handleModeSelected("agentic", draft.trim() || undefined);
	};

	return (
		<PageContainer>
			<Stack gap="xl">
				{ENABLE_AGENTIC_CHAT ? (
					<Stack gap="lg" className="pb-4 pt-10">
						<Title order={2} fw={500}>
							<Trans>Where would you like to start?</Trans>
						</Title>
						{/* The picker has to be reachable from an empty selection: this
						    screen is where a host narrows the chat before it exists. */}
						<ChatComposerShell
							chips={
								pickedCount > 0 ? (
									<ConversationFocusChips
										count={pickedCount}
										disabled={isPending}
										label={
											modeToStart === "agentic" ? (
												<Plural
													value={pickedCount}
													one="Focusing on # conversation"
													other="Focusing on # conversations"
												/>
											) : (
												<Plural
													value={pickedCount}
													one="Using # conversation"
													other="Using # conversations"
												/>
											)
										}
										onClearAll={() => {
											// Clearing a draft's context means throwing the
											// draft away; a fresh one appears when the picker
											// next opens.
											if (draftChatIdRef.current && projectId) {
												deleteChatMutation.mutate({
													chatId: draftChatIdRef.current,
													projectId,
												});
												draftChatIdRef.current = null;
												setDraftChatId(null);
											}
											setSelectedConversationIds([]);
										}}
									/>
								) : undefined
							}
							footerLeft={
								<ConversationPickerButton
									ariaLabel={t`Select conversations`}
									disabled={isPending}
									label={<Trans>Select conversations</Trans>}
									onClick={() => void openPicker()}
									testId="ask-home-choose-conversations"
								/>
							}
							footerRight={
								<Button
									type="button"
									size="md"
									radius="md"
									rightSection={
										isPending ? <Loader size={18} /> : <IconSend size={18} />
									}
									disabled={isPending || draft.trim().length === 0}
									onClick={startChat}
									{...testId("ask-home-send-button")}
								>
									<Trans>Send</Trans>
								</Button>
							}
						>
							<Textarea
								variant="unstyled"
								styles={{
									input: { backgroundColor: "transparent", resize: "none" },
								}}
								autosize
								minRows={2}
								maxRows={10}
								autoFocus
								value={draft}
								onChange={(event) => setDraft(event.currentTarget.value)}
								onKeyDown={(event) => {
									if (event.key === "Enter" && !event.shiftKey) {
										event.preventDefault();
										startChat();
									}
								}}
								placeholder={t`Ask about your conversations...`}
								disabled={isPending}
								{...testId("ask-home-input")}
							/>
						</ChatComposerShell>
						<Group gap="xs" align="center">
							<Button
								variant="subtle"
								size="sm"
								disabled={isPending}
								leftSection={
									<ChatModeIndicator mode="agentic" size="compact-sm" />
								}
								styles={{
									section: { marginRight: "var(--mantine-spacing-sm)" },
								}}
								onClick={() => {
									posthog.capture("agentic_chat_intro_opened", {
										source: "ask_home",
									});
									agenticIntroHandlers.open();
								}}
								{...testId("ask-home-try-agentic")}
							>
								<Trans>Try Agentic instead</Trans>
							</Button>
							<Badge size="md" color="mauve" c="graphite">
								<Trans>Beta</Trans>
							</Badge>
						</Group>
					</Stack>
				) : (
					// Unreachable while ENABLE_AGENTIC_CHAT is true everywhere. Kept as
					// the fallback entry screen if availability is ever narrowed again;
					// ChatModeSelector is still live for mode-less chats in
					// ProjectChatRoute, and five modules import its MODE_COLORS.
					<ChatModeSelector
						isNewChat
						isCreating={isPending}
						projectId={projectId}
						onModeSelected={(mode) => void handleModeSelected(mode)}
						atChatLimit={atChatLimit}
					/>
				)}

				<Suspense fallback={<ChatsSectionSkeleton />}>
					<ProjectChatsSection
						projectId={projectId}
						workspaceId={workspaceId}
					/>
				</Suspense>
			</Stack>
			<ChatUpgradeModal
				opened={upgradeOpened}
				onClose={upgradeHandlers.close}
				reason="chats"
			/>
			<Modal
				opened={pickerOpened}
				onClose={pickerHandlers.close}
				title={t`Select conversations`}
				size="xl"
				padding="lg"
			>
				{projectId && draftChatId && (
					<ProjectConversationsPanel
						projectId={projectId}
						workspaceId={workspaceId}
						selectionMode
						selectionChatId={draftChatId}
					/>
				)}
			</Modal>
			<AgenticIntroModal
				opened={agenticIntroOpened}
				onClose={agenticIntroHandlers.close}
				onConfirm={() => {
					posthog.capture("agentic_chat_intro_confirmed", {
						source: "ask_home",
					});
					agenticIntroHandlers.close();
					startAgentic();
				}}
			/>
		</PageContainer>
	);
};

export default NewChatRoute;
