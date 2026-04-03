import { useChat } from "@ai-sdk/react";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
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
} from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { ErrorBoundary } from "@sentry/react";
import {
	IconAlertCircle,
	IconRefresh,
	IconSend,
	IconSquare,
} from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { AgenticChatPanel } from "@/components/chat/AgenticChatPanel";
import {
	ChatAccordionItemMenu,
	ChatModeIndicator,
} from "@/components/chat/ChatAccordion";
import { ChatContextProgress } from "@/components/chat/ChatContextProgress";
import { ChatHistoryMessage } from "@/components/chat/ChatHistoryMessage";
import { ChatMessage } from "@/components/chat/ChatMessage";
import {
	ChatModeSelector,
	MODE_COLORS,
} from "@/components/chat/ChatModeSelector";
import { ChatTemplatesMenu } from "@/components/chat/ChatTemplatesMenu";
import {
	extractMessageMetadata,
	formatMessage,
} from "@/components/chat/chatUtils";
import {
	useAddChatMessageMutation,
	useChatHistory,
	useChatSuggestions,
	useLockConversationsMutation,
	usePrefetchSuggestions,
	useChat as useProjectChat,
	useProjectChatContext,
} from "@/components/chat/hooks";
import SourcesSearch from "@/components/chat/SourcesSearch";
import { CopyRichTextIconButton } from "@/components/common/CopyRichTextIconButton";
import { Logo } from "@/components/common/Logo";
import { ScrollToBottomButton } from "@/components/common/ScrollToBottom";
import { toast } from "@/components/common/Toaster";
import { ConversationLinks } from "@/components/conversation/ConversationLinks";
import { useConversationsCountByProjectId } from "@/components/conversation/hooks";
import {
	API_BASE_URL,
	ENABLE_AGENTIC_CHAT,
	ENABLE_CHAT_AUTO_SELECT,
} from "@/config";
import { useCurrentUser } from "@/components/auth/hooks";
import type { QuickAccessItem } from "@/components/chat/QuickAccessConfigurator";
import { TemplateRatingPills } from "@/components/chat/TemplateRatingPills";
import {
	useCreateUserTemplate,
	useDeleteUserTemplate,
	useMyRatings,
	useQuickAccessPreferences,
	useRatePromptTemplate,
	useSaveQuickAccessPreferences,
	useToggleAiSuggestions,
	useUpdateUserTemplate,
	useUserTemplates,
} from "@/components/chat/hooks/useUserTemplates";
import { Templates } from "@/components/chat/templates";
import { useElementOnScreen } from "@/hooks/useElementOnScreen";
import { useLanguage } from "@/hooks/useLanguage";
import { useLoadNotification } from "@/hooks/useLoadNotification";
import { testId } from "@/lib/testUtils";

