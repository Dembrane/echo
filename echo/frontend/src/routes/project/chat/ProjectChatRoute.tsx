import { useChat } from "@ai-sdk/react";
import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import { ChatCircleText as ChatCircleTextIcon } from "@phosphor-icons/react";
import {
	Alert,
	Badge,
	Box,
	Button,
	Divider,
	Group,
	LoadingOverlay,
	Modal,
	Stack,
	Text,
	Textarea,
	Title,
} from "@mantine/core";
import { useDisclosure, useDocumentTitle } from "@mantine/hooks";
import { usePostHog } from "@posthog/react";
import {
	IconAlertCircle,
	IconRefresh,
	IconSend,
	IconSquare,
} from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useParams } from "react-router";
import { AgenticChatPanel } from "@/components/chat/AgenticChatPanel";
import {
	ChatAccordionItemMenu,
	ChatModeIndicator,
} from "@/components/chat/ChatAccordion";
import {
	ChatComposerShell,
	ConversationFocusChips,
	ConversationPickerButton,
} from "@/components/chat/ChatComposer";
import { ChatContextProgress } from "@/components/chat/ChatContextProgress";
import { ChatHistoryMessage } from "@/components/chat/ChatHistoryMessage";
import { ChatModeSelector } from "@/components/chat/ChatModeSelector";
import { ChatTemplatesMenuConnected } from "@/components/chat/ChatTemplatesMenuConnected";
import { formatMessage } from "@/components/chat/chatUtils";
import {
	ChatTurnLimitCard,
	ChatUpgradeModal,
} from "@/components/chat/FreeTierChatGate";
import {
	useAddChatMessageMutation,
	useChatHistory,
	useInitializeChatModeMutation,
	useLockConversationsMutation,
	usePrefetchSuggestions,
	useChat as useProjectChat,
	useProjectChatContext,
} from "@/components/chat/hooks";
import { consumeChatPrefill } from "@/components/chat/prefill";
import { CopyRichTextIconButton } from "@/components/common/CopyRichTextIconButton";
import { Logo } from "@/components/common/Logo";
import { ScrollToBottomButton } from "@/components/common/ScrollToBottom";
import { toast } from "@/components/common/Toaster";
import { useStickToBottom } from "@/components/common/useStickToBottom";
import {
	useClearChatContextMutation,
	useConversationsCountByProjectId,
} from "@/components/conversation/hooks";
import { ProjectConversationsPanel } from "@/components/conversation/ProjectConversationsPanel";
import { ErrorBoundary } from "@/components/error/ErrorBoundary";
import { useProjectById } from "@/components/project/hooks";
import {
	AGENTIC_CHAT_IS_DEFAULT,
	API_BASE_URL,
	ENABLE_AGENTIC_CHAT,
} from "@/config";
import { useLanguage } from "@/hooks/useLanguage";
import { useLoadNotification } from "@/hooks/useLoadNotification";
import { useWorkspace } from "@/hooks/useWorkspace";
import { useWorkspaceUsage } from "@/hooks/useWorkspaceUsage";
import { FREE_TIER_MAX_CHAT_USER_TURNS } from "@/lib/freeTier";
import { isReadOnlyRole } from "@/lib/roles";
import { testId } from "@/lib/testUtils";
import { resolveChatScreen } from "./chatModeRouting";

