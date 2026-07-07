import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Alert,
	Anchor,
	Badge,
	Box,
	Button,
	Center,
	Group,
	Loader,
	Stack,
	Text,
	Textarea,
	Title,
} from "@mantine/core";
import { useDisclosure, useDocumentTitle } from "@mantine/hooks";
import { IconAlertCircle, IconArrowUp } from "@tabler/icons-react";
import { formatRelative } from "date-fns";
import posthog from "posthog-js";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useInView } from "react-intersection-observer";
import { useLocation, useParams } from "react-router";
import {
	ChatAccordionItemMenu,
	ChatModeIndicator,
} from "@/components/chat/ChatAccordion";
import { ChatModeSelector } from "@/components/chat/ChatModeSelector";
import { ChatUpgradeModal } from "@/components/chat/FreeTierChatGate";
import {
	useInfiniteProjectChats,
	useInitializeChatModeMutation,
	usePrefetchSuggestions,
	useProjectChatsCount,
} from "@/components/chat/hooks";
import { InsertTemplateMenu } from "@/components/chat/InsertTemplateMenu";
import { BaseSkeleton } from "@/components/common/BaseSkeleton";
import { NavigationButton } from "@/components/common/NavigationButton";
import { PageContainer } from "@/components/layout/PageContainer";
import { useCreateChatMutation } from "@/components/project/hooks";
import { ASK_DOCS_URL, ENABLE_AGENTIC_CHAT } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useLanguage } from "@/hooks/useLanguage";
import { useWorkspace } from "@/hooks/useWorkspace";
import { useWorkspaceUsage } from "@/hooks/useWorkspaceUsage";
import type { ChatMode } from "@/lib/api";
import { isFreeTierLimitError } from "@/lib/freeTier";
import { isReadOnlyRole } from "@/lib/roles";

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
	filter,
	projectId,
	workspaceId,
}: {
	filter?: string;
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

	// The bar above doubles as a filter over your chats: typing narrows the
	// list in place (gently, no layout jumps) while Enter still starts a new
	// chat with the typed question.
	const normalizedFilter = filter?.trim().toLowerCase() ?? "";
	const visibleChats = useMemo(() => {
		if (!normalizedFilter) return allChats;
		return allChats.filter((chat) =>
			(chat.name ?? "").toLowerCase().includes(normalizedFilter),
		);
	}, [allChats, normalizedFilter]);

	const totalChats = chatsCountQuery.data ?? 0;
	if (totalChats === 0) return null;

	return (
		<Stack gap="lg" className="pt-4 transition-opacity">
			<Group gap="sm" align="center">
				<Title order={2} fw={500} style={{ color: "var(--app-text)" }}>
					<Trans>Chats</Trans>
				</Title>
				<Badge variant="light">{totalChats}</Badge>
			</Group>

			{normalizedFilter && visibleChats.length === 0 && (
				<Text size="sm">
					<Trans>No chats match. Press Enter to ask this as a new chat.</Trans>
				</Text>
			)}

			<Stack gap="xs">
				{visibleChats.map((item, index) => {
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
							ref={index === visibleChats.length - 1 ? loadMoreRef : undefined}
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
	const initializeModeMutation = useInitializeChatModeMutation();
	const prefetchSuggestions = usePrefetchSuggestions();
	const [isInitializing, setIsInitializing] = useState(false);
	const [draft, setDraft] = useState("");
	const { freeTier } = useWorkspaceUsage(workspaceId);
	const [upgradeOpened, upgradeHandlers] = useDisclosure(false);
	const atChatLimit = Boolean(
		freeTier?.active && freeTier.chats_used >= freeTier.chats_limit,
	);

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
			// Step 1: Create the chat without mode
			const chat = await createChatMutation.mutateAsync({
				navigateToNewChat: false, // Don't navigate yet
				project_id: { id: projectId },
			});

			if (!chat?.id) {
				throw new Error("Failed to create chat");
			}

			posthog.capture("chat_started", {
				chat_id: chat.id,
				mode,
				project_id: projectId,
			});

			// Step 2: Initialize the mode (this attaches conversations for overview mode)
			await initializeModeMutation.mutateAsync({
				chatId: chat.id,
				mode,
				projectId,
			});

			// Step 3: For overview mode, prefetch suggestions (wait up to 5s for better UX)
			// For deep_dive mode, navigate immediately - suggestions will be fetched when context changes
			if (mode === "overview") {
				await prefetchSuggestions(chat.id, language, 5000);
			}

			// Step 4: Navigate to the new chat; the panel sends the typed
			// question as the first message (router state, consumed once).
			navigate(`/w/${workspaceId}/projects/${projectId}/chats/${chat.id}`, {
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

	// "Open the old chat experience" from inside an agentic chat lands here
	// with a preferred mode; start that chat right away, once.
	const preferredMode =
		typeof (location.state as { preferMode?: unknown } | null)?.preferMode ===
		"string"
			? ((location.state as { preferMode: ChatMode }).preferMode as ChatMode)
			: null;
	const preferredModeStartedRef = useRef(false);
	const initialMessage =
		typeof (location.state as { initialMessage?: unknown } | null)
			?.initialMessage === "string"
			? (location.state as { initialMessage: string }).initialMessage
			: null;
	const initialMessageStartedRef = useRef(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: handleModeSelected is recreated per render; the ref guards a single run
	useEffect(() => {
		if (!preferredMode || preferredModeStartedRef.current) return;
		preferredModeStartedRef.current = true;
		window.history.replaceState({}, "");
		void handleModeSelected(preferredMode);
	}, [preferredMode]);

	// Project creation lands on Ask home with a setup seed. Start the agentic
	// chat immediately and pass the seed through to the chat panel, which sends
	// it as the first user message.
	// biome-ignore lint/correctness/useExhaustiveDependencies: handleModeSelected is recreated per render; the ref guards a single run
	useEffect(() => {
		if (!ENABLE_AGENTIC_CHAT) return;
		if (!initialMessage || initialMessageStartedRef.current) return;
		initialMessageStartedRef.current = true;
		window.history.replaceState({}, "");
		void handleModeSelected("agentic", initialMessage);
	}, [initialMessage]);

	if (!projectId || !workspaceId) {
		return (
			<Box className="flex h-full items-center justify-center">
				<Text c="dimmed">
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
		initializeModeMutation.isPending;

	const startChat = () => {
		if (isPending) return;
		void handleModeSelected("agentic", draft.trim() || undefined);
	};

	return (
		<PageContainer>
			<Stack gap="xl">
				{ENABLE_AGENTIC_CHAT ? (
					<Stack gap="lg" className="pb-4 pt-10">
						<Group justify="space-between" align="baseline" gap="sm">
							<Title order={2} fw={500}>
								<Trans>Where would you like to start?</Trans>
							</Title>
							{/* Escape hatch to the classic experience while the new
							    chat matures. */}
							<Button
								variant="subtle"
								size="xs"
								disabled={isPending}
								onClick={() => void handleModeSelected("deep_dive")}
							>
								<Trans>
									Prefer the old chat? Start a Specific Details chat
								</Trans>
							</Button>
						</Group>
						<Textarea
							autosize
							minRows={2}
							maxRows={6}
							radius="lg"
							size="sm"
							autoFocus
							value={draft}
							onChange={(event) => setDraft(event.currentTarget.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter" && !event.shiftKey) {
									event.preventDefault();
									startChat();
								}
							}}
							placeholder={t`Ask about your conversations, or type to find an earlier chat`}
							disabled={isPending}
							styles={{
								input: { backgroundColor: "transparent", resize: "none" },
							}}
							className="rounded-lg bg-white shadow-sm"
							rightSectionWidth={52}
							rightSection={
								isPending ? (
									<Loader size="xs" />
								) : (
									<ActionIcon
										size="lg"
										radius="xl"
										aria-label={t`Start a chat`}
										onClick={startChat}
										disabled={draft.trim().length === 0}
									>
										<IconArrowUp size={18} />
									</ActionIcon>
								)
							}
							{...{ "data-testid": "ask-home-input" }}
						/>
						<Group gap="lg">
							<InsertTemplateMenu
								workspaceId={workspaceId}
								onInsert={(content) => setDraft(content)}
							/>
							{ASK_DOCS_URL && (
								<Anchor
									size="xs"
									href={ASK_DOCS_URL}
									target="_blank"
									rel="noreferrer"
								>
									<Trans>What can Ask do?</Trans>
								</Anchor>
							)}
						</Group>
					</Stack>
				) : (
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
						filter={ENABLE_AGENTIC_CHAT ? draft : undefined}
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
		</PageContainer>
	);
};

export default NewChatRoute;
