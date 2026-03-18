import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Alert,
	Box,
	Button,
	Collapse,
	Divider,
	Group,
	Loader,
	Paper,
	Skeleton,
	Stack,
	Text,
	Textarea,
	Title,
	Tooltip,
} from "@mantine/core";
import { ErrorBoundary } from "@sentry/react";
import {
	IconAlertCircle,
	IconBraces,
	IconPlayerStop,
	IconSend,
} from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { formatDate } from "date-fns";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useElementOnScreen } from "@/hooks/useElementOnScreen";
import { useLanguage } from "@/hooks/useLanguage";
import type {
	AgenticRunEvent,
	AgenticRunEventsResponse,
	AgenticRunStatus,
} from "@/lib/api";
import {
	appendAgenticRunMessage,
	createAgenticRun,
	getAgenticRun,
	getAgenticRunEvents,
	stopAgenticRun,
	streamAgenticRun,
} from "@/lib/api";
import { testId } from "@/lib/testUtils";
import { CopyRichTextIconButton } from "../common/CopyRichTextIconButton";
import { ScrollToBottomButton } from "../common/ScrollToBottom";
import { toast } from "../common/Toaster";
import {
	extractTopLevelToolActivity,
	type ToolActivity,
} from "./agenticToolActivity";
import { ChatAccordionItemMenu, ChatModeIndicator } from "./ChatAccordion";
import { ChatHistoryMessage } from "./ChatHistoryMessage";
import { ChatTemplatesMenu } from "./ChatTemplatesMenu";
import { formatMessage } from "./chatUtils";
import { useChat as useProjectChat } from "./hooks";

type AgenticChatPanelProps = {
	chatId: string;
	projectId: string;
};

type RenderMessage = {
	id: string;
	role: "user" | "assistant";
	content: string;
	timestamp: string;
	sortSeq: number;
};

type TimelineItem =
	| (RenderMessage & {
			kind: "message";
	  })
	| (ToolActivity & {
			kind: "tool";
	  });

type HistoryLikeMessage = ChatHistory[number] & {
	createdAt: string;
};

const storageKeyForChat = (chatId: string) => `agentic-run:${chatId}`;

const isTerminalStatus = (status: AgenticRunStatus | null) =>
	status === "completed" || status === "failed" || status === "timeout";

const isInFlightStatus = (status: AgenticRunStatus | null) =>
	status === "queued" || status === "running";

const asObject = (value: unknown): Record<string, unknown> | null => {
	if (value && typeof value === "object")
		return value as Record<string, unknown>;
	return null;
};

const AGENTIC_REFERENCE_PATTERN =
	/\[conversation_id:([^;\]\s]+)(?:;chunk_id:([^\]\s]+))?\]/g;

const buildTranscriptLink = ({
	chunkId,
	conversationId,
	language,
	projectId,
}: {
	chunkId?: string;
	conversationId: string;
	language: string;
	projectId: string;
}) => {
	const encodedConversationId = encodeURIComponent(conversationId);
	const hash = chunkId ? `#chunk-${encodeURIComponent(chunkId)}` : "";
	return `/${language}/projects/${projectId}/conversation/${encodedConversationId}/transcript${hash}`;
};

const enrichAgenticContent = ({
	content,
	language,
	projectId,
}: {
	content: string;
	language: string;
	projectId: string;
}) =>
	content.replace(
		AGENTIC_REFERENCE_PATTERN,
		(_match, conversationIdRaw: string, chunkIdRaw?: string) => {
			const conversationId = conversationIdRaw.trim();
			const chunkId = chunkIdRaw?.trim();
			const label = chunkId ? "transcript excerpt" : "transcript";
			return `[${label}](${buildTranscriptLink({
				chunkId,
				conversationId,
				language,
				projectId,
			})})`;
		},
	);