const useDembraneChat = ({ chatId }: { chatId: string }) => {
	const chatHistoryQuery = useChatHistory(chatId);
	const chatContextQuery = useProjectChatContext(chatId);

	const [templateKey, setTemplateKey] = useState<string | null>(null);
	const [showProgress, setShowProgress] = useState(false);
	const [progressValue, setProgressValue] = useState(0);
	const [isSubmitting, setIsSubmitting] = useState(false);

	const addChatMessageMutation = useAddChatMessageMutation();
	const lockConversationsMutation = useLockConversationsMutation();

	const lastInput = useRef("");
	const lastMessageRef = useRef<HTMLDivElement>(null);

	const [scrollTargetRef, isVisible] = useElementOnScreen({
		root: null,
		rootMargin: "-83px",
		threshold: 0.1,
	});

	// biome-ignore lint/correctness/useExhaustiveDependencies: needs to be fixed
	const contextToBeAdded = useMemo(() => {
		if (!chatContextQuery.data) {
			return null;
		}
		return {
			auto_select_bool: chatContextQuery.data.auto_select_bool ?? false,
			conversations: chatContextQuery.data.conversations.filter(
				(c) => !c.locked,
			),
			locked_conversations: chatContextQuery.data.conversations.filter(
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
			console.log("onError", error);
		},
		onFinish: async (message) => {
			// this uses the response stream from the backend and makes a chat message IN THE FRONTEND
			// do this for now because - i dont want to do the stream text processing again in the backend
			// if someone navigates away before onFinish is completed, the message will be lost
			if (ENABLE_CHAT_AUTO_SELECT && contextToBeAdded?.auto_select_bool) {
				const flattenedItems = extractMessageMetadata(message);

				await addChatMessageMutation.mutateAsync({
					chat_message_metadata: flattenedItems ?? [],
					date_created: new Date().toISOString(),
					message_from: "assistant",
					project_chat_id: {
						id: chatId,
					} as ProjectChat,
					text: message.content,
				});
			} else {
				addChatMessageMutation.mutate({
					chat_message_metadata: [],
					date_created: new Date().toISOString(),
					message_from: "assistant",
					project_chat_id: {
						id: chatId,
					} as ProjectChat,
					text: message.content,
				});
			}

			// scroll to the last message
			lastMessageRef.current?.scrollIntoView({ behavior: "smooth" });
		},
		onResponse: async (_response) => {
			setShowProgress(false);
			setProgressValue(0);
			if (ENABLE_CHAT_AUTO_SELECT && contextToBeAdded?.auto_select_bool) {
				chatContextQuery.refetch();
			}
		},
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
			project_chat_id: {
				id: chatId,
			} as ProjectChat,
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
			await chatContextQuery.refetch();

			// Submit the chat
			handleSubmit();

			// Scroll to bottom when user submits a message
			setTimeout(() => {
				lastMessageRef.current?.scrollIntoView({ behavior: "smooth" });
			}, 0);

			if (ENABLE_CHAT_AUTO_SELECT && contextToBeAdded?.auto_select_bool) {
				setShowProgress(true);
				setProgressValue(0);
				// Start progress animation
				const interval = setInterval(() => {
					setProgressValue((prev) => {
						if (prev >= 95) {
							clearInterval(interval);
							return 95; // Cap at 95% to show it's still loading
						}
						return prev + 5;
					});
				}, 500);
			}
		} catch (error) {
			console.error("Error in customHandleSubmit:", error);
			if (ENABLE_CHAT_AUTO_SELECT && contextToBeAdded?.auto_select_bool) {
				setShowProgress(false);
				setProgressValue(0);
			}
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
		isVisible,
		lastInputRef: lastInput,
		lastMessageRef,
		messages,
		progressValue,
		reload,
		scrollTargetRef,
		setInput,
		setTemplateKey,
		showProgress,
		status,
		statusMessage,
		stop: customHandleStop,
		templateKey,
	};
};

export const ProjectChatRoute = () => {
	useDocumentTitle(t`Chat | Dembrane`);

	const { chatId, projectId } = useParams();
	const queryClient = useQueryClient();
	const chatQuery = useProjectChat(chatId ?? "");
	const chatContextQuery = useProjectChatContext(chatId ?? "");
	const [referenceIds, setReferenceIds] = useState<string[]>([]);
	const [templatesModalOpen, setTemplatesModalOpen] = useState(false);
	const [saveAsTemplateContent, setSaveAsTemplateContent] = useState<string | null>(null);

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
	const isLegacyChat = rawChatMode == null && hasLockedConversations;
	const chatMode = isLegacyChat ? "deep_dive" : rawChatMode;
	const isModeSelected = chatMode !== null && chatMode !== undefined;
	const isDeepDiveMode = chatMode === "deep_dive";
	const isAgenticMode = chatMode === "agentic";

	// Get total conversations count for overview mode
	const _totalConversationsQuery = useConversationsCountByProjectId(
		projectId ?? "",
	);

	// User templates & preferences
	const currentUserQuery = useCurrentUser();
	const userTemplatesQuery = useUserTemplates();
	const createUserTemplateMutation = useCreateUserTemplate();
	const updateUserTemplateMutation = useUpdateUserTemplate();
	const deleteUserTemplateMutation = useDeleteUserTemplate();
	const quickAccessQuery = useQuickAccessPreferences();
	const saveQuickAccessMutation = useSaveQuickAccessPreferences();
	const toggleAiSuggestionsMutation = useToggleAiSuggestions();
	const ratingsQuery = useMyRatings();
	const rateTemplateMutation = useRatePromptTemplate();

	const hideAiSuggestions =
		currentUserQuery.data?.hide_ai_suggestions ?? false;

	// Resolve quick access items — default to first 3 built-in templates
	const quickAccessItems: QuickAccessItem[] = useMemo(() => {
		if (!quickAccessQuery.data || quickAccessQuery.data.length === 0)
			return Templates.slice(0, 3).map((t) => ({
				type: "static" as const,
				id: t.id,
				title: t.title,
			}));
		return quickAccessQuery.data
			.map((pref) => {
				if (
					pref.template_type === "static" &&
					pref.static_template_id
				) {
					const found = Templates.find(
						(t) => t.id === pref.static_template_id,
					);
					if (found)
						return {
							type: "static" as const,
							id: found.id,
							title: found.title,
						};
				} else if (
					pref.template_type === "user" &&
					pref.prompt_template_id
				) {
					const found = userTemplatesQuery.data?.find(
						(t) => t.id === pref.prompt_template_id,
					);
					if (found)
						return {
							type: "user" as const,
							id: found.id,
							title: found.title,
						};
				}
				return null;
			})
			.filter(Boolean) as QuickAccessItem[];
	}, [quickAccessQuery.data, userTemplatesQuery.data]);

	const handleSaveQuickAccess = (items: QuickAccessItem[]) => {
		saveQuickAccessMutation.mutate(
			items.map((item, index) => ({
				template_type: item.type,
				static_template_id:
					item.type === "static" ? item.id : null,
				prompt_template_id:
					item.type === "user" ? item.id : null,
				sort: index + 1,
			})),
		);
	};

	// Language for suggestions
	const { language } = useLanguage();
	const prefetchSuggestions = usePrefetchSuggestions();

	// Track conversation count for deep_dive mode to trigger suggestions refetch
	const conversationCount = chatContextQuery.data?.conversations?.length ?? 0;
	const prevConversationCountRef = useRef<number | null>(null);

	// Fetch suggestions:
	// - Overview mode: Fetch immediately when mode is selected
	// - Deep dive mode: Only fetch after conversations are added (not on initial load)
	const shouldFetchSuggestions =
		isModeSelected &&
		!isAgenticMode &&
		!hideAiSuggestions &&
		(!isDeepDiveMode || // overview mode: always fetch
			conversationCount > 0); // deep_dive mode: only when conversations exist

	const suggestionsQuery = useChatSuggestions(chatId ?? "", {
		enabled: shouldFetchSuggestions,
		language,
	});

	// Refetch suggestions when conversation context changes in deep_dive mode
	// Cancel previous query and start a new one
	useEffect(() => {
		if (!isDeepDiveMode || !chatId) return;

		// Skip on initial mount
		if (prevConversationCountRef.current === null) {
			prevConversationCountRef.current = conversationCount;
			return;
		}

		// Only refetch if count actually changed
		if (prevConversationCountRef.current !== conversationCount) {
			prevConversationCountRef.current = conversationCount;

			// Cancel any in-flight suggestions query
			queryClient.cancelQueries({
				queryKey: ["chats", chatId, "suggestions", language],
			});

			// Refetch suggestions if we have conversations
			if (conversationCount > 0) {
				suggestionsQuery.refetch();
			}
		}
	}, [
		conversationCount,
		isDeepDiveMode,
		chatId,
		language,
		queryClient,
		suggestionsQuery,
	]);

	const {
		isInitializing,
		isLoading,
		isSubmitting,
		messages,
		input,
		error,
		contextToBeAdded,
		lastMessageRef,
		scrollTargetRef,
		isVisible,
		setInput,
		handleInputChange,
		handleSubmit,
		stop,
		reload,
		showProgress,
		progressValue,
		templateKey,
		setTemplateKey,
		statusMessage,
	} = useDembraneChat({ chatId: chatId ?? "" });
	const normalizedInput = typeof input === "string" ? input : "";

	// check if assistant is typing by determining if the last message is an assistant message and has a text part
	const isAssistantTyping =
		showProgress === false &&
		messages &&
		messages.length > 0 &&
		messages[messages.length - 1].role === "assistant" &&
		messages[messages.length - 1].parts?.some((part) => part.type === "text");

	const noConversationsSelected =
		contextToBeAdded?.conversations?.length === 0 &&
		contextToBeAdded?.locked_conversations?.length === 0;

	const computedChatForCopy = useMemo(() => {
		const messagesList = messages.map((message) =>
			// @ts-expect-error chatHistoryQuery.data is not typed
			formatMessage(message, "User", "Dembrane"),
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
		const previousInput = normalizedInput.trim();
		const previousTemplateKey = templateKey;

		setInput(content);
		setTemplateKey(key);

		// Show undo toast if there was existing input
		if (previousInput !== "") {
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
		}
	};

	// Clear template selection when input becomes empty
	useEffect(() => {
		if (normalizedInput.trim() === "" && templateKey) {
			setTemplateKey(null);
		}
	}, [normalizedInput, templateKey, setTemplateKey]);

	// Track if we need to refetch suggestions after assistant response
	const prevIsLoadingRef = useRef(isLoading);
	const lastMessageRole = messages?.[messages.length - 1]?.role;

	// Refetch suggestions when assistant finishes responding
	useEffect(() => {
		// Detect transition from loading to not loading with assistant message
		if (
			prevIsLoadingRef.current &&
			!isLoading &&
			lastMessageRole === "assistant"
		) {
			// Refetch suggestions after assistant response completes
			suggestionsQuery.refetch();
		}
		prevIsLoadingRef.current = isLoading;
	}, [isLoading, lastMessageRole, suggestionsQuery]);

	if (isInitializing || chatQuery.isLoading || chatContextQuery.isLoading) {
		return (
			<div className="flex h-full items-center justify-center">
				<LoadingOverlay visible={true} />
			</div>
		);
	}

	// Show mode selector if mode not yet selected
	if (!isModeSelected) {
		return (
			<Box className="flex min-h-full items-center justify-center px-2 pr-4">
				<ChatModeSelector
					chatId={chatId ?? ""}
					projectId={projectId ?? ""}
					onModeSelected={async (mode) => {
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
						<ErrorBoundary>
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
			<Box className="flex-grow">
				<Stack py="sm" pb="xl" className="relative h-full w-full">
					<ChatHistoryMessage
						// @ts-expect-error chatHistoryQuery.data is not typed
						message={{
							content:
								chatMode === "overview"
									? t`Welcome to Overview Mode! I have summaries of all your conversations loaded. Ask me about patterns, themes, and insights across your data. For exact quotes, start a new chat in Specific Context mode.`
									: t`Welcome to Dembrane Chat! Use the sidebar to select resources and conversations that you want to analyse. Then, you can ask questions about the selected resources and conversations.`,
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
						messages.slice(0, -1).map((message, idx) => (
							<div key={message.id}>
								<ChatHistoryMessage
									// @ts-expect-error chatHistoryQuery.data is not typed
									message={message}
									referenceIds={referenceIds}
									setReferenceIds={setReferenceIds}
									chatMode={chatMode}
									onSaveAsTemplate={handleSaveAsTemplate}
								/>
								{message.role === "assistant" &&
									idx > 0 &&
									// @ts-expect-error _original is not typed
									messages[idx - 1]?._original?.template_key && (
										<TemplateRatingPills
											// @ts-expect-error _original is not typed
											templateKey={messages[idx - 1]._original.template_key}
											messageId={message.id}
											ratings={ratingsQuery.data ?? []}
											onRate={(p) => rateTemplateMutation.mutate(p)}
											isRating={rateTemplateMutation.isPending}
										/>
									)}
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

					{ENABLE_CHAT_AUTO_SELECT && showProgress && (
						<SourcesSearch progressValue={progressValue} />
					)}

					{isLoading && !showProgress && (
						<Stack gap="xs">
							<Group>
								<Box className="animate-spin">
									<Logo hideTitle alwaysDembrane h="20px" my={4} />
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
								{messages.length >= 2 &&
									// @ts-expect-error _original is not typed
									messages[messages.length - 2]?._original?.template_key && (
										<TemplateRatingPills
											// @ts-expect-error _original is not typed
											templateKey={messages[messages.length - 2]._original.template_key}
											messageId={messages[messages.length - 1].id}
											ratings={ratingsQuery.data ?? []}
											onRate={(p) => rateTemplateMutation.mutate(p)}
											isRating={rateTemplateMutation.isPending}
										/>
									)}
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

			{/* Scroll target for scroll to bottom button */}
			<div ref={scrollTargetRef} aria-hidden="true" />

			{/* Footer */}
			<Box
				className="bottom-0 w-full pb-2 pt-4 md:sticky"
				style={{ backgroundColor: "var(--app-background)" }}
			>
				<Stack className="pb-2">
					{/* Scroll to bottom button */}
					<Group
						justify="center"
						className="absolute bottom-[105%] left-1/2 z-50 hidden translate-x-[-50%] md:flex"
					>
						<ScrollToBottomButton
							elementRef={scrollTargetRef}
							isVisible={isVisible}
						/>
					</Group>

					<ChatTemplatesMenu
						externalOpen={templatesModalOpen}
						onExternalClose={() => setTemplatesModalOpen(false)}
						onTemplateSelect={handleTemplateSelect}
						selectedTemplateKey={templateKey}
						suggestions={
							hideAiSuggestions
								? []
								: suggestionsQuery.data?.suggestions
						}
						chatMode={chatMode}
						userTemplates={userTemplatesQuery.data ?? []}
						onCreateUserTemplate={(payload) =>
							createUserTemplateMutation.mutateAsync(payload)
						}
						onUpdateUserTemplate={(payload) =>
							updateUserTemplateMutation.mutateAsync(payload)
						}
						onDeleteUserTemplate={(id) =>
							deleteUserTemplateMutation.mutateAsync(id)
						}
						isCreatingTemplate={
							createUserTemplateMutation.isPending
						}
						isUpdatingTemplate={
							updateUserTemplateMutation.isPending
						}
						isDeletingTemplate={
							deleteUserTemplateMutation.isPending
						}
						quickAccessItems={quickAccessItems}
						onSaveQuickAccess={handleSaveQuickAccess}
						isSavingQuickAccess={
							saveQuickAccessMutation.isPending
						}
						hideAiSuggestions={hideAiSuggestions}
						onToggleAiSuggestions={(hide) =>
							toggleAiSuggestionsMutation.mutate(hide)
						}
						saveAsTemplateContent={saveAsTemplateContent}
						onClearSaveAsTemplate={() => setSaveAsTemplateContent(null)}
					/>

					<Divider />
					{chatMode !== "overview" &&
						(!ENABLE_CHAT_AUTO_SELECT
							? noConversationsSelected
							: noConversationsSelected &&
								!contextToBeAdded?.auto_select_bool) && (
							<Alert
								icon={<IconAlertCircle size="1rem" />}
								title={t`Please select conversations from the sidebar to proceed`}
								color="orange"
								variant="light"
								{...testId("chat-no-conversations-alert")}
							/>
						)}

					{contextToBeAdded && contextToBeAdded.conversations.length > 0 && (
						// biome-ignore lint/a11y/useValidAriaRole: this is not an ARIA attribute
						<ChatMessage role="dembrane">
							<Group gap="xs" align="baseline">
								<Text size="xs" c="dimmed" fw={500} px="sm">
									<Trans>Conversations:</Trans>
								</Text>
								<ConversationLinks
									// @ts-expect-error conversation_id is not typed
									conversations={contextToBeAdded.conversations.map((c) => ({
										id: c.conversation_id,
										participant_name: c.conversation_participant_name,
									}))}
									color={
										ENABLE_CHAT_AUTO_SELECT && contextToBeAdded.auto_select_bool
											? "green"
											: "var(--app-text)"
									}
									hoverUnderlineColor={
										ENABLE_CHAT_AUTO_SELECT && contextToBeAdded.auto_select_bool
											? undefined
											: MODE_COLORS.deep_dive.primary
									}
								/>
							</Group>
						</ChatMessage>
					)}

					{/* Only show context progress in deep dive mode - Big Picture uses dynamic summaries */}
					{chatMode !== "overview" && (
						<Box className="flex-grow">
							<ChatContextProgress chatId={chatId ?? ""} />
						</Box>
					)}
					<form
						onSubmit={(e) => {
							e.preventDefault();
							handleSubmit();
						}}
					>
						<Group className="flex-nowrap">
							<Box className="grow">
								<Textarea
									placeholder={t`Type a message or press / for templates...`}
									minRows={4}
									maxRows={10}
									autosize
									value={normalizedInput}
									onChange={handleInputChange}
									disabled={isLoading || isSubmitting}
									onKeyDown={(e) => {
										if (e.key === "/" && normalizedInput.trim() === "") {
											e.preventDefault();
											setTemplatesModalOpen(true);
											return;
										}
										if (e.key === "Enter" && !e.shiftKey) {
											e.preventDefault();
											e.stopPropagation();
											handleSubmit();
										}
									}}
									color="gray"
									{...testId("chat-input-textarea")}
								/>
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
											Dembrane is powered by AI. Please double-check responses.
										</Trans>
									</Text>
								</Group>
							</Box>
							<Stack className="h-full self-start" gap="xs">
								<Box>
									<Button
										size="lg"
										type="submit"
										onClick={(e) => {
											e.preventDefault();
											e.stopPropagation();
											handleSubmit();
										}}
										rightSection={<IconSend size={24} />}
										disabled={
											normalizedInput.trim() === "" || isLoading || isSubmitting
										}
										{...testId("chat-send-button")}
									>
										<Trans>Send</Trans>
									</Button>
								</Box>
							</Stack>
						</Group>
						<Stack gap="sm" className="mt-1 flex lg:hidden">
							<Text size="xs" className="italic" c="dimmed">
								<Trans>Use Shift + Enter to add a new line</Trans>
							</Text>
							<Text size="xs" className="italic" c="dimmed">
								<Trans>
									Dembrane is powered by AI. Please double-check responses.
								</Trans>
							</Text>
						</Stack>
					</form>
				</Stack>
			</Box>
		</Stack>
	);
};
