import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
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
	UnstyledButton,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
	IconAlertCircle,
	IconChevronDown,
	IconChevronRight,
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
import { useLocation } from "react-router";
import {
	useChatHistory,
	useUpdateChatMutation,
} from "@/components/chat/hooks";
import { InsertTemplateMenu } from "@/components/chat/InsertTemplateMenu";
import { useConversationsByProjectId } from "@/components/conversation/hooks";
import { ErrorBoundary } from "@/components/error/ErrorBoundary";
import { GoalSuggestionCard } from "@/components/goal/GoalSuggestionCard";
import { useElementOnScreen } from "@/hooks/useElementOnScreen";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
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
	parseCanvasSuggestion,
	parseCustomVerificationTopicSuggestion,
	parseGoalSuggestion,
	parseNavigationSuggestion,
	parseProjectUpdateSuggestion,
	type ToolActivity,
} from "./agenticToolActivity";
import { CanvasSuggestionCard } from "./CanvasSuggestionCard";
import { ChatAccordionItemMenu } from "./ChatAccordion";
import { ChatHistoryMessage } from "./ChatHistoryMessage";
import { CustomVerificationTopicSuggestionCard } from "./CustomVerificationTopicSuggestionCard";
import { formatMessage } from "./chatUtils";
import { ChatTurnLimitCard, ChatUpgradeModal } from "./FreeTierChatGate";
import { useChat as useProjectChat } from "./hooks";
import { NavigationSuggestionCard } from "./NavigationSuggestionCard";
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

// Fallback for malformed citations the model occasionally emits despite the
// prompt: plural tags and comma-separated id lists. Whatever still parses
// becomes links; a tag with nothing usable is dropped rather than rendered
// as a raw UUID wall.
const AGENTIC_REFERENCE_LIST_PATTERN = /\[conversation_ids?:\s*([^\]]+)\]/g;

const LOOKS_LIKE_ID_PATTERN = /^[0-9a-f][0-9a-f-]{7,}$/i;

const buildTranscriptLink = ({
	chunkId,
	conversationId,
	language,
	projectId,
	workspaceId,
}: {
	chunkId?: string;
	conversationId: string;
	language: string;
	projectId: string;
	workspaceId: string;
}) => {
	const encodedConversationId = encodeURIComponent(conversationId);
	const hash = chunkId ? `#chunk-${encodeURIComponent(chunkId)}` : "";
	// Dashboard routes are workspace-scoped; the conversation page handles the
	// #chunk-<id> deep link (ConversationTranscriptSection).
	return `/${language}/w/${workspaceId}/projects/${projectId}/conversations/${encodedConversationId}${hash}`;
};

const enrichAgenticContent = ({
	content,
	conversationNames,
	language,
	projectId,
	workspaceId,
}: {
	content: string;
	conversationNames?: Map<string, string>;
	language: string;
	projectId: string;
	workspaceId: string;
}) => {
	const linkFor = (conversationId: string, chunkId?: string) => {
		const name = conversationNames?.get(conversationId);
		const label = name
			? chunkId
				? t`${name}'s transcript excerpt`
				: t`${name}'s conversation`
			: chunkId
				? t`transcript excerpt`
				: t`transcript`;
		return `[${label}](${buildTranscriptLink({
			chunkId,
			conversationId,
			language,
			projectId,
			workspaceId,
		})})`;
	};

	return content
		.replace(
			AGENTIC_REFERENCE_PATTERN,
			(_match, conversationIdRaw: string, chunkIdRaw?: string) =>
				linkFor(conversationIdRaw.trim(), chunkIdRaw?.trim()),
		)
		.replace(AGENTIC_REFERENCE_LIST_PATTERN, (_match, body: string) => {
			const links = body
				.split(",")
				.map((token) => token.split(";")[0]?.trim() ?? "")
				.filter((token) => LOOKS_LIKE_ID_PATTERN.test(token))
				.map((conversationId) => linkFor(conversationId));
			return links.join(", ");
		});
};

