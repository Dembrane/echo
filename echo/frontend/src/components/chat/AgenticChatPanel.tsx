import { Trans } from "@lingui/react/macro";
import {
	Alert,
	Box,
	Button,
	Group,
	Loader,
	Stack,
	Text,
	Textarea,
	Title,
} from "@mantine/core";
import { IconAlertCircle, IconPlayerStop, IconSend } from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	AgenticRunEvent,
	AgenticRunEventsResponse,
	AgenticRunStatus,
} from "@/lib/api";
import {
	createAgenticRun,
	getAgenticRun,
	getAgenticRunEvents,
	stopAgenticRun,
	streamAgenticRun,
	appendAgenticRunMessage,
} from "@/lib/api";
import { Markdown } from "../common/Markdown";
import { ChatMessage } from "./ChatMessage";

type AgenticChatPanelProps = {
	chatId: string;
	projectId: string;
};

type RenderMessage = {
	id: string;
	role: "user" | "assistant" | "dembrane";
	content: string;
};

type ToolActivity = {
	id: string;
	title: string;
	details: string | null;
};

const storageKeyForChat = (chatId: string) => `agentic-run:${chatId}`;

const isTerminalStatus = (status: AgenticRunStatus | null) =>
	status === "completed" || status === "failed" || status === "timeout";

const isInFlightStatus = (status: AgenticRunStatus | null) =>
	status === "queued" || status === "running";

const MAX_ACTIVITY_DETAILS_LENGTH = 1200;

