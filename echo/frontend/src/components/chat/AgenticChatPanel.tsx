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
	TextInput,
	Title,
	Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
	IconAlertCircle,
	IconChevronDown,
	IconChevronRight,
	IconPlayerStop,
	IconSend,
	IconSparkles,
} from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { formatDate } from "date-fns";
import {
	type CSSProperties,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useUpdateChatMutation } from "@/components/chat/hooks";
import { ErrorBoundary } from "@/components/error/ErrorBoundary";
import { useElementOnScreen } from "@/hooks/useElementOnScreen";
import { useLanguage } from "@/hooks/useLanguage";
import { useWorkspace } from "@/hooks/useWorkspace";
import { useWorkspaceUsage } from "@/hooks/useWorkspaceUsage";
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
import {
	FREE_TIER_MAX_CHAT_USER_TURNS,
	isFreeTierLimitError,
} from "@/lib/freeTier";
import { testId } from "@/lib/testUtils";
import { CopyRichTextIconButton } from "../common/CopyRichTextIconButton";
import { ScrollToBottomButton } from "../common/ScrollToBottom";
import {
	extractTopLevelToolActivity,
	parseCustomVerificationTopicSuggestion,
	parseProjectUpdateSuggestion,
	type ToolActivity,
} from "./agenticToolActivity";
import { ChatAccordionItemMenu } from "./ChatAccordion";
import { ChatHistoryMessage } from "./ChatHistoryMessage";
import { CustomVerificationTopicSuggestionCard } from "./CustomVerificationTopicSuggestionCard";
import { formatMessage } from "./chatUtils";
import { ChatTurnLimitCard, ChatUpgradeModal } from "./FreeTierChatGate";
import { useChat as useProjectChat } from "./hooks";
import { ProjectUpdateSuggestionCard } from "./ProjectUpdateSuggestionCard";

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

// Internal placeholders the agent/worker may have persisted before the
// server-side guard landed. They are never meant to be shown to a host.
const INTERNAL_ASSISTANT_PLACEHOLDERS = new Set(["(calling tools)"]);

const isTerminalStatus = (status: AgenticRunStatus | null) =>
	status === "completed" || status === "failed" || status === "timeout";

const isInFlightStatus = (status: AgenticRunStatus | null) =>
	status === "queued" || status === "running";

const asObject = (value: unknown): Record<string, unknown> | null => {
	if (value && typeof value === "object")
		return value as Record<string, unknown>;
	return null;
};