const useDembraneChat = ({ chatId }: { chatId: string }) => {
	const chatHistoryQuery = useChatHistory(chatId);
	const chatContextQuery = useProjectChatContext(chatId);
	const posthog = usePostHog();

	const [templateKey, setTemplateKey] = useState<string | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);

	const addChatMessageMutation = useAddChatMessageMutation();
	const lockConversationsMutation = useLockConversationsMutation();

	const lastInput = useRef("");
	const lastMessageRef = useRef<HTMLDivElement>(null);

		// biome-ignore lint/correctness/useExhaustiveDependencies: needs to be fixed
		const contextToBeAdded = useMemo(() => {
			if (!chatContextQuery.data) {
				return null;
			}
			return {
				conversations: (chatContextQuery.data.conversations ?? []).filter(
					(c) => !c.locked,
				),
				locked_conversations: (chatContextQuery.data.conversations ?? []).filter(
					(c) => c.locked,
				),
			};
		}, [chatContextQuery.data, chatHistoryQuery.data]);

	const { iso639_1 } = useLanguage();

	const {
		messages,
		setMessages,
		input,
		setInput,
		handleInputChange,
		handleSubmit,
		isLoading,
		status,
		error,
		stop,
		reload,
		data,
	} = useChat({
		api: `${API_BASE_URL}/chats/${chatId}?language=${iso639_1 ?? "en"}`,
		credentials: "include",
		experimental_prepareRequestBody: (options) => {
			return {
				...options,
				template_key: templateKey,
			};
		},
		// @ts-expect-error chatHistoryQuery.data is not typed
		initialMessages: chatHistoryQuery.data ?? [],
		onError: (error) => {
			if (lastInput.current) {
				setInput(lastInput.current);
			}
			// This is the non-agentic chat path, so the browser is the only place
			// that sees a failed response. Split out rate limits (the explore /
			// usage-cap signal) from other errors.
			const msg = (error?.message ?? "").toLowerCase();
			const isRateLimited =
				msg.includes("429") ||
				msg.includes("rate limit") ||
				msg.includes("too many");
			posthog?.capture(isRateLimited ? "chat_rate_limited" : "chat_error", {
				chat_id: chatId,
				message: error?.message?.slice(0, 300),
			});
			console.log("onError", error);
		},
		onFinish: async (message) => {
			// this uses the response stream from the backend and makes a chat message IN THE FRONTEND
			// do this for now because - i dont want to do the stream text processing again in the backend
			// if someone navigates away before onFinish is completed, the message will be lost
			addChatMessageMutation.mutate({
				chat_message_metadata: [],
				date_created: new Date().toISOString(),
				message_from: "assistant",
				project_chat_id: chatId,
				text: message.content,
			});

			// scroll to the last message
			lastMessageRef.current?.scrollIntoView({ behavior: "smooth" });
		},
		onResponse: async (_response) => {},
		streamProtocol: "data",
	});

	// Handle load status (shows inline message when backend reports high load)
	const hasContent =
		messages.length > 0 && messages[messages.length - 1]?.content?.length > 0;
	const { statusMessage } = useLoadNotification({
		data,
		hasContent,
		isLoading,
	});

	const customHandleStop = () => {
		stop();

		const incompleteMessage = messages[messages.length - 1];

		const body = {
			date_created: new Date(
				incompleteMessage.createdAt ?? new Date(),
			).toISOString(),
			message_from: "assistant",
			project_chat_id: chatId,
			text: incompleteMessage.content,
		};

		// publish the incomplete result to the backend
		addChatMessageMutation.mutate(body as Partial<ProjectChatMessage>);
	};

	const customHandleSubmit = async () => {
		lastInput.current = input;
		setIsSubmitting(true);

		try {
			// Lock conversations first
			await lockConversationsMutation.mutateAsync({ chatId });
			const [, refreshedHistory] = await Promise.all([
				chatContextQuery.refetch(),
				chatHistoryQuery.refetch({ cancelRefetch: false }),
			]);
			if (refreshedHistory.data) {
				// @ts-expect-error chatHistoryQuery.data is not typed
				setMessages(refreshedHistory.data);
			}

			// Submit the chat
			handleSubmit();

			posthog?.capture("chat_message_sent", {
				chat_id: chatId,
				template_key: templateKey,
			});

			// Scroll to bottom when user submits a message
			setTimeout(() => {
				lastMessageRef.current?.scrollIntoView({ behavior: "smooth" });
			}, 0);
		} catch (error) {
			console.error("Error in customHandleSubmit:", error);
		} finally {
			setIsSubmitting(false);
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
		contextToBeAdded,
		error,
		handleInputChange,
		handleSubmit: customHandleSubmit,
		input,
		isInitializing: chatHistoryQuery.isLoading,
		isLoading,
		isSubmitting,
		lastInputRef: lastInput,
		lastMessageRef,
		messages,
		reload,
		setInput,
		setTemplateKey,
		status,
		statusMessage,
		stop: customHandleStop,
		templateKey,
	};
};

