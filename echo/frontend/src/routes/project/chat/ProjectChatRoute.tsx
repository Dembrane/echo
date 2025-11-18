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
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { ChatAccordionItemMenu } from "@/components/chat/ChatAccordion";
import { ChatContextProgress } from "@/components/chat/ChatContextProgress";
import { ChatHistoryMessage } from "@/components/chat/ChatHistoryMessage";
import { ChatMessage } from "@/components/chat/ChatMessage";
import { ChatTemplatesMenu } from "@/components/chat/ChatTemplatesMenu";
import {
	extractMessageMetadata,
	formatMessage,
} from "@/components/chat/chatUtils";
import {
	useAddChatMessageMutation,
	useChatHistory,
	useLockConversationsMutation,
	useChat as useProjectChat,
	useProjectChatContext,
} from "@/components/chat/hooks";
import SourcesSearch from "@/components/chat/SourcesSearch";
import { CopyRichTextIconButton } from "@/components/common/CopyRichTextIconButton";
import { Logo } from "@/components/common/Logo";
import { ScrollToBottomButton } from "@/components/common/ScrollToBottom";
import { ConversationLinks } from "@/components/conversation/ConversationLinks";
import { API_BASE_URL, ENABLE_CHAT_AUTO_SELECT } from "@/config";
import { useElementOnScreen } from "@/hooks/useElementOnScreen";
import { useLanguage } from "@/hooks/useLanguage";

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
		stop: customHandleStop,
		templateKey,
	};
};

export const ProjectChatRoute = () => {
	useDocumentTitle(t`Chat | Dembrane`);

	const { chatId } = useParams();
	const chatQuery = useProjectChat(chatId ?? "");
	const [referenceIds, setReferenceIds] = useState<string[]>([]);

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
	} = useDembraneChat({ chatId: chatId ?? "" });

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
		if (
			input.trim() !== "" &&
			!window.confirm(t`This will clear your current input. Are you sure?`)
		) {
			return;
		}

		setInput(content);
		setTemplateKey(key);
	};

	// Clear template selection when input becomes empty
	useEffect(() => {
		if (input.trim() === "" && templateKey) {
			setTemplateKey(null);
		}
	}, [input, templateKey, setTemplateKey]);

	if (isInitializing || chatQuery.isLoading) {
		return (
			<div className="flex h-full items-center justify-center">
				<LoadingOverlay visible={true} />
			</div>
		);
	}

	return (
		<Stack className="relative flex min-h-full flex-col px-2 pr-4">
			{/* Header */}
			<Stack className="top-0 w-full bg-white pt-6">
				<Group justify="space-between">
					<Title order={1}>{chatQuery.data?.name ?? t`Chat`}</Title>
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
							content: t`Welcome to Dembrane Chat! Use the sidebar to select resources and conversations that you want to analyse. Then, you can ask questions about the selected resources and conversations.`,
							id: "init",
							role: "assistant",
						}}
						referenceIds={referenceIds}
						setReferenceIds={setReferenceIds}
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
								/>
							</div>
						)}

					{ENABLE_CHAT_AUTO_SELECT && showProgress && (
						<SourcesSearch progressValue={progressValue} />
					)}

					{isLoading && !showProgress && (
						<Group>
							<Box className="animate-spin">
								<Logo hideTitle h="20px" my={4} />
							</Box>
							<Text size="sm" className="italic">
								<Trans>
									{isAssistantTyping ? "Assistant is typing..." : "Thinking..."}
								</Trans>
							</Text>
							<Button
								onClick={() => stop()}
								variant="outline"
								color="gray"
								size="sm"
								rightSection={<IconSquare size={14} />}
							>
								<Trans>Stop</Trans>
							</Button>
						</Group>
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
								/>
							</div>
						)}

					{error && (
						<Alert
							icon={<IconAlertCircle size="1rem" />}
							title="Error"
							color="red"
							variant="outline"
						>
							<Text>
								<Trans>An error occurred.</Trans>
							</Text>
							<Button
								color="red"
								onClick={() => reload()}
								leftSection={<IconRefresh size="1rem" />}
								mt="md"
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
			<Box className="bottom-0 w-full bg-white pb-2 pt-4 md:sticky">
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
						onTemplateSelect={handleTemplateSelect}
						selectedTemplateKey={templateKey}
					/>

					<Divider />
					{(!ENABLE_CHAT_AUTO_SELECT
						? noConversationsSelected
						: noConversationsSelected &&
							!contextToBeAdded?.auto_select_bool) && (
						<Alert
							icon={<IconAlertCircle size="1rem" />}
							title={t`No transcripts are selected for this chat`}
							color="orange"
							variant="light"
						/>
					)}

					{contextToBeAdded && contextToBeAdded.conversations.length > 0 && (
						// biome-ignore lint/a11y/useValidAriaRole: this is not an ARIA attribute
						<ChatMessage role="dembrane">
							<Group gap="xs" align="baseline">
								<Text size="xs">
									<Trans>Adding Context:</Trans>
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
											: undefined
									}
								/>
							</Group>
						</ChatMessage>
					)}

					<Box className="flex-grow">
						<ChatContextProgress chatId={chatId ?? ""} />
					</Box>
					<form
						onSubmit={(e) => {
							e.preventDefault();
							handleSubmit();
						}}
					>
						<Group className="flex-nowrap">
							<Box className="grow">
								<Textarea
									placeholder={t`Type a message...`}
									minRows={4}
									maxRows={10}
									autosize
									value={input}
									onChange={handleInputChange}
									disabled={isLoading || isSubmitting}
									onKeyDown={(e) => {
										if (e.key === "Enter" && !e.shiftKey) {
											e.preventDefault();
											e.stopPropagation();
											handleSubmit();
										}
									}}
									color="gray"
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
											ECHO is powered by AI. Please double-check responses.
										</Trans>
									</Text>
								</Group>
							</Box>
							<Stack className="h-full" gap="xs">
								<Box>
									<Button
										size="lg"
										type="submit"
										variant="primary"
										onClick={(e) => {
											e.preventDefault();
											e.stopPropagation();
											handleSubmit();
										}}
										rightSection={<IconSend size={24} />}
										disabled={input.trim() === "" || isLoading || isSubmitting}
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
									ECHO is powered by AI. Please double-check responses.
								</Trans>
							</Text>
						</Stack>
					</form>
				</Stack>
			</Box>
		</Stack>
	);
};