const toMessage = ({
	event,
	language,
	projectId,
}: {
	event: AgenticRunEvent;
	language: string;
	projectId: string;
}): RenderMessage | null => {
	const payload = asObject(event.payload);

	const content =
		typeof payload?.content === "string"
			? payload.content
			: typeof payload?.message === "string"
				? payload.message
				: null;

	if (event.event_type === "agent.nudge") {
		return null;
	}

	if (event.event_type === "user.message" && content) {
		return {
			content: enrichAgenticContent({ content, language, projectId }),
			id: `u-${event.seq}`,
			role: "user",
			sortSeq: event.seq,
			timestamp: event.timestamp,
		};
	}

	if (event.event_type === "assistant.message" && content) {
		return {
			content: enrichAgenticContent({ content, language, projectId }),
			id: `a-${event.seq}`,
			role: "assistant",
			sortSeq: event.seq,
			timestamp: event.timestamp,
		};
	}

	if (event.event_type === "run.failed" || event.event_type === "run.timeout") {
		return {
			content: enrichAgenticContent({
				content: content ?? "Agent run failed",
				language,
				projectId,
			}),
			id: `a-${event.seq}`,
			role: "assistant",
			sortSeq: event.seq,
			timestamp: event.timestamp,
		};
	}

	if (event.event_type === "on_copilotkit_error") {
		const data =
			payload?.data && typeof payload.data === "object"
				? (payload.data as Record<string, unknown>)
				: null;
		const nestedError =
			data?.error && typeof data.error === "object"
				? (data.error as Record<string, unknown>)
				: null;
		const errorMessage =
			typeof nestedError?.message === "string"
				? nestedError.message
				: typeof data?.message === "string"
					? data.message
					: "Agent run failed";
		return {
			content: errorMessage,
			id: `e-${event.seq}`,
			role: "assistant",
			sortSeq: event.seq,
			timestamp: event.timestamp,
		};
	}

	return null;
};

const TOOL_STATUS_META: Record<
	ToolActivity["status"],
	{ dotClass: string; label: string; textClass: string }
> = {
	completed: {
		dotClass: "bg-emerald-500",
		label: "Done",
		textClass: "text-emerald-700",
	},
	error: {
		dotClass: "bg-red-500",
		label: "Error",
		textClass: "text-red-700",
	},
	running: {
		dotClass: "bg-amber-500",
		label: "Running",
		textClass: "text-amber-700",
	},
};

const toHistoryMessage = (message: RenderMessage): HistoryLikeMessage =>
	({
		_original: {
			added_conversations: [],
			chat_message_metadata: [],
			date_created: message.timestamp,
			date_updated: message.timestamp,
			id: message.id,
			message_from: message.role === "user" ? "User" : "assistant",
			project_chat_id: null,
			template_key: null,
			text: message.content,
			tokens_count: null,
			used_conversations: [],
		} as ProjectChatMessage,
		content: message.content,
		createdAt: message.timestamp,
		id: message.id,
		metadata: [],
		role: message.role,
	}) as HistoryLikeMessage;