/** Initializes a mode-less chat as agentic, then hands off to the panel.
 * Hosts never see a mode choice. */
const AutoInitializeAgentic = ({
	chatId,
	projectId,
	onInitialized,
}: {
	chatId: string;
	projectId: string;
	onInitialized: () => void;
}) => {
	const initializeModeMutation = useInitializeChatModeMutation();
	const startedRef = useRef(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: mutation/callback identities change per render; the ref guards a single run
	useEffect(() => {
		if (startedRef.current || !chatId || !projectId) return;
		startedRef.current = true;
		initializeModeMutation
			.mutateAsync({ chatId, mode: "agentic", projectId })
			.then(onInitialized)
			.catch(() => {
				// The mutation surfaces its own toast; leave the screen calm.
			});
	}, [chatId, projectId]);

	return (
		<Box className="relative min-h-40">
			<LoadingOverlay visible overlayProps={{ backgroundOpacity: 0 }} />
		</Box>
	);
};

export const ProjectChatRoute = () => {
	useDocumentTitle(t`Chat | dembrane`);

	const { chatId, projectId, workspaceId: routeWorkspaceId } = useParams();
	const location = useLocation();
	const { workspace } = useWorkspace();
	// Observers are free, read-only: chat is the upgrade wall. Server denies
	// chat:use (403); the UI blocks here with a clear path to upgrade.
	const isObserver = isReadOnlyRole(workspace?.role);
	const chatQuery = useProjectChat(chatId ?? "");
	const chatContextQuery = useProjectChatContext(chatId ?? "");
	const clearChatContextMutation = useClearChatContextMutation();
	const [referenceIds, setReferenceIds] = useState<string[]>([]);
	const [templatesModalOpen, setTemplatesModalOpen] = useState(false);
	const [saveAsTemplateContent, setSaveAsTemplateContent] = useState<
		string | null
	>(null);
	const [conversationPickerOpen, setConversationPickerOpen] = useState(false);
	const queryPrefillStartedRef = useRef(false);
	// A question typed on the Ask home page arrives as router state. The
	// agentic panel consumes this itself; this route consumes it for every
	// other mode (deep_dive, legacy overview), so Specific Details (the new
	// default) never silently drops what the host typed. Read once at mount,
	// exactly like AgenticChatPanel's own initialMessageRef.
	const initialMessageRef = useRef<string | null>(
		typeof (location.state as { initialMessage?: unknown } | null)
			?.initialMessage === "string"
			? (location.state as { initialMessage: string }).initialMessage
			: null,
	);
	const pendingInitialMessageRef = useRef<string | null>(null);

	const handleSaveAsTemplate = (content: string) => {
		setSaveAsTemplateContent(content);
		setTemplatesModalOpen(true);
	};

	// Chat mode state
	// Legacy chats (chat_mode = null but has locked conversations) are treated as deep_dive
	// New chats (chat_mode = null, no locked conversations) should show mode selector
	const rawChatMode = chatContextQuery.data?.chat_mode;
	const hasLockedConversations =
		(chatContextQuery.data?.locked_conversation_id_list?.length ?? 0) > 0;
	// Same legacy rule the screen resolver applies (see ./chatModeRouting):
	// a mode-less chat that locked context predates chat_mode and renders as
	// Specific Details.
	const isLegacyChat = rawChatMode == null && hasLockedConversations;
	const chatMode = isLegacyChat ? "deep_dive" : rawChatMode;
	const isModeSelected = chatMode !== null && chatMode !== undefined;
	const isAgenticMode = chatMode === "agentic";

	// Locked + not-yet-locked, so this stays visible after conversations lock.
	const conversationCount = chatContextQuery.data?.conversations?.length ?? 0;

	// Get total conversations count for overview mode
	const _totalConversationsQuery = useConversationsCountByProjectId(
		projectId ?? "",
	);

	// Fetch the project's workspace_id: needed for the conversation picker
	// modal below (workspace-scoped conversation list).
	const projectForWorkspace = useProjectById({
		projectId: projectId ?? "",
		query: { fields: ["id", "workspace_id"] },
	});
	const projectWorkspaceId =
		(projectForWorkspace.data as { workspace_id?: string | null } | undefined)
			?.workspace_id ?? null;

	// Language for suggestions
	const { language } = useLanguage();
	const prefetchSuggestions = usePrefetchSuggestions();

	const {
		isInitializing,
		isLoading,
		isSubmitting,
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
		templateKey,
		setTemplateKey,
		statusMessage,
	} = useDembraneChat({ chatId: chatId ?? "" });
	const normalizedInput = typeof input === "string" ? input : "";

	const threadAnchorRef = useRef<HTMLDivElement>(null);
	const { showScrollButton, scrollToBottom } =
		useStickToBottom(threadAnchorRef);

	// Which screen this chat opens on. Pure and unit-tested in
	// ./chatModeRouting, because setting a mode is one-way: the server refuses
	// to change chat_mode once set, so a wrong call here cannot be walked back.
	const { screen: chatScreen } = resolveChatScreen({
		agenticIsDefault: AGENTIC_CHAT_IS_DEFAULT,
		hasLockedConversations,
		messageCount: messages.length,
		rawChatMode,
	});

	// Specific Details answers out of the conversations attached to the chat.
	// Mirrors the "Select conversations to continue" alert further down.
	const noConversationsSelected =
		contextToBeAdded?.conversations?.length === 0 &&
		contextToBeAdded?.locked_conversations?.length === 0;
	const needsConversations =
		chatMode !== "overview" && Boolean(noConversationsSelected);

	useEffect(() => {
		if (chatContextQuery.isLoading) return;
		if (isAgenticMode) return;
		if (queryPrefillStartedRef.current) return;
		const { prefill, search } = consumeChatPrefill(location.search);
		if (!prefill && search === location.search) return;
		queryPrefillStartedRef.current = true;
		window.history.replaceState(
			window.history.state,
			"",
			`${location.pathname}${search}${location.hash}`,
		);
		if (prefill) setInput(prefill);
	}, [
		chatContextQuery.isLoading,
		isAgenticMode,
		location.hash,
		location.pathname,
		location.search,
		setInput,
	]);

	// Free tier: max 3 user turns per chat. The 4th routes to upgrade.
	const { freeTier } = useWorkspaceUsage(routeWorkspaceId);
	const [chatUpgradeOpened, chatUpgradeHandlers] = useDisclosure(false);
	const userTurnCount = useMemo(
		() => (messages ?? []).filter((m) => m.role === "user").length,
		[messages],
	);
	const atTurnLimit = Boolean(
		freeTier?.active && userTurnCount >= FREE_TIER_MAX_CHAT_USER_TURNS,
	);
	const guardedSubmit = () => {
		if (atTurnLimit) {
			chatUpgradeHandlers.open();
			return;
		}
		handleSubmit();
	};

	// Step 1: once the chat is ready and its mode resolved, type the seeded
	// question into the input, same as a host would. Runs once.
	// biome-ignore lint/correctness/useExhaustiveDependencies: setInput identity changes per render; the ref guards a single run
	useEffect(() => {
		if (!initialMessageRef.current) return;
		if (isInitializing || chatQuery.isLoading || chatContextQuery.isLoading)
			return;
		if (isAgenticMode) return; // AgenticChatPanel seeds its own first message
		if (!isModeSelected) return;
		if (messages.length > 0) return;
		const seed = initialMessageRef.current;
		initialMessageRef.current = null;
		window.history.replaceState({}, "");
		pendingInitialMessageRef.current = seed;
		setInput(seed);
	}, [
		isInitializing,
		chatQuery.isLoading,
		chatContextQuery.isLoading,
		isAgenticMode,
		isModeSelected,
		messages.length,
	]);

	// Step 2: once the input reflects the seeded text, send it through the
	// same path a manual Enter/Send would use (turn-limit guard, conversation
	// lock, posthog capture). Consumed exactly once via the ref.
	// biome-ignore lint/correctness/useExhaustiveDependencies: guardedSubmit is recreated per render; the ref guards a single run
	useEffect(() => {
		if (!pendingInitialMessageRef.current) return;
		if (normalizedInput !== pendingInitialMessageRef.current) return;
		pendingInitialMessageRef.current = null;
		// With nothing attached, Specific Details has no conversations to answer
		// from. Leave the question in the box and let the alert below ask for a
		// selection first, instead of firing an answerless turn.
		if (needsConversations) return;
		guardedSubmit();
	}, [normalizedInput, needsConversations]);

	// check if assistant is typing by determining if the last message is an assistant message and has a text part
	const isAssistantTyping =
		messages &&
		messages.length > 0 &&
		messages[messages.length - 1].role === "assistant" &&
		messages[messages.length - 1].parts?.some((part) => part.type === "text");

	const computedChatForCopy = useMemo(() => {
		const messagesList = messages.map((message) =>
			// @ts-expect-error chatHistoryQuery.data is not typed
			formatMessage(message, "Host", "dembrane"),
		);
		return messagesList.join("\n\n\n\n");
	}, [messages]);

	const handleTemplateSelect = ({
		content,
		key,
	}: {
		content: string;
		key: string;
	}) => {
		const previousInput = normalizedInput;
		const previousTemplateKey = templateKey;

		if (previousInput === content) return;

		setInput(content);
		setTemplateKey(key);

		toast(t`Template applied`, {
			action: {
				label: t`Undo`,
				onClick: () => {
					setInput(previousInput);
					setTemplateKey(previousTemplateKey);
				},
			},
			duration: 5000,
		});
	};

	// Clear template selection when input becomes empty
	useEffect(() => {
		if (normalizedInput.trim() === "" && templateKey) {
			setTemplateKey(null);
		}
	}, [normalizedInput, templateKey, setTemplateKey]);

	// Bump this whenever the assistant finishes responding, so
	// ChatTemplatesMenuConnected knows to refetch suggestions.
	const [assistantResponseTick, setAssistantResponseTick] = useState(0);
	const prevIsLoadingRef = useRef(isLoading);
	const lastMessageRole = messages?.[messages.length - 1]?.role;

	useEffect(() => {
		// Detect transition from loading to not loading with assistant message
		if (
			prevIsLoadingRef.current &&
			!isLoading &&
			lastMessageRole === "assistant"
		) {
			setAssistantResponseTick((n) => n + 1);
		}
		prevIsLoadingRef.current = isLoading;
	}, [isLoading, lastMessageRole]);

	if (isInitializing || chatQuery.isLoading || chatContextQuery.isLoading) {
		return (
			<div className="flex h-full items-center justify-center">
				<LoadingOverlay visible={true} />
			</div>
		);
	}

	// Observer read-only wall: no chat. Point them at their workspace admin
	// (the upgrade is an admin changing their role to External).
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

	// Only auto-assign a mode when agentic is the default, and only for a chat
	// with nothing in it. Availability is not default-ness: thousands of chats
	// still carry chat_mode NULL, and converting one on open would hide its
	// existing thread behind the agentic panel with no way back.
	if (chatScreen === "agentic-auto") {
		return (
			<AutoInitializeAgentic
				chatId={chatId ?? ""}
				projectId={projectId ?? ""}
				onInitialized={() => chatContextQuery.refetch()}
			/>
		);
	}

	// A mode-less chat with no messages has nothing to lose, so let the host
	// pick. One that already has a thread falls through to it below and is
	// never offered the choice.
	if (chatScreen === "mode-picker") {
		return (
			<Box className="flex min-h-full items-center justify-center px-2 pr-4">
				<ChatModeSelector
					chatId={chatId ?? ""}
					projectId={projectId ?? ""}
					onModeSelected={async (mode) => {
						// chat_mode_selected is captured inside ChatModeSelector
						// Only prefetch suggestions for overview mode
						// Deep dive mode will fetch suggestions when conversations are added
						if (chatId && mode === "overview") {
							prefetchSuggestions(chatId, language, 5000);
						}
						chatContextQuery.refetch();
					}}
				/>
			</Box>
		);
	}

	if (ENABLE_AGENTIC_CHAT && chatMode === "agentic") {
		return (
			<AgenticChatPanel chatId={chatId ?? ""} projectId={projectId ?? ""} />
		);
	}

	return (
		<Stack
			className="relative flex min-h-full flex-col px-2 pr-4"
			{...testId("chat-interface")}
		>
			{/* Header */}
			<Stack className="top-0 w-full pt-6">
				<Group justify="space-between">
					<Group gap="sm">
						<Title order={1} {...testId("chat-title")}>
							{chatQuery.data?.name ?? t`Chat`}
						</Title>
						{chatMode && <ChatModeIndicator mode={chatMode} size="sm" />}
					</Group>
					<Group>
						<CopyRichTextIconButton
							markdown={`# ${chatQuery.data?.name ?? t`Chat`}\n\n${computedChatForCopy}`}
						/>
						<ErrorBoundary fallback={null}>
							{chatQuery.data && (
								<ChatAccordionItemMenu
									chat={chatQuery.data as ProjectChat}
									size="sm"
								/>
							)}
						</ErrorBoundary>
					</Group>
				</Group>
				<Divider />
			</Stack>
			{/* Body */}
			<Box className="flex-grow" ref={threadAnchorRef}>
				<Stack py="sm" pb="xl" className="relative h-full w-full">
					<ChatHistoryMessage
						// @ts-expect-error chatHistoryQuery.data is not typed
						message={{
							content:
								chatMode === "overview"
									? t`Welcome to Overview Mode! I have summaries of all your conversations loaded. Ask me about patterns, themes, and insights across your data. For exact quotes, start a new chat in Specific Context mode.`
									: t`Welcome to dembrane chat. Select the conversations you want to analyse, then ask about details, quotes, and summaries.`,
							id: "init",
							role: "assistant",
						}}
						referenceIds={referenceIds}
						setReferenceIds={setReferenceIds}
						chatMode={chatMode}
					/>

					{/* get everything except the last message */}
					{messages &&
						messages.length > 0 &&
						messages.slice(0, -1).map((message) => (
							<div key={message.id}>
								<ChatHistoryMessage
									// @ts-expect-error chatHistoryQuery.data is not typed
									message={message}
									referenceIds={referenceIds}
									setReferenceIds={setReferenceIds}
									chatMode={chatMode}
									onSaveAsTemplate={handleSaveAsTemplate}
								/>
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
									referenceIds={referenceIds}
									setReferenceIds={setReferenceIds}
									chatMode={chatMode}
									onSaveAsTemplate={handleSaveAsTemplate}
								/>
							</div>
						)}

					{isLoading && (
						<Stack gap="xs">
							<Group>
								<Box className="animate-spin">
									<Logo hideTitle hideEnvBadge alwaysDembrane h="20px" my={4} />
								</Box>
								<Text
									size="sm"
									className="italic"
									{...testId("chat-thinking-text")}
								>
									<Trans>
										{isAssistantTyping
											? "Assistant is typing..."
											: "Thinking..."}
									</Trans>
								</Text>
								<Button
									onClick={() => stop()}
									variant="outline"
									size="sm"
									rightSection={<IconSquare size={14} />}
									{...testId("chat-stop-button")}
								>
									<Trans>Stop</Trans>
								</Button>
							</Group>
							{statusMessage && (
								<Text size="sm" c="dimmed">
									{statusMessage}
								</Text>
							)}
						</Stack>
					)}

					{messages &&
						messages.length > 0 &&
						messages[messages.length - 1].role === "assistant" && (
							<div ref={lastMessageRef}>
								<ChatHistoryMessage
									// @ts-expect-error chatHistoryQuery.data is not typed
									message={messages[messages.length - 1]}
									referenceIds={referenceIds}
									setReferenceIds={setReferenceIds}
									chatMode={chatMode}
								/>
							</div>
						)}

					{error && (
						<Alert
							icon={<IconAlertCircle size="1rem" />}
							title="Error"
							color="red"
							variant="outline"
							{...testId("chat-error-alert")}
						>
							<Text>
								<Trans>An error occurred.</Trans>
							</Text>
							<Button
								color="red"
								onClick={() => reload()}
								leftSection={<IconRefresh size="1rem" />}
								mt="md"
								{...testId("chat-retry-button")}
							>
								<Trans>Retry</Trans>
							</Button>
						</Alert>
					)}
				</Stack>
			</Box>

			{/* Footer */}
			<Box
				className="bottom-0 w-full pb-2 pt-4 md:sticky"
				style={{ backgroundColor: "var(--app-background)" }}
			>
				<Stack className="pb-2">
					{/* Scroll to bottom button */}
					<Group
						justify="center"
						className="absolute bottom-[105%] right-4 z-50 hidden md:flex"
					>
						<ScrollToBottomButton
							visible={showScrollButton}
							onClick={() => scrollToBottom("smooth")}
						/>
					</Group>

					<ChatTemplatesMenuConnected
						chatId={chatId}
						chatMode={chatMode}
						projectId={projectId}
						externalOpen={templatesModalOpen}
						onExternalClose={() => setTemplatesModalOpen(false)}
						onTemplateSelect={handleTemplateSelect}
						selectedTemplateKey={templateKey}
						saveAsTemplateContent={saveAsTemplateContent}
						onClearSaveAsTemplate={() => setSaveAsTemplateContent(null)}
						refetchSuggestionsKey={assistantResponseTick}
					/>

					<Divider />
					{needsConversations && (
						<Alert
							icon={<IconAlertCircle size="1rem" />}
							p="xs"
							styles={{
								wrapper: { alignItems: "center" },
								title: { marginBottom: 0 },
							}}
							title={
								<Group gap="xl" wrap="nowrap" align="center">
									<Text component="span" inherit c="graphite">
										<Trans>Select a conversation to continue</Trans>
									</Text>
									<Button
										variant="subtle"
										size="compact-sm"
										leftSection={<ChatCircleTextIcon size={18} />}
										onClick={() => setConversationPickerOpen(true)}
										{...testId("chat-no-conversations-alert-select-button")}
									>
										<Trans>Select conversations</Trans>
									</Button>
								</Group>
							}
							color="orange"
							variant="light"
							{...testId("chat-no-conversations-alert")}
						/>
					)}

					{/* Only show context progress in deep dive mode - Big Picture uses dynamic summaries */}
					{chatMode !== "overview" && (
						<Box className="flex-grow">
							<ChatContextProgress chatId={chatId ?? ""} />
						</Box>
					)}
					{atTurnLimit && (
						<Box className="mb-2">
							<ChatTurnLimitCard onUpgrade={chatUpgradeHandlers.open} />
						</Box>
					)}
					<form
						onSubmit={(e) => {
							e.preventDefault();
							guardedSubmit();
						}}
					>
						<ChatComposerShell
							chips={
								chatMode !== "overview" &&
								contextToBeAdded &&
								contextToBeAdded.conversations.length > 0 ? (
									<ConversationFocusChips
										conversations={contextToBeAdded.conversations.map((c) => ({
											id: c.conversation_id,
											participant_name: c.conversation_participant_name,
										}))}
										isClearing={clearChatContextMutation.isPending}
										label={
											<Plural
												value={contextToBeAdded.conversations.length}
												one="Using # conversation:"
												other="Using # conversations:"
											/>
										}
										onClearAll={() =>
											clearChatContextMutation.mutate({
												chatId: chatId ?? "",
												conversationIds: contextToBeAdded.conversations.map(
													(c) => c.conversation_id,
												),
											})
										}
									/>
								) : undefined
							}
							footerLeft={
								chatMode !== "overview" ? (
									<Group gap={4} wrap="nowrap" align="center">
										<ConversationPickerButton
											ariaLabel={t`Select conversations`}
											label={<Trans>Select conversations</Trans>}
											onClick={() => setConversationPickerOpen(true)}
											testId="chat-select-conversations-button"
										/>
										{conversationCount > 0 && (
											<Badge variant="light">{conversationCount}</Badge>
										)}
									</Group>
								) : undefined
							}
							footerRight={
								<Button
									type="submit"
									size="md"
									radius="md"
									rightSection={<IconSend size={18} />}
									disabled={
										normalizedInput.trim() === "" ||
										isLoading ||
										isSubmitting ||
										atTurnLimit
									}
									{...testId("chat-send-button")}
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
								placeholder={t`Type a message or press / for templates...`}
								minRows={2}
								maxRows={10}
								autosize
								value={normalizedInput}
								onChange={handleInputChange}
								disabled={isLoading || isSubmitting || atTurnLimit}
								onKeyDown={(e) => {
									if (e.key === "/" && normalizedInput.trim() === "") {
										e.preventDefault();
										setTemplatesModalOpen(true);
										return;
									}
									if (e.key === "Enter" && !e.shiftKey) {
										e.preventDefault();
										e.stopPropagation();
										guardedSubmit();
									}
								}}
								{...testId("chat-input-textarea")}
							/>
						</ChatComposerShell>
						<Group
							justify="space-between"
							gap="sm"
							className="mt-1 hidden lg:flex"
						>
							<Text size="xs" className="italic" c="dimmed">
								<Trans>Use Shift + Enter to add a new line</Trans>
							</Text>
							<Text size="xs" className="italic" c="dimmed">
								<Trans>
									dembrane can make mistakes. Please double-check responses.
								</Trans>
							</Text>
						</Group>
						<Stack gap="sm" className="mt-1 flex lg:hidden">
							<Text size="xs" className="italic" c="dimmed">
								<Trans>Use Shift + Enter to add a new line</Trans>
							</Text>
							<Text size="xs" className="italic" c="dimmed">
								<Trans>
									dembrane can make mistakes. Please double-check responses.
								</Trans>
							</Text>
						</Stack>
					</form>
				</Stack>
			</Box>
			<Modal
				opened={conversationPickerOpen}
				onClose={() => setConversationPickerOpen(false)}
				title={t`Select conversations`}
				size="xl"
				padding="lg"
			>
				{projectId && (
					<ProjectConversationsPanel
						projectId={projectId}
						workspaceId={routeWorkspaceId ?? projectWorkspaceId}
						selectionChatId={chatId}
						selectionMode
					/>
				)}
			</Modal>
			<ChatUpgradeModal
				opened={chatUpgradeOpened}
				onClose={chatUpgradeHandlers.close}
				reason="chat_turns"
			/>
		</Stack>
	);
};