const truncate = (value: string, maxLength = MAX_ACTIVITY_DETAILS_LENGTH) => {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, maxLength)}...`;
};

const asObject = (value: unknown): Record<string, unknown> | null => {
	if (value && typeof value === "object") return value as Record<string, unknown>;
	return null;
};

const formatDetails = (value: unknown): string | null => {
	if (value === null || value === undefined) return null;

	if (typeof value === "string") {
		const trimmed = value.trim();
		if (!trimmed) return null;
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (parsed && typeof parsed === "object") {
				return truncate(JSON.stringify(parsed, null, 2));
			}
		} catch {
			// Keep raw string details.
		}
		return truncate(trimmed);
	}

	if (typeof value === "object") {
		try {
			return truncate(JSON.stringify(value, null, 2));
		} catch {
			return truncate(String(value));
		}
	}

	return truncate(String(value));
};

const toMessage = (event: AgenticRunEvent): RenderMessage | null => {
	const payload = asObject(event.payload);

	const content =
		typeof payload?.content === "string"
			? payload.content
			: typeof payload?.message === "string"
				? payload.message
				: null;

	if (event.event_type === "user.message" && content) {
		return { id: `u-${event.seq}`, role: "user", content };
	}

	if (event.event_type === "assistant.message" && content) {
		return { id: `a-${event.seq}`, role: "assistant", content };
	}

	if (event.event_type === "run.failed" || event.event_type === "run.timeout") {
		return {
			id: `s-${event.seq}`,
			role: "dembrane",
			content: content ?? "Agent run failed",
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
			id: `e-${event.seq}`,
			role: "dembrane",
			content: errorMessage,
		};
	}

	return null;
};

const extractAssistantMessagesFromStateSync = (
	event: AgenticRunEvent,
): RenderMessage[] => {
	if (event.event_type !== "on_copilotkit_state_sync") {
		return [];
	}

	const payload = asObject(event.payload);
	const state = asObject(payload?.state);
	const rawMessages = Array.isArray(state?.messages) ? state.messages : [];

	const results: RenderMessage[] = [];
	for (const rawMessage of rawMessages) {
		if (!rawMessage || typeof rawMessage !== "object") continue;
		const message = rawMessage as Record<string, unknown>;
		if (message.role !== "assistant") continue;
		if (
			typeof message.content !== "string" ||
			message.content.trim().length === 0
		)
			continue;

		const rawId = typeof message.id === "string" ? message.id : `${event.seq}`;
		results.push({
			id: `a-sync-${rawId}`,
			role: "assistant",
			content: message.content,
		});
	}

	return results;
};

const extractToolActivityFromStateSync = (event: AgenticRunEvent): ToolActivity[] => {
	if (event.event_type !== "on_copilotkit_state_sync") {
		return [];
	}

	const payload = asObject(event.payload);
	const state = asObject(payload?.state);
	const rawMessages = Array.isArray(state?.messages) ? state.messages : [];
	const activities: ToolActivity[] = [];

	rawMessages.forEach((rawMessage, messageIndex) => {
		const message = asObject(rawMessage);
		if (!message) return;

		if (message.role === "assistant") {
			const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
			toolCalls.forEach((rawCall, callIndex) => {
				const call = asObject(rawCall);
				if (!call) return;

				const functionPayload = asObject(call.function);
				const callId =
					(typeof call.id === "string" && call.id) ||
					`${event.seq}-${messageIndex}-${callIndex}`;
				const name =
					(typeof call.name === "string" && call.name) ||
					(typeof functionPayload?.name === "string" && functionPayload.name) ||
					"unknown_tool";
				const args = call.args ?? call.arguments ?? functionPayload?.arguments ?? null;

				activities.push({
					id: `tool-call-${callId}`,
					title: `Tool call: ${name}`,
					details: formatDetails(args),
				});
			});
		}

		if (message.role === "tool") {
			const toolName =
				(typeof message.name === "string" && message.name) ||
				(typeof message.tool_name === "string" && message.tool_name) ||
				"tool";
			const rawId =
				(typeof message.id === "string" && message.id) ||
				(typeof message.tool_call_id === "string" && message.tool_call_id) ||
				`${event.seq}-${messageIndex}`;

			activities.push({
				id: `tool-result-${rawId}`,
				title: `Tool result: ${toolName}`,
				details: formatDetails(message.content),
			});
		}
	});

	return activities;
};

const extractTopLevelToolActivity = (event: AgenticRunEvent): ToolActivity[] => {
	const eventType = event.event_type.toLowerCase();
	if (!eventType.includes("tool")) {
		return [];
	}

	const payload = asObject(event.payload);
	const maybeName =
		(typeof payload?.name === "string" && payload.name) ||
		(typeof payload?.tool_name === "string" && payload.tool_name) ||
		(typeof payload?.toolName === "string" && payload.toolName) ||
		null;
	const details =
		formatDetails(payload?.input ?? payload?.args ?? payload?.content ?? payload) ??
		formatDetails(event.payload);

	return [
		{
			id: `tool-event-${event.seq}`,
			title: maybeName ? `${event.event_type}: ${maybeName}` : event.event_type,
			details,
		},
	];
};

export const AgenticChatPanel = ({
	chatId,
	projectId,
}: AgenticChatPanelProps) => {
	const [runId, setRunId] = useState<string | null>(null);
	const [runStatus, setRunStatus] = useState<AgenticRunStatus | null>(null);
	const [afterSeq, setAfterSeq] = useState(0);
	const [events, setEvents] = useState<AgenticRunEvent[]>([]);
	const [input, setInput] = useState("");
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [isStopping, setIsStopping] = useState(false);
	const [isStreaming, setIsStreaming] = useState(false);
	const [streamFailureCount, setStreamFailureCount] = useState(0);
	const [error, setError] = useState<string | null>(null);
	const streamAbortRef = useRef<AbortController | null>(null);

	const messages = useMemo(() => {
		const sorted = [...events].sort((a, b) => a.seq - b.seq);
		const byId = new Map<string, RenderMessage>();

		for (const event of sorted) {
			const topLevelMessage = toMessage(event);
			if (topLevelMessage) {
				byId.set(topLevelMessage.id, topLevelMessage);
			}

			for (const message of extractAssistantMessagesFromStateSync(event)) {
				byId.set(message.id, message);
			}
		}

		return Array.from(byId.values());
	}, [events]);

	const toolActivity = useMemo(() => {
		const sorted = [...events].sort((a, b) => a.seq - b.seq);
		const byId = new Map<string, ToolActivity>();

		for (const event of sorted) {
			for (const activity of extractTopLevelToolActivity(event)) {
				byId.set(activity.id, activity);
			}
			for (const activity of extractToolActivityFromStateSync(event)) {
				byId.set(activity.id, activity);
			}
		}

		return Array.from(byId.values());
	}, [events]);

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
		async (targetRunId: string, fromSeq: number): Promise<AgenticRunEventsResponse> => {
			const payload = await getAgenticRunEvents(targetRunId, fromSeq);
			mergeEvents(payload.events);
			setAfterSeq(payload.next_seq);
			setRunStatus(payload.status);
			return payload;
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
					signal: abortController.signal,
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

	useEffect(() => {
		stopStream();
		setRunId(null);
		setRunStatus(null);
		setAfterSeq(0);
		setEvents([]);
		setError(null);
		setIsStopping(false);
		setIsSubmitting(false);
		setStreamFailureCount(0);
	}, [chatId, stopStream]);

	useEffect(() => {
		if (!chatId) return;
		const key = storageKeyForChat(chatId);
		const storedRunId = window.localStorage.getItem(key);
		if (!storedRunId) return;

		let active = true;
		(async () => {
			try {
				const run = await getAgenticRun(storedRunId);
				if (!active) return;
				setRunId(storedRunId);
				setRunStatus(run.status);
				const payload = await refreshEvents(storedRunId, 0);
				if (!active) return;
				if (!isTerminalStatus(payload.status)) {
					void startStream(storedRunId, payload.next_seq);
				}
			} catch {
				window.localStorage.removeItem(key);
			}
		})();

		return () => {
			active = false;
		};
	}, [chatId, refreshEvents, startStream]);

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
	}, [runId, runStatus, afterSeq, isStreaming, streamFailureCount, refreshEvents]);

	useEffect(() => {
		if (runStatus && isTerminalStatus(runStatus)) {
			stopStream();
		}
	}, [runStatus, stopStream]);

	useEffect(() => {
		return () => {
			stopStream();
		};
	}, [stopStream]);

	const handleSubmit = async () => {
		const message = input.trim();
		if (!message || !projectId || !chatId) return;
		if (isInFlightStatus(runStatus)) return;

		setError(null);
		setIsSubmitting(true);
		setInput("");

		try {
			let targetRunId = runId;

			if (!targetRunId) {
				const created = await createAgenticRun({
					project_id: projectId,
					project_chat_id: chatId,
					message,
				});
				targetRunId = created.id;
				setRunId(targetRunId);
				setRunStatus(created.status);
				window.localStorage.setItem(storageKeyForChat(chatId), targetRunId);
				const payload = await refreshEvents(targetRunId, 0);
				if (!isTerminalStatus(payload.status)) {
					void startStream(targetRunId, payload.next_seq);
				}
			} else {
				const updated = await appendAgenticRunMessage(targetRunId, message);
				setRunStatus(updated.status);
				const payload = await refreshEvents(targetRunId, afterSeq);
				if (!isTerminalStatus(payload.status)) {
					void startStream(targetRunId, payload.next_seq);
				}
			}
		} catch (submitError) {
			const message =
				submitError instanceof Error
					? submitError.message
					: "Failed to submit agentic message";
			setError(message);
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
			const message =
				stopError instanceof Error
					? stopError.message
					: "Failed to stop run";
			setError(message);
		} finally {
			setIsStopping(false);
		}
	};

	const isRunInFlight = isInFlightStatus(runStatus);

	return (
		<Stack className="h-full min-h-0 px-2 pr-4" gap="sm">
			<Group justify="space-between" align="center">
				<Title order={4}>
					<Trans>Agentic Chat</Trans>
				</Title>
				<Group gap="xs">
					{runStatus && (
						<Text size="sm" c="dimmed">
							<Trans>Run status:</Trans> {runStatus}
						</Text>
					)}
					{isRunInFlight && (
						<Button
							variant="light"
							size="xs"
							leftSection={isStopping ? <Loader size={12} /> : <IconPlayerStop size={12} />}
							onClick={() => void handleStop()}
							disabled={isStopping}
						>
							<Trans>Stop</Trans>
						</Button>
					)}
				</Group>
			</Group>

			{error && (
				<Alert
					color="red"
					icon={<IconAlertCircle size={16} />}
					title={<Trans>Error</Trans>}
				>
					{error}
				</Alert>
			)}

			<Box className="min-h-0 flex-1 overflow-y-auto rounded border border-gray-200 p-3">
				<Stack gap="sm">
					{messages.length === 0 && (
						<Text c="dimmed" size="sm">
							<Trans>Send a message to start an agentic run.</Trans>
						</Text>
					)}
					{messages.map((message) => (
						<ChatMessage
							key={message.id}
							role={message.role}
							chatMode="agentic"
						>
							<Markdown className="prose-sm" content={message.content} />
						</ChatMessage>
					))}

					{toolActivity.length > 0 && (
						<Stack gap={6}>
							<Text size="xs" c="dimmed" fw={600}>
								Tool activity
							</Text>
							{toolActivity.map((activity) => (
								<Box
									key={activity.id}
									className="rounded border border-gray-200 bg-gray-50 px-2 py-1"
								>
									<Text size="xs" fw={600}>
										{activity.title}
									</Text>
									{activity.details && (
										<Text
											size="xs"
											component="pre"
											className="mt-1 whitespace-pre-wrap break-words font-mono"
										>
											{activity.details}
										</Text>
									)}
								</Box>
							))}
						</Stack>
					)}
				</Stack>
			</Box>

			<Group align="end" wrap="nowrap">
				<Textarea
					className="flex-1"
					minRows={2}
					maxRows={6}
					value={input}
					onChange={(event) => setInput(event.currentTarget.value)}
					placeholder="Ask the agent..."
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							void handleSubmit();
						}
					}}
				/>
				<Button
					leftSection={
						isSubmitting ? <Loader size={14} /> : <IconSend size={14} />
					}
					onClick={() => void handleSubmit()}
					disabled={
						isSubmitting ||
						isRunInFlight ||
						input.trim().length === 0
					}
				>
					<Trans>Send</Trans>
				</Button>
			</Group>
		</Stack>
	);
};