const toMessage = ({
	conversationNames,
	event,
	language,
	projectId,
	workspaceId,
}: {
	conversationNames?: Map<string, string>;
	event: AgenticRunEvent;
	language: string;
	projectId: string;
	workspaceId: string;
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
			content: enrichAgenticContent({
				content,
				conversationNames,
				language,
				projectId,
				workspaceId,
			}),
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
			content: enrichAgenticContent({
				content,
				conversationNames,
				language,
				projectId,
				workspaceId,
			}),
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
				conversationNames,
				language,
				projectId,
				workspaceId,
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

const normalizeHistoryRole = (role: unknown): RenderMessage["role"] | null => {
	const normalized = String(role ?? "").trim().toLowerCase();
	if (normalized === "user") return "user";
	if (normalized === "assistant") return "assistant";
	return null;
};

const historyToRenderMessage = ({
	conversationNames,
	language,
	message,
	projectId,
	sortSeq,
	workspaceId,
}: {
	conversationNames?: Map<string, string>;
	language: string;
	message: ChatHistory[number];
	projectId: string;
	sortSeq: number;
	workspaceId: string;
}): RenderMessage | null => {
	const role = normalizeHistoryRole(message.role);
	const content = String(message.content ?? "").trim();
	if (!role || !content) return null;
	if (role === "assistant" && INTERNAL_ASSISTANT_PLACEHOLDERS.has(content)) {
		return null;
	}
	return {
		content: enrichAgenticContent({
			content,
			conversationNames,
			language,
			projectId,
			workspaceId,
		}),
		id: message.id,
		role,
		sortSeq,
		timestamp: message._original.date_created ?? new Date().toISOString(),
	};
};

const tryParseTimelineSuggestion = (
	item: Extract<TimelineItem, { kind: "tool" }>,
) => {
	try {
		return {
			canvas: parseCanvasSuggestion(item),
			customVerificationTopic: parseCustomVerificationTopicSuggestion(item),
			goal: parseGoalSuggestion(item),
			navigation: parseNavigationSuggestion(item),
			projectUpdate: parseProjectUpdateSuggestion(item),
		};
	} catch (error) {
		console.warn("Failed to parse agentic timeline suggestion", error);
		return {
			canvas: null,
			customVerificationTopic: null,
			goal: null,
			navigation: null,
			projectUpdate: null,
		};
	}
};

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
				<Text size="xs" className="min-w-0 flex-1 truncate">
					{item.headline}
				</Text>
			</Group>
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
	// Steps whose start/end ranges overlap ran at the same time; say so
	// instead of pretending they were sequential.
	const ranAllAtOnce =
		items.length > 1 &&
		items.every((item) =>
			items.every(
				(other) =>
					item === other ||
					(item.startSeq < other.endSeq && other.startSeq < item.endSeq),
			),
		);
	const summary = running
		? (runningItem?.headline ?? t`Working...`)
		: isSingle
			? items[0].headline
			: ranAllAtOnce
				? t`Ran ${items.length} steps at once`
				: t`Worked through ${items.length} steps`;
	const dotColor = errored
		? "var(--agentic-tool-status-error-dot)"
		: running
			? "var(--agentic-tool-status-running-dot)"
			: "var(--agentic-tool-status-completed-dot)";
	const lastTimestamp = items[items.length - 1]?.timestamp;

	return (
		<Box className="flex justify-start">
			<Paper
				// The theme defaults Paper to withBorder; tool activity is ambient,
				// not a card, so it stays borderless.
				withBorder={false}
				className="w-full max-w-full rounded-md px-2.5 py-1.5 shadow-none md:max-w-[80%]"
				style={{
					backgroundColor:
						"color-mix(in srgb, var(--app-background) 88%, var(--mantine-color-primary-1))",
				}}
				{...testId("agentic-tool-group")}
			>
				{/* The whole summary row is the toggle (keyboard included); the
				    chevron is decoration. Time shows once here, not per row. */}
				<UnstyledButton
					className="w-full"
					disabled={isSingle}
					aria-expanded={isSingle ? undefined : expanded}
					aria-label={
						isSingle ? undefined : expanded ? t`Hide steps` : t`Show steps`
					}
					onClick={isSingle ? undefined : onToggle}
				>
					<Group justify="space-between" gap="xs" wrap="nowrap">
						<Group gap={8} wrap="nowrap" className="min-w-0 flex-1">
							<Box
								aria-hidden="true"
								className={`h-1.5 w-1.5 shrink-0 rounded-full ${running ? "animate-pulse" : ""}`}
								style={{ backgroundColor: dotColor }}
							/>
							<Text size="xs" fs="italic" className="min-w-0 flex-1 truncate">
								{summary}
							</Text>
						</Group>
						<Group gap={6} wrap="nowrap" className="shrink-0">
							{lastTimestamp && (
								<Text
									size="xs"
									style={{ color: "var(--mantine-color-primary-6)" }}
								>
									{formatDate(new Date(lastTimestamp), "h:mm a")}
								</Text>
							)}
							{!isSingle &&
								(expanded ? (
									<IconChevronDown size={12} aria-hidden="true" />
								) : (
									<IconChevronRight size={12} aria-hidden="true" />
								))}
						</Group>
					</Group>
				</UnstyledButton>
				{!isSingle && (
					<Collapse in={expanded}>
						{/* pl-3.5 = dot width (6px) + gap (8px): sub-step dots line up
						    under the summary text, a clean one-level indent. */}
						<Stack gap={8} className="mt-2 pl-3.5">
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
	const { workspace, workspaceId } = useWorkspace();
	const location = useLocation();
	const navigate = useI18nNavigate();
	// Seed question from the Ask home page (router state), consumed exactly once.
	const initialMessageRef = useRef<string | null>(
		typeof (location.state as { initialMessage?: unknown } | null)
			?.initialMessage === "string"
			? (location.state as { initialMessage: string }).initialMessage
			: null,
	);
	const queryClient = useQueryClient();
	const chatQuery = useProjectChat(chatId);
	const persistedHistoryQuery = useChatHistory(chatId);
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
	const streamRunIdRef = useRef<string | null>(null);
	const stopArmedRunIdRef = useRef<string | null>(null);
	const requestedStreamKeyRef = useRef<string | null>(null);
	const currentRunIdRef = useRef<string | null>(null);
	const [scrollTargetRef, isVisible] = useElementOnScreen({
		root: null,
		rootMargin: "-83px",
		threshold: 0.1,
	});

	useEffect(() => {
		currentRunIdRef.current = runId;
	}, [runId]);

	// Citation links carry the participant's name when it resolves; generic
	// "transcript" is the fallback, never a raw id.
	const conversationsQuery = useConversationsByProjectId(projectId);
	const conversationNames = useMemo(() => {
		const names = new Map<string, string>();
		for (const conversation of conversationsQuery.data ?? []) {
			const name = (conversation.participant_name ?? "").trim();
			if (conversation.id && name) {
				names.set(conversation.id, name);
			}
		}
		return names;
	}, [conversationsQuery.data]);

	const timeline = useMemo(() => {
		const sorted = [...events].sort((a, b) => a.seq - b.seq);
		const items: TimelineItem[] = [];

		for (const event of sorted) {
			const topLevelMessage = toMessage({
				conversationNames,
				event,
				language,
				projectId,
				workspaceId: workspaceId ?? "",
			});
			if (topLevelMessage) {
				items.push({
					...topLevelMessage,
					kind: "message",
				});
			}
		}

		if (!items.some((item) => item.kind === "message")) {
			for (const [index, message] of (
				persistedHistoryQuery.data ?? []
			).entries()) {
				const rendered = historyToRenderMessage({
					conversationNames,
					language,
					message,
					projectId,
					sortSeq: index + 1,
					workspaceId: workspaceId ?? "",
				});
				if (rendered) {
					items.push({
						...rendered,
						kind: "message",
					});
				}
			}
		}

		for (const activity of extractTopLevelToolActivity(sorted)) {
			items.push({
				...activity,
				kind: "tool",
			});
		}

		return items.sort((left, right) => left.sortSeq - right.sortSeq);
	}, [
		events,
		language,
		projectId,
		workspaceId,
		conversationNames,
		persistedHistoryQuery.data,
	]);

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
					kind: "canvas_suggestion";
					id: string;
					item: Extract<TimelineItem, { kind: "tool" }>;
			  }
			| {
					kind: "goal_suggestion";
					id: string;
					item: Extract<TimelineItem, { kind: "tool" }>;
			  }
			| {
					kind: "navigation_suggestion";
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
			const suggestions = tryParseTimelineSuggestion(item);
			if (suggestions.projectUpdate) {
				nodes.push({ id: item.id, item, kind: "suggestion" });
				continue;
			}
			if (suggestions.customVerificationTopic) {
				nodes.push({ id: item.id, item, kind: "verification_suggestion" });
				continue;
			}
			if (suggestions.canvas) {
				nodes.push({ id: item.id, item, kind: "canvas_suggestion" });
				continue;
			}
			if (suggestions.goal) {
				nodes.push({ id: item.id, item, kind: "goal_suggestion" });
				continue;
			}
			if (suggestions.navigation) {
				nodes.push({ id: item.id, item, kind: "navigation_suggestion" });
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
		streamRunIdRef.current = null;
		requestedStreamKeyRef.current = null;
		setIsStreaming(false);
	}, []);

	const startStream = useCallback(
		async (targetRunId: string, fromSeq: number) => {
			const streamKey = `${targetRunId}:${fromSeq}`;
			if (
				requestedStreamKeyRef.current === streamKey &&
				streamAbortRef.current &&
				!streamAbortRef.current.signal.aborted
			) {
				return;
			}

			stopStream();

			const abortController = new AbortController();
			streamAbortRef.current = abortController;
			streamRunIdRef.current = targetRunId;
			requestedStreamKeyRef.current = streamKey;
			setIsStreaming(true);

			try {
				await streamAgenticRun(targetRunId, {
					afterSeq: fromSeq,
					onEvent: (event) => {
						if (currentRunIdRef.current !== targetRunId) return;
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
					streamRunIdRef.current = null;
					requestedStreamKeyRef.current = null;
					setIsStreaming(false);
				}
				try {
					const run = await getAgenticRun(targetRunId);
					if (currentRunIdRef.current === targetRunId) {
						setRunStatus(run.status);
					}
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
		if (!runId || !isInFlightStatus(runStatus)) return;
		if (isStreaming || streamFailureCount >= 2) return;
		void startStream(runId, afterSeq);
	}, [
		runId,
		runStatus,
		afterSeq,
		isStreaming,
		streamFailureCount,
		startStream,
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

	// Stick to the bottom only when the reader is already there (or just sent a
	// message). Someone scrolled up to read must never be yanked back down by a
	// streaming event; the scroll-to-bottom button is their way back. Bottomness
	// is read through a ref so this effect fires ONLY when new items land —
	// re-firing on visibility transitions made manual scrolling feel like it
	// bounced against the stream.
	const hasScrolledInitiallyRef = useRef(false);
	const forceNextScrollRef = useRef(false);
	const isAtBottomRef = useRef(true);
	useEffect(() => {
		isAtBottomRef.current = isVisible;
	}, [isVisible]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: chatId is the trigger, not a read — switching chats re-arms the initial jump
	useEffect(() => {
		hasScrolledInitiallyRef.current = false;
	}, [chatId]);
	useEffect(() => {
		if (timeline.length === 0) return;
		if (!hasScrolledInitiallyRef.current) {
			hasScrolledInitiallyRef.current = true;
			scrollToBottom("auto");
			return;
		}
		if (forceNextScrollRef.current || isAtBottomRef.current) {
			forceNextScrollRef.current = false;
			scrollToBottom("smooth");
		}
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
		// Sending is the one moment the host always wants the bottom.
		forceNextScrollRef.current = true;
		scrollToBottom("smooth");

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

	// A question typed on the Ask home page arrives as router state; send it as
	// the first message once, then clear the state so a refresh can't resend.
	// biome-ignore lint/correctness/useExhaustiveDependencies: handleSubmit is recreated per render; the ref guards a single run
	useEffect(() => {
		if (!initialMessageRef.current) return;
		if (runId || isHydratingStoredRun || isSubmitting) return;
		if (timeline.length > 0 || pendingUserMessage) return;
		const seed = initialMessageRef.current;
		initialMessageRef.current = null;
		window.history.replaceState({}, "");
		void handleSubmit(seed);
	}, [
		runId,
		isHydratingStoredRun,
		isSubmitting,
		timeline.length,
		pendingUserMessage,
	]);

	const armStopControl = () => {
		stopArmedRunIdRef.current = runId;
	};

	const handleStop = async () => {
		if (!runId || !isInFlightStatus(runStatus)) return;
		if (stopArmedRunIdRef.current !== runId) return;
		stopArmedRunIdRef.current = null;
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
		liveToolActivity?.headline ?? t`Working on your answer...`;
	const showExistingChatLoading = isHydratingStoredRun && timeline.length === 0;
	const toggleGroupDetails = useCallback((groupId: string) => {
		setExpandedGroupIds((prev) => ({ ...prev, [groupId]: !prev[groupId] }));
	}, []);

	return (
		// The panel owns its scrolling: fixed header, scrollable thread, fixed
		// composer. Riding the app-level scroll container made the header
		// collide with the breadcrumbs and the sticky composer misbehave.
		<Stack
			className="relative flex h-full min-h-0 flex-col overflow-hidden px-2 pr-4"
			style={AGENTIC_TOOL_STATUS_VARS}
			{...testId("chat-interface")}
		>
			<Stack className="w-full shrink-0 pt-4">
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
					<Tooltip
						label={<Trans>This is the new chat experience</Trans>}
						openDelay={300}
					>
						<Button
							variant="subtle"
							size="xs"
							onClick={() =>
								navigate(`/w/${workspaceId}/projects/${projectId}/chats/new`, {
									state: { preferMode: "deep_dive" },
								})
							}
						>
							<Trans>Open the old chat experience</Trans>
						</Button>
					</Tooltip>
				</Group>
				<Divider />
			</Stack>

			<Box className="min-h-0 flex-1 overflow-y-auto">
				<Stack py="sm" pb="xl" className="relative min-h-full w-full">
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
								<Loader size={14} color="primary" />
								<Text size="sm">
									<Trans>Loading this chat...</Trans>
								</Text>
							</Group>
							<Box className="flex justify-start">
								<Paper className="w-full rounded-t-md rounded-br-md px-4 py-4 shadow-sm md:max-w-[72%]">
									<Stack gap="sm">
										<Skeleton height={12} width="52%" radius="xl" />
										<Skeleton height={12} width="84%" radius="xl" />
										<Skeleton height={12} width="68%" radius="xl" />
										<Skeleton height={10} width="24%" radius="xl" />
									</Stack>
								</Paper>
							</Box>
							<Box className="flex justify-end">
								<Paper className="w-full rounded-t-md rounded-bl-md px-4 py-4 shadow-sm md:max-w-[60%]">
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
								<Text size="sm" maw={420}>
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
											variant="outline"
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

						if (node.kind === "canvas_suggestion") {
							const suggestion = parseCanvasSuggestion(node.item);
							return suggestion ? (
								<div key={node.id}>
									<CanvasSuggestionCard
										suggestion={{
											...suggestion,
											projectId: suggestion.projectId || projectId,
										}}
										chatId={chatId}
										onApplied={() => handleSubmit(t`I applied the canvas.`)}
									/>
								</div>
							) : null;
						}

						if (node.kind === "goal_suggestion") {
							const suggestion = parseGoalSuggestion(node.item);
							return suggestion ? (
								<div key={node.id}>
									<GoalSuggestionCard
										suggestion={{
											...suggestion,
											projectId: suggestion.projectId || projectId,
										}}
										chatId={chatId}
										onApplied={() => handleSubmit(t`I applied the goal.`)}
									/>
								</div>
							) : null;
						}

						if (node.kind === "navigation_suggestion") {
							const suggestion = parseNavigationSuggestion(node.item);
							return suggestion ? (
								<div key={node.id}>
									<NavigationSuggestionCard
										suggestion={{
											...suggestion,
											projectId: suggestion.projectId || projectId,
										}}
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
				<div ref={scrollTargetRef} aria-hidden="true" />
			</Box>

			<Box
				className="relative w-full shrink-0 pb-2 pt-2"
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
							className="self-start rounded-full px-3 py-1.5 shadow-none"
							style={{ borderColor: "var(--mantine-color-primary-light)" }}
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
								<Text
									size="xs"
									fw={500}
									className="max-w-[min(70vw,32rem)] truncate"
								>
									{liveRunStatusText}
								</Text>
								<Button
									type="button"
									size="compact-xs"
									radius="xl"
									variant="subtle"
									color="red"
									aria-label={t`Cancel current run`}
									onPointerDown={armStopControl}
									onKeyDown={(event) => {
										if (event.key === "Enter" || event.key === " ") {
											armStopControl();
										}
									}}
									onClick={() => void handleStop()}
									disabled={isStopping}
									leftSection={isStopping ? <Loader size={12} /> : undefined}
									{...testId("chat-stop-button")}
								>
									<Trans>Cancel</Trans>
								</Button>
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
						<Box
							className="rounded-xl border px-3 pb-2 pt-2 shadow-sm transition-colors"
							style={{
								backgroundColor: "var(--app-background)",
								borderColor: "var(--mantine-color-primary-light)",
							}}
						>
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
								<Group gap="xs">
									<InsertTemplateMenu
										workspaceId={workspaceId}
										onInsert={(content) => setInput(content)}
									/>
									<Text size="xs" className="select-none">
										<Trans>Enter to send, Shift+Enter for a new line</Trans>
									</Text>
								</Group>
								<Group gap="xs" wrap="nowrap">
									<Button
										type="submit"
										size="sm"
										radius="md"
										leftSection={
											isSubmitting ? (
												<Loader size={14} />
											) : (
												<IconSend size={14} />
											)
										}
										disabled={
											isSubmitting || input.trim().length === 0 || atTurnLimit
										}
										{...testId("chat-send-button")}
									>
										<Trans>Send</Trans>
									</Button>
								</Group>
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