export const AgenticChatPanel = ({
	chatId,
	projectId,
}: AgenticChatPanelProps) => {
	const { iso639_1, language } = useLanguage();
	const queryClient = useQueryClient();
	const chatQuery = useProjectChat(chatId);
	const [runId, setRunId] = useState<string | null>(null);
	const [runStatus, setRunStatus] = useState<AgenticRunStatus | null>(null);
	const [afterSeq, setAfterSeq] = useState(0);
	const [events, setEvents] = useState<AgenticRunEvent[]>([]);
	const [input, setInput] = useState("");
	const [templateKey, setTemplateKey] = useState<string | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [isStopping, setIsStopping] = useState(false);
	const [isStreaming, setIsStreaming] = useState(false);
	const [isHydratingStoredRun, setIsHydratingStoredRun] = useState(false);
	const [streamFailureCount, setStreamFailureCount] = useState(0);
	const [error, setError] = useState<string | null>(null);
	const [expandedToolIds, setExpandedToolIds] = useState<
		Record<string, boolean>
	>({});
	const streamAbortRef = useRef<AbortController | null>(null);
	const [scrollTargetRef, isVisible] = useElementOnScreen({
		root: null,
		rootMargin: "-83px",
		threshold: 0.1,
	});

	const timeline = useMemo(() => {
		const sorted = [...events].sort((a, b) => a.seq - b.seq);
		const items: TimelineItem[] = [];

		for (const event of sorted) {
			const topLevelMessage = toMessage({
				event,
				language,
				projectId,
			});
			if (topLevelMessage) {
				items.push({
					...topLevelMessage,
					kind: "message",
				});
			}
		}

		for (const activity of extractTopLevelToolActivity(sorted)) {
			items.push({
				...activity,
				kind: "tool",
			});
		}

		return items.sort((left, right) => left.sortSeq - right.sortSeq);
	}, [events, language, projectId]);

	const historyMessages = useMemo(
		() =>
			timeline
				.filter(
					(item): item is Extract<TimelineItem, { kind: "message" }> =>
						item.kind === "message",
				)
				.map(toHistoryMessage),
		[timeline],
	);

	const computedChatForCopy = useMemo(() => {
		const messagesList = historyMessages.map((message) =>
			formatMessage(message, "User", "Dembrane"),
		);
		return messagesList.join("\n\n\n\n");
	}, [historyMessages]);

	const mergeEvents = useCallback((incoming: AgenticRunEvent[]) => {
		if (incoming.length === 0) return;
		setEvents((previous) => {
			const bySeq = new Map<number, AgenticRunEvent>();
			for (const event of previous) bySeq.set(event.seq, event);
			for (const event of incoming) bySeq.set(event.seq, event);
			return Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);
		});
	}, []);

	const refreshEvents = useCallback(
		async (
			targetRunId: string,
			fromSeq: number,
		): Promise<AgenticRunEventsResponse> => {
			const payload = await getAgenticRunEvents(targetRunId, fromSeq);
			mergeEvents(payload.events);
			setAfterSeq(payload.next_seq);
			setRunStatus(payload.status);
			return payload;
		},
		[mergeEvents],
	);

	const loadAllEvents = useCallback(
		async (
			targetRunId: string,
			fromSeq: number,
		): Promise<AgenticRunEventsResponse> => {
			const collected: AgenticRunEvent[] = [];
			let cursor = fromSeq;
			let latestPayload: AgenticRunEventsResponse | null = null;

			for (let page = 0; page < 100; page += 1) {
				const payload = await getAgenticRunEvents(targetRunId, cursor);
				latestPayload = payload;

				if (payload.events.length === 0) {
					break;
				}

				collected.push(...payload.events);

				const lastEventSeq =
					payload.events[payload.events.length - 1]?.seq ?? cursor;
				const nextCursor = Math.max(cursor, payload.next_seq, lastEventSeq);
				if (nextCursor <= cursor) {
					break;
				}
				cursor = nextCursor;
			}

			if (!latestPayload) {
				const payload = await getAgenticRunEvents(targetRunId, fromSeq);
				mergeEvents(payload.events);
				setAfterSeq(payload.next_seq);
				setRunStatus(payload.status);
				return payload;
			}

			mergeEvents(collected);
			setAfterSeq(cursor);
			setRunStatus(latestPayload.status);
			return {
				...latestPayload,
				events: collected,
				next_seq: cursor,
			};
		},
		[mergeEvents],
	);

	const stopStream = useCallback(() => {
		if (streamAbortRef.current) {
			streamAbortRef.current.abort();
			streamAbortRef.current = null;
		}
		setIsStreaming(false);
	}, []);

	const startStream = useCallback(
		async (targetRunId: string, fromSeq: number) => {
			stopStream();

			const abortController = new AbortController();
			streamAbortRef.current = abortController;
			setIsStreaming(true);

			try {
				await streamAgenticRun(targetRunId, {
					afterSeq: fromSeq,
					onEvent: (event) => {
						mergeEvents([event]);
						setAfterSeq((previous) => Math.max(previous, event.seq));
						setStreamFailureCount(0);
						if (event.event_type === "run.failed") {
							setRunStatus("failed");
						}
						if (event.event_type === "run.timeout") {
							setRunStatus("timeout");
						}
					},
					signal: abortController.signal,
				});
			} catch (streamError) {
				if (abortController.signal.aborted) {
					return;
				}

				setStreamFailureCount((count) => {
					const next = count + 1;
					if (next >= 2) {
						setError("Live stream interrupted. Falling back to polling.");
					}
					return next;
				});

				if (streamError instanceof Error) {
					console.warn("Agentic stream failed", streamError);
				}
			} finally {
				if (streamAbortRef.current === abortController) {
					streamAbortRef.current = null;
					setIsStreaming(false);
				}
				try {
					const run = await getAgenticRun(targetRunId);
					setRunStatus(run.status);
				} catch {
					// Ignore status refresh failures; polling fallback will retry.
				}
			}
		},
		[mergeEvents, stopStream],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset panel state whenever chatId changes.
	useEffect(() => {
		stopStream();
		setRunId(null);
		setRunStatus(null);
		setAfterSeq(0);
		setEvents([]);
		setError(null);
		setTemplateKey(null);
		setIsStopping(false);
		setIsSubmitting(false);
		setIsHydratingStoredRun(false);
		setStreamFailureCount(0);
		setExpandedToolIds({});
	}, [chatId, stopStream]);

	useEffect(() => {
		if (!chatId) return;
		const key = storageKeyForChat(chatId);
		const storedRunId = window.localStorage.getItem(key);
		if (!storedRunId) return;

		let active = true;
		setIsHydratingStoredRun(true);
		(async () => {
			try {
				const run = await getAgenticRun(storedRunId);
				if (!active) return;
				setRunId(storedRunId);
				setRunStatus(run.status);
				const payload = await loadAllEvents(storedRunId, 0);
				if (!active) return;
				if (!isTerminalStatus(payload.status)) {
					void startStream(storedRunId, payload.next_seq);
				}
			} catch {
				window.localStorage.removeItem(key);
			} finally {
				if (active) {
					setIsHydratingStoredRun(false);
				}
			}
		})();

		return () => {
			active = false;
		};
	}, [chatId, loadAllEvents, startStream]);

	useEffect(() => {
		if (!runId || !runStatus || isTerminalStatus(runStatus)) return;
		if (isStreaming || streamFailureCount < 2) return;

		let active = true;
		const interval = window.setInterval(async () => {
			if (!active) return;
			try {
				await refreshEvents(runId, afterSeq);
			} catch {
				// Keep fallback polling retries lightweight.
			}
		}, 1500);

		return () => {
			active = false;
			window.clearInterval(interval);
		};
	}, [
		runId,
		runStatus,
		afterSeq,
		isStreaming,
		streamFailureCount,
		refreshEvents,
	]);

	useEffect(() => {
		if (runStatus && isTerminalStatus(runStatus)) {
			stopStream();
		}
	}, [runStatus, stopStream]);

	const scrollToBottom = useCallback(
		(behavior: ScrollBehavior = "smooth") => {
			window.requestAnimationFrame(() => {
				scrollTargetRef.current?.scrollIntoView({
					behavior,
					block: "end",
				});
			});
		},
		[scrollTargetRef],
	);

	useEffect(() => {
		if (timeline.length === 0) return;
		scrollToBottom("smooth");
	}, [timeline.length, scrollToBottom]);

	useEffect(() => {
		return () => {
			stopStream();
		};
	}, [stopStream]);

	const invalidateChatQueries = useCallback(() => {
		void queryClient.invalidateQueries({
			queryKey: ["chats", chatId],
		});
		void queryClient.invalidateQueries({
			queryKey: ["projects", projectId, "chats"],
		});
	}, [chatId, projectId, queryClient]);

	const handleTemplateSelect = ({
		content,
		key,
	}: {
		content: string;
		key: string;
	}) => {
		const previousInput = input.trim();
		const previousTemplateKey = templateKey;

		setInput(content);
		setTemplateKey(key);

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

	useEffect(() => {
		if (input.trim() === "" && templateKey) {
			setTemplateKey(null);
		}
	}, [input, templateKey]);

	const handleSubmit = async () => {
		const message = input.trim();
		if (!message || !projectId || !chatId) return;
		if (isInFlightStatus(runStatus)) return;

		setError(null);
		setIsSubmitting(true);
		setInput("");

		try {
			let targetRunId = runId;
			const nextLanguage = iso639_1 ?? "en";

			if (!targetRunId) {
				const created = await createAgenticRun({
					language: nextLanguage,
					message,
					project_chat_id: chatId,
					project_id: projectId,
				});
				targetRunId = created.id;
				setRunId(targetRunId);
				setRunStatus(created.status);
				window.localStorage.setItem(storageKeyForChat(chatId), targetRunId);
				invalidateChatQueries();
				const payload = await refreshEvents(targetRunId, 0);
				if (!isTerminalStatus(payload.status)) {
					void startStream(targetRunId, payload.next_seq);
				}
			} else {
				const updated = await appendAgenticRunMessage(targetRunId, {
					language: nextLanguage,
					message,
				});
				setRunStatus(updated.status);
				invalidateChatQueries();
				const payload = await refreshEvents(targetRunId, afterSeq);
				if (!isTerminalStatus(payload.status)) {
					void startStream(targetRunId, payload.next_seq);
				}
			}
		} catch (submitError) {
			const nextError =
				submitError instanceof Error
					? submitError.message
					: "Failed to submit agentic message";
			setError(nextError);
		} finally {
			setIsSubmitting(false);
		}
	};

	const handleStop = async () => {
		if (!runId || !isInFlightStatus(runStatus)) return;
		setIsStopping(true);
		setError(null);
		try {
			await stopAgenticRun(runId);
		} catch (stopError) {
			const nextError =
				stopError instanceof Error ? stopError.message : "Failed to stop run";
			setError(nextError);
		} finally {
			setIsStopping(false);
		}
	};

	const isRunInFlight = isInFlightStatus(runStatus);
	const chatTitle = chatQuery.data?.name ?? t`Chat`;
	const liveToolActivity = useMemo(
		() =>
			[...timeline]
				.reverse()
				.find(
					(item): item is Extract<TimelineItem, { kind: "tool" }> =>
						item.kind === "tool" && item.status === "running",
				),
		[timeline],
	);
	const liveRunStatusText =
		liveToolActivity?.headline ?? t`Agent is working...`;
	const showExistingChatLoading = isHydratingStoredRun && timeline.length === 0;
	const toggleToolDetails = useCallback((toolId: string) => {
		setExpandedToolIds((previous) => ({
			...previous,
			[toolId]: !previous[toolId],
		}));
	}, []);

	return (
		<Stack
			className="relative flex min-h-full flex-col px-2 pr-4"
			{...testId("chat-interface")}
		>
			<Stack className="top-0 w-full pt-6">
				<Group justify="space-between">
					<Group gap="sm">
						<Title order={1} {...testId("chat-title")}>
							{chatTitle}
						</Title>
						<ChatModeIndicator mode="agentic" size="sm" />
					</Group>
					<Group>
						<CopyRichTextIconButton
							markdown={`# ${chatTitle}\n\n${computedChatForCopy}`}
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
				<Group justify="space-between" gap="sm">
					<Group gap="xs">
						{runStatus && (
							<Text size="sm" c="dimmed">
								<Trans>Run status:</Trans> {runStatus}
							</Text>
						)}
					</Group>
					{isRunInFlight && (
						<Button
							variant="outline"
							size="xs"
							rightSection={
								isStopping ? <Loader size={12} /> : <IconPlayerStop size={12} />
							}
							onClick={() => void handleStop()}
							disabled={isStopping}
						>
							<Trans>Stop</Trans>
						</Button>
					)}
				</Group>
				<Divider />
			</Stack>

			<Box className="flex-grow">
				<Stack py="sm" pb="xl" className="relative h-full w-full">
					{error && (
						<Alert
							color="red"
							icon={<IconAlertCircle size={16} />}
							title={<Trans>Error</Trans>}
						>
							{error}
						</Alert>
					)}

					{showExistingChatLoading && (
						<Stack gap="md" {...testId("agentic-chat-loading")}>
							<Group gap="xs">
								<Loader size={14} color="gray" />
								<Text c="dimmed" size="sm">
									<Trans>Loading this chat...</Trans>
								</Text>
							</Group>
							<Box className="flex justify-start">
								<Paper className="w-full rounded-t-md rounded-br-md border border-slate-200 px-4 py-4 shadow-sm md:max-w-[72%]">
									<Stack gap="sm">
										<Skeleton height={12} width="52%" radius="xl" />
										<Skeleton height={12} width="84%" radius="xl" />
										<Skeleton height={12} width="68%" radius="xl" />
										<Skeleton height={10} width="24%" radius="xl" />
									</Stack>
								</Paper>
							</Box>
							<Box className="flex justify-end">
								<Paper className="w-full rounded-t-md rounded-bl-md border border-slate-200 px-4 py-4 shadow-sm md:max-w-[60%]">
									<Stack gap="sm">
										<Skeleton height={12} width="62%" radius="xl" />
										<Skeleton height={12} width="90%" radius="xl" />
										<Skeleton height={10} width="28%" radius="xl" />
									</Stack>
								</Paper>
							</Box>
						</Stack>
					)}

					{!showExistingChatLoading && timeline.length === 0 && (
						<Text c="dimmed" size="sm">
							<Trans>Send a message to start an agentic run.</Trans>
						</Text>
					)}

					{timeline.map((item) => {
						if (item.kind === "message") {
							return (
								<div key={item.id}>
									<ChatHistoryMessage
										message={toHistoryMessage(item)}
										chatMode="agentic"
									/>
								</div>
							);
						}

						const statusMeta = TOOL_STATUS_META[item.status];
						const hasRawData = item.rawInput || item.rawOutput || item.rawError;
						const isExpanded = Boolean(expandedToolIds[item.id]);

						return (
							<div key={item.id}>
								<Box className="flex justify-start">
									<Paper
										className="w-full max-w-full rounded-md border border-slate-200/80 bg-slate-50/80 px-2 py-1 shadow-none md:max-w-[80%]"
										{...testId(`agentic-tool-row-${item.id}`)}
									>
										<Stack gap={4}>
											<Group justify="space-between" gap="xs" wrap="nowrap">
												<Group gap={8} wrap="nowrap" className="min-w-0 flex-1">
													<Box
														aria-hidden="true"
														className={`mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full ${statusMeta.dotClass} ${item.status === "running" ? "animate-pulse" : ""}`}
													/>
													<Text className="min-w-0 flex-1 truncate text-[11px] font-medium leading-4 text-slate-700">
														{item.headline}
													</Text>
												</Group>
												<Group
													gap={6}
													wrap="nowrap"
													className="shrink-0 self-start"
												>
													<Text
														className={`pt-[1px] text-[10px] font-semibold uppercase tracking-wide ${statusMeta.textClass}`}
													>
														{statusMeta.label}
													</Text>
													<Text className="pt-[1px] text-[10px] text-slate-500">
														{formatDate(new Date(item.timestamp), "h:mm a")}
													</Text>
													{hasRawData && (
														<Tooltip
															label={
																isExpanded ? t`Hide raw data` : t`Show raw data`
															}
														>
															<ActionIcon
																variant={isExpanded ? "light" : "subtle"}
																color="gray"
																size="xs"
																radius="xl"
																aria-label={
																	isExpanded
																		? t`Hide raw data`
																		: t`Show raw data`
																}
																onClick={() => toggleToolDetails(item.id)}
																{...testId(
																	`agentic-tool-raw-toggle-${item.id}`,
																)}
															>
																<IconBraces size={10} />
															</ActionIcon>
														</Tooltip>
													)}
												</Group>
											</Group>
											<Collapse in={isExpanded}>
												<Stack
													gap={6}
													className="rounded border border-slate-200 bg-white p-2"
													{...testId(`agentic-tool-raw-panel-${item.id}`)}
												>
													{item.rawInput && (
														<Box>
															<Text className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
																Input
															</Text>
															<Text
																size="xs"
																component="pre"
																className="mt-1 whitespace-pre-wrap break-words rounded border border-slate-200 bg-slate-50 p-2 font-mono text-[11px] leading-4"
															>
																{item.rawInput}
															</Text>
														</Box>
													)}
													{item.rawOutput && (
														<Box>
															<Text className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
																Output
															</Text>
															<Text
																size="xs"
																component="pre"
																className="mt-1 whitespace-pre-wrap break-words rounded border border-slate-200 bg-slate-50 p-2 font-mono text-[11px] leading-4"
															>
																{item.rawOutput}
															</Text>
														</Box>
													)}
													{item.rawError && (
														<Box>
															<Text className="text-[10px] font-semibold uppercase tracking-wide text-red-600">
																Error
															</Text>
															<Text
																size="xs"
																component="pre"
																className="mt-1 whitespace-pre-wrap break-words rounded border border-red-100 bg-red-50 p-2 font-mono text-[11px] leading-4"
															>
																{item.rawError}
															</Text>
														</Box>
													)}
												</Stack>
											</Collapse>
										</Stack>
									</Paper>
								</Box>
							</div>
						);
					})}
				</Stack>
			</Box>

			<div ref={scrollTargetRef} aria-hidden="true" />

			<Box
				className="bottom-0 w-full pb-2 pt-4 md:sticky"
				style={{ backgroundColor: "var(--app-background)" }}
			>
				<Stack className="pb-2" gap="xs">
					<Group
						justify="center"
						className="absolute bottom-[105%] left-1/2 z-50 hidden translate-x-[-50%] md:flex"
					>
						<ScrollToBottomButton
							elementRef={scrollTargetRef}
							isVisible={isVisible}
						/>
					</Group>

					{isRunInFlight && (
						<Paper
							className="self-start rounded-full border border-slate-200/80 bg-slate-50/90 px-3 py-1.5 shadow-none"
							{...testId("agentic-run-indicator")}
						>
							<Group gap={8} wrap="nowrap">
								<Box className="relative h-2 w-2 shrink-0">
									<Box className="absolute inset-0 rounded-full bg-amber-400/70 animate-ping" />
									<Box className="relative h-2 w-2 rounded-full bg-amber-500" />
								</Box>
								<Text className="max-w-[min(70vw,32rem)] truncate text-[11px] font-medium text-slate-600">
									{liveRunStatusText}
								</Text>
							</Group>
						</Paper>
					)}

					<ChatTemplatesMenu
						onTemplateSelect={handleTemplateSelect}
						selectedTemplateKey={templateKey}
						chatMode="agentic"
					/>
					<Divider />
					<form
						onSubmit={(event) => {
							event.preventDefault();
							void handleSubmit();
						}}
					>
						<Group align="end" wrap="nowrap">
							<Textarea
								className="flex-1"
								autosize
								minRows={4}
								maxRows={10}
								value={input}
								onChange={(event) => setInput(event.currentTarget.value)}
								placeholder={t`Ask the agent...`}
								onKeyDown={(event) => {
									if (event.key === "Enter" && !event.shiftKey) {
										event.preventDefault();
										void handleSubmit();
									}
								}}
								{...testId("chat-input-textarea")}
							/>
							<Button
								type="submit"
								leftSection={
									isSubmitting ? <Loader size={14} /> : <IconSend size={14} />
								}
								disabled={
									isSubmitting || isRunInFlight || input.trim().length === 0
								}
								{...testId("chat-send-button")}
							>
								<Trans>Send</Trans>
							</Button>
						</Group>
					</form>
				</Stack>
			</Box>
		</Stack>
	);
};