const hasResponseStatus = (error: unknown, statusCode: number) => {
	const response = asObject(asObject(error)?.response);
	return response?.status === statusCode;
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
			const label = chunkId ? t`transcript excerpt` : t`transcript`;
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
		// Existing chats may hold the internal "(calling tools)" placeholder
		// (a Gemini crutch that leaked into persistence before the server-side
		// guard). Never render it — it only fragments the thread.
		if (INTERNAL_ASSISTANT_PLACEHOLDERS.has(content.trim())) {
			return null;
		}
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
				content: content ?? t`Agent run failed`,
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
					: t`Agent run failed`;
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
	{ dotColor: string; label: string; textColor: string }
> = {
	completed: {
		dotColor: "var(--agentic-tool-status-completed-dot)",
		label: t`Done`,
		textColor: "var(--agentic-tool-status-completed-text)",
	},
	error: {
		dotColor: "var(--agentic-tool-status-error-dot)",
		label: t`Error`,
		textColor: "var(--agentic-tool-status-error-text)",
	},
	running: {
		dotColor: "var(--agentic-tool-status-running-dot)",
		label: t`Running`,
		textColor: "var(--agentic-tool-status-running-text)",
	},
};

const AGENTIC_TOOL_STATUS_VARS = {
	"--agentic-tool-status-completed-dot": "var(--mantine-color-green-6)",
	"--agentic-tool-status-completed-text": "var(--mantine-color-green-8)",
	"--agentic-tool-status-error-dot": "var(--mantine-color-red-6)",
	"--agentic-tool-status-error-text": "var(--mantine-color-red-8)",
	"--agentic-tool-status-running-dot": "var(--mantine-color-yellow-6)",
	"--agentic-tool-status-running-ping-dot": "var(--mantine-color-yellow-4)",
	"--agentic-tool-status-running-text": "var(--mantine-color-yellow-8)",
} as CSSProperties;

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

type ToolActivityItem = Extract<TimelineItem, { kind: "tool" }>;

/** A single humane tool-activity line: status dot, plain-language headline,
 * and a timestamp. Raw tool input/output is intentionally NOT shown here — it
 * is internal machinery and lives on the /debug page, not in the host chat. */
const ToolActivityRow = ({ item }: { item: ToolActivityItem }) => {
	const statusMeta = TOOL_STATUS_META[item.status];
	return (
		<Group
			justify="space-between"
			gap="xs"
			wrap="nowrap"
			{...testId(`agentic-tool-row-${item.id}`)}
		>
			<Group gap={8} wrap="nowrap" className="min-w-0 flex-1">
				<Box
					aria-hidden="true"
					className={`h-1.5 w-1.5 shrink-0 rounded-full ${item.status === "running" ? "animate-pulse" : ""}`}
					style={{ backgroundColor: statusMeta.dotColor }}
				/>
				<Text className="min-w-0 flex-1 truncate text-xs leading-4 text-slate-700">
					{item.headline}
				</Text>
			</Group>
			<Text className="shrink-0 pt-[1px] text-xs text-slate-500">
				{formatDate(new Date(item.timestamp), "h:mm a")}
			</Text>
		</Group>
	);
};

/** Folds consecutive tool activity into one calm block. A single step renders
 * as one line (no redundant expand); several steps collapse behind a summary
 * that expands to the plain-language list. No raw tool I/O either way. */
const ToolActivityGroup = ({
	items,
	expanded,
	onToggle,
}: {
	items: ToolActivityItem[];
	expanded: boolean;
	onToggle: () => void;
}) => {
	const running = items.some((i) => i.status === "running");
	const errored = items.some((i) => i.status === "error");
	const runningItem = items.find((i) => i.status === "running");
	const isSingle = items.length === 1;
	const summary = running
		? (runningItem?.headline ?? t`Working...`)
		: isSingle
			? items[0].headline
			: t`Worked through ${items.length} steps`;
	const dotColor = errored
		? "var(--agentic-tool-status-error-dot)"
		: running
			? "var(--agentic-tool-status-running-dot)"
			: "var(--agentic-tool-status-completed-dot)";

	return (
		<Box className="flex justify-start">
			<Paper
				className="w-full max-w-full rounded-md border border-slate-200/70 bg-slate-50/70 px-2.5 py-1.5 shadow-none md:max-w-[80%]"
				{...testId("agentic-tool-group")}
			>
				<Group
					justify="space-between"
					gap="xs"
					wrap="nowrap"
					className={isSingle ? undefined : "cursor-pointer"}
					onClick={isSingle ? undefined : onToggle}
				>
					<Group gap={8} wrap="nowrap" className="min-w-0 flex-1">
						<Box
							aria-hidden="true"
							className={`h-1.5 w-1.5 shrink-0 rounded-full ${running ? "animate-pulse" : ""}`}
							style={{ backgroundColor: dotColor }}
						/>
						<Text className="min-w-0 flex-1 truncate text-xs italic text-slate-600">
							{summary}
						</Text>
					</Group>
					{!isSingle && (
						<ActionIcon
							variant="subtle"
							color="gray"
							size="xs"
							radius="xl"
							aria-label={expanded ? t`Hide steps` : t`Show steps`}
							onClick={(event) => {
								event.stopPropagation();
								onToggle();
							}}
						>
							{expanded ? (
								<IconChevronDown size={12} />
							) : (
								<IconChevronRight size={12} />
							)}
						</ActionIcon>
					)}
				</Group>
				{!isSingle && (
					<Collapse in={expanded}>
						<Stack gap={8} className="mt-2 pl-1">
							{items.map((item) => (
								<ToolActivityRow key={item.id} item={item} />
							))}
						</Stack>
					</Collapse>
				)}
			</Paper>
		</Box>
	);
};

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
	// Optimistic echo of the host's message so it appears the instant they
	// hit send, before the run persists and streams it back.
	const [pendingUserMessage, setPendingUserMessage] = useState<{
		content: string;
		timestamp: string;
	} | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [isStopping, setIsStopping] = useState(false);
	const [isStreaming, setIsStreaming] = useState(false);
	const [isHydratingStoredRun, setIsHydratingStoredRun] = useState(false);
	const [streamFailureCount, setStreamFailureCount] = useState(0);
	const [error, setError] = useState<string | null>(null);
	const [expandedGroupIds, setExpandedGroupIds] = useState<
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

	// Fold consecutive tool activities into one collapsible "working" group so
	// the thread reads as a conversation, not a debug log. Messages and
	// settings-suggestion cards break a group.
	const timelineNodes = useMemo(() => {
		type Node =
			| {
					kind: "message";
					id: string;
					item: Extract<TimelineItem, { kind: "message" }>;
			  }
			| {
					kind: "suggestion";
					id: string;
					item: Extract<TimelineItem, { kind: "tool" }>;
			  }
			| {
					kind: "verification_suggestion";
					id: string;
					item: Extract<TimelineItem, { kind: "tool" }>;
			  }
			| {
					kind: "tool_group";
					id: string;
					items: Extract<TimelineItem, { kind: "tool" }>[];
			  };
		const nodes: Node[] = [];
		for (const item of timeline) {
			if (item.kind === "message") {
				nodes.push({ id: item.id, item, kind: "message" });
				continue;
			}
			if (parseProjectUpdateSuggestion(item)) {
				nodes.push({ id: item.id, item, kind: "suggestion" });
				continue;
			}
			if (parseCustomVerificationTopicSuggestion(item)) {
				nodes.push({ id: item.id, item, kind: "verification_suggestion" });
				continue;
			}
			const last = nodes[nodes.length - 1];
			if (last && last.kind === "tool_group") {
				last.items.push(item);
			} else {
				nodes.push({
					id: `group-${item.id}`,
					items: [item],
					kind: "tool_group",
				});
			}
		}
		return nodes;
	}, [timeline]);

	// Drop the optimistic echo once the persisted user message arrives.
	useEffect(() => {
		if (!pendingUserMessage) return;
		const landed = timeline.some(
			(item) =>
				item.kind === "message" &&
				item.role === "user" &&
				item.content === pendingUserMessage.content,
		);
		if (landed) setPendingUserMessage(null);
	}, [timeline, pendingUserMessage]);

	// Free tier: max 3 user turns per chat. The 4th routes to upgrade.
	const { workspace } = useWorkspace();
	const { freeTier } = useWorkspaceUsage(workspace?.id);
	const [upgradeOpened, upgradeHandlers] = useDisclosure(false);
	const userTurnCount = useMemo(
		() =>
			timeline.filter((item) => item.kind === "message" && item.role === "user")
				.length,
		[timeline],
	);
	const atTurnLimit = Boolean(
		freeTier?.active && userTurnCount >= FREE_TIER_MAX_CHAT_USER_TURNS,
	);

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
			formatMessage(message, "User", "dembrane"),
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
						setError(t`Live stream interrupted. Falling back to polling.`);
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

	useEffect(() => {
		const nextChatStorageKey = storageKeyForChat(chatId);
		void nextChatStorageKey;
		stopStream();
		setRunId(null);
		setRunStatus(null);
		setAfterSeq(0);
		setEvents([]);
		setError(null);
		setIsStopping(false);
		setIsSubmitting(false);
		setIsHydratingStoredRun(false);
		setStreamFailureCount(0);
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
			} catch (hydrateError) {
				if (hasResponseStatus(hydrateError, 404)) {
					window.localStorage.removeItem(key);
					return;
				}
				if (hydrateError instanceof Error) {
					console.warn("Failed to hydrate stored agentic run", hydrateError);
				}
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

	const handleSubmit = async (overrideMessage?: string) => {
		const message = (overrideMessage ?? input).trim();
		if (!message || !projectId || !chatId) return;
		if (isInFlightStatus(runStatus)) return;

		if (atTurnLimit) {
			upgradeHandlers.open();
			return;
		}

		setError(null);
		setIsSubmitting(true);
		setInput("");
		setPendingUserMessage({
			content: message,
			timestamp: new Date().toISOString(),
		});

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
			setPendingUserMessage(null);
			// Don't strand the host's message when the send fails: restore it to
			// the composer so it isn't lost (unless they've already typed a new one).
			setInput((current) => (current.length === 0 ? message : current));
			// Backend safety net: free-tier turn cap returns 402.
			if (isFreeTierLimitError(submitError) === "chat_turns") {
				upgradeHandlers.open();
			} else {
				const nextError =
					submitError instanceof Error
						? submitError.message
						: t`Failed to submit agentic message`;
				setError(nextError);
			}
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
				stopError instanceof Error ? stopError.message : t`Failed to stop run`;
			setError(nextError);
		} finally {
			setIsStopping(false);
		}
	};

	const isRunInFlight = isInFlightStatus(runStatus);
	const chatTitle = chatQuery.data?.name ?? t`Chat`;
	const updateChatMutation = useUpdateChatMutation();
	const [isEditingTitle, setIsEditingTitle] = useState(false);
	const [titleDraft, setTitleDraft] = useState("");
	const commitTitle = () => {
		const next = titleDraft.trim();
		setIsEditingTitle(false);
		if (!chatId || !projectId || !next || next === chatTitle) return;
		updateChatMutation.mutate({
			chatId,
			payload: { name: next },
			projectId,
		});
	};
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
	const toggleGroupDetails = useCallback((groupId: string) => {
		setExpandedGroupIds((prev) => ({ ...prev, [groupId]: !prev[groupId] }));
	}, []);

	return (
		<Stack
			className="relative flex min-h-full flex-col px-2 pr-4"
			style={AGENTIC_TOOL_STATUS_VARS}
			{...testId("chat-interface")}
		>
			<Stack className="top-0 w-full pt-6">
				<Group justify="space-between">
					<Group gap="xs" className="min-w-0 flex-1">
						{isEditingTitle ? (
							<TextInput
								autoFocus
								variant="unstyled"
								size="xl"
								className="min-w-0 flex-1"
								value={titleDraft}
								onChange={(event) => setTitleDraft(event.currentTarget.value)}
								onBlur={commitTitle}
								onKeyDown={(event) => {
									if (event.key === "Enter") {
										event.preventDefault();
										commitTitle();
									} else if (event.key === "Escape") {
										setIsEditingTitle(false);
									}
								}}
								{...testId("chat-title-input")}
							/>
						) : (
							<Tooltip label={t`Rename chat`} openDelay={400}>
								<Title
									order={1}
									className="cursor-text truncate"
									onClick={() => {
										setTitleDraft(chatTitle);
										setIsEditingTitle(true);
									}}
									{...testId("chat-title")}
								>
									{chatTitle}
								</Title>
							</Tooltip>
						)}
					</Group>
					<Group>
						<CopyRichTextIconButton
							size="md"
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
				<Group justify="flex-end" gap="sm">
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

					{!showExistingChatLoading &&
						timeline.length === 0 &&
						!pendingUserMessage && (
							<Stack
								align="center"
								justify="center"
								gap="md"
								className="grow px-6 py-12 text-center"
								{...testId("agentic-empty-state")}
							>
								<IconSparkles
									size={26}
									className="text-[var(--mantine-color-primary-6)]"
								/>
								<Title order={3} fw={500} className="max-w-md">
									<Trans>Where would you like to start?</Trans>
								</Title>
								<Text size="sm" c="dimmed" maw={420}>
									<Trans>
										Ask a question about the conversations in this project, or
										get help setting it up. Any change is proposed for review
										first, and nothing is saved until it's approved.
									</Trans>
								</Text>
								<Group
									justify="center"
									gap="xs"
									className="max-w-lg flex-wrap pt-1"
								>
									{[
										{
											key: "list",
											label: t`List my conversations`,
											prompt: t`List the conversations in this project.`,
										},
										{
											key: "themes",
											label: t`What themes came up?`,
											prompt: t`What themes came up across the conversations in this project?`,
										},
										{
											key: "settings",
											label: t`Improve my setup`,
											prompt: t`Review my project settings and suggest improvements.`,
										},
									].map((starter) => (
										<Button
											key={starter.key}
											variant="default"
											size="xs"
											radius="xl"
											onClick={() => void handleSubmit(starter.prompt)}
										>
											{starter.label}
										</Button>
									))}
								</Group>
							</Stack>
						)}

					{timelineNodes.map((node) => {
						if (node.kind === "message") {
							return (
								<div key={node.id}>
									<ChatHistoryMessage
										message={toHistoryMessage(node.item)}
										chatMode="agentic"
									/>
								</div>
							);
						}

						if (node.kind === "suggestion") {
							const suggestion = parseProjectUpdateSuggestion(node.item);
							return suggestion ? (
								<div key={node.id}>
									<ProjectUpdateSuggestionCard suggestion={suggestion} />
								</div>
							) : null;
						}

						if (node.kind === "verification_suggestion") {
							const suggestion = parseCustomVerificationTopicSuggestion(
								node.item,
							);
							return suggestion ? (
								<div key={node.id}>
									<CustomVerificationTopicSuggestionCard
										suggestion={suggestion}
									/>
								</div>
							) : null;
						}

						return (
							<ToolActivityGroup
								key={node.id}
								items={node.items}
								expanded={Boolean(expandedGroupIds[node.id])}
								onToggle={() => toggleGroupDetails(node.id)}
							/>
						);
					})}

					{pendingUserMessage &&
						!timeline.some(
							(item) =>
								item.kind === "message" &&
								item.role === "user" &&
								item.content === pendingUserMessage.content,
						) && (
							<div key="pending-user-message">
								<ChatHistoryMessage
									message={toHistoryMessage({
										content: pendingUserMessage.content,
										id: "pending-user-message",
										role: "user",
										sortSeq: Number.MAX_SAFE_INTEGER,
										timestamp: pendingUserMessage.timestamp,
									})}
									chatMode="agentic"
								/>
							</div>
						)}
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
						className="absolute bottom-[105%] right-4 z-50 hidden md:flex"
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
									<Box
										className="absolute inset-0 rounded-full animate-ping"
										style={{
											backgroundColor:
												"var(--agentic-tool-status-running-ping-dot)",
										}}
									/>
									<Box
										className="relative h-2 w-2 rounded-full"
										style={{
											backgroundColor: "var(--agentic-tool-status-running-dot)",
										}}
									/>
								</Box>
								<Text className="max-w-[min(70vw,32rem)] truncate text-xs font-medium text-slate-600">
									{liveRunStatusText}
								</Text>
							</Group>
						</Paper>
					)}

					{atTurnLimit && (
						<ChatTurnLimitCard onUpgrade={upgradeHandlers.open} />
					)}
					<Divider />
					<form
						onSubmit={(event) => {
							event.preventDefault();
							void handleSubmit();
						}}
					>
						<Box className="rounded-xl border border-slate-200 bg-white px-3 pb-2 pt-2 shadow-sm transition-colors focus-within:border-slate-400">
							<Textarea
								variant="unstyled"
								styles={{ input: { backgroundColor: "transparent" } }}
								autosize
								minRows={2}
								maxRows={10}
								value={input}
								onChange={(event) => setInput(event.currentTarget.value)}
								placeholder={t`Ask about your conversations...`}
								disabled={atTurnLimit}
								onKeyDown={(event) => {
									if (event.key === "Enter" && !event.shiftKey) {
										event.preventDefault();
										void handleSubmit();
									}
								}}
								{...testId("chat-input-textarea")}
							/>
							<Group justify="space-between" align="center" gap="xs">
								<Text size="xs" c="dimmed" className="select-none">
									<Trans>Enter to send, Shift+Enter for a new line</Trans>
								</Text>
								<Button
									type="submit"
									size="sm"
									radius="md"
									leftSection={
										isSubmitting ? <Loader size={14} /> : <IconSend size={14} />
									}
									disabled={
										isSubmitting ||
										isRunInFlight ||
										input.trim().length === 0 ||
										atTurnLimit
									}
									{...testId("chat-send-button")}
								>
									<Trans>Send</Trans>
								</Button>
							</Group>
						</Box>
					</form>
				</Stack>
			</Box>
			<ChatUpgradeModal
				opened={upgradeOpened}
				onClose={upgradeHandlers.close}
				reason="chat_turns"
			/>
		</Stack>
	);
};
