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
	appendAgenticRunMessage,
	createAgenticRun,
	getAgenticRun,
	getAgenticRunEvents,
	stopAgenticRun,
	streamAgenticRun,
} from "@/lib/api";
import { Markdown } from "../common/Markdown";
import {
	extractTopLevelToolActivity,
	type ToolActivity,
} from "./agenticToolActivity";
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

type TimelineItem =
	| (RenderMessage & {
			kind: "message";
	  })
	| (ToolActivity & {
			kind: "tool";
	  });

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

const toMessage = (event: AgenticRunEvent): RenderMessage | null => {
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
		return { content, id: `u-${event.seq}`, role: "user" };
	}

	if (event.event_type === "assistant.message" && content) {
		return { content, id: `a-${event.seq}`, role: "assistant" };
	}

	if (event.event_type === "run.failed" || event.event_type === "run.timeout") {
		return {
			content: content ?? "Agent run failed",
			id: `s-${event.seq}`,
			role: "dembrane",
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
			role: "dembrane",
		};
	}

	return null;
};

const TOOL_STATUS_META: Record<
	ToolActivity["status"],
	{ badgeClass: string; label: string }
> = {
	completed: {
		badgeClass: "border-emerald-300 bg-emerald-100 text-emerald-800",
		label: "✓",
	},
	error: {
		badgeClass: "border-red-300 bg-red-100 text-red-800",
		label: "Error",
	},
	running: {
		badgeClass: "border-amber-300 bg-amber-100 text-amber-800",
		label: "Running",
	},
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

	const timeline = useMemo(() => {
		const sorted = [...events].sort((a, b) => a.seq - b.seq);
		const byId = new Map<string, TimelineItem>();
		const orderedIds: string[] = [];

		const upsertItem = (item: TimelineItem) => {
			if (!byId.has(item.id)) {
				orderedIds.push(item.id);
			}
			byId.set(item.id, item);
		};

		for (const event of sorted) {
			const topLevelMessage = toMessage(event);
			if (topLevelMessage) {
				upsertItem({
					...topLevelMessage,
					kind: "message",
				});
			}

			for (const activity of extractTopLevelToolActivity(event)) {
				upsertItem({
					...activity,
					kind: "tool",
				});
			}
		}

		return orderedIds
			.map((id) => byId.get(id))
			.filter((item): item is TimelineItem => item !== undefined);
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

	// biome-ignore lint/correctness/useExhaustiveDependencies: Reset panel state whenever chatId changes.
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
					message,
					project_chat_id: chatId,
					project_id: projectId,
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
				stopError instanceof Error ? stopError.message : "Failed to stop run";
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
							leftSection={
								isStopping ? <Loader size={12} /> : <IconPlayerStop size={12} />
							}
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
					{timeline.length === 0 && (
						<Text c="dimmed" size="sm">
							<Trans>Send a message to start an agentic run.</Trans>
						</Text>
					)}
					{timeline.map((item) => {
						if (item.kind === "message") {
							return (
								<ChatMessage key={item.id} role={item.role} chatMode="agentic">
									<Markdown className="prose-sm" content={item.content} />
								</ChatMessage>
							);
						}

						const statusMeta = TOOL_STATUS_META[item.status];
						const hasRawData =
							item.rawInput || item.rawOutput || item.rawError;
						const showStatusBadge = item.status !== "running";

						return (
							<Box key={item.id} className="flex justify-start">
								<Box className="w-full rounded border border-cyan-200 bg-cyan-50/50 px-3 py-2 md:max-w-[85%]">
									<details>
										<summary className="cursor-pointer list-none">
											<Group justify="space-between" gap="xs" wrap="nowrap">
												<Text size="xs" fw={700} c="dark">
													{item.headline}
												</Text>
												{showStatusBadge && (
													<Box
														className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${statusMeta.badgeClass}`}
													>
														{statusMeta.label}
													</Box>
												)}
											</Group>
										</summary>
										{(item.summaryLines.length > 0 || hasRawData) && (
											<Stack gap={4} className="mt-2">
												{item.summaryLines.map((line) => (
													<Text
														key={`${item.id}:${line}`}
														size="xs"
														c="dark"
													>
														{line}
													</Text>
												))}
												{hasRawData && (
													<details className="rounded border border-cyan-100 bg-white">
														<summary className="cursor-pointer list-none px-2 py-1 text-xs font-semibold text-gray-700">
															Raw data
														</summary>
														<Stack gap={6} className="px-2 pb-2">
															{item.rawInput && (
																<Box>
																	<Text size="xs" c="dimmed" fw={700}>
																		Input
																	</Text>
																	<Text
																		size="xs"
																		component="pre"
																		className="mt-1 whitespace-pre-wrap break-words rounded border border-cyan-100 bg-white p-2 font-mono"
																	>
																		{item.rawInput}
																	</Text>
																</Box>
															)}
															{item.rawOutput && (
																<Box>
																	<Text size="xs" c="dimmed" fw={700}>
																		Output
																	</Text>
																	<Text
																		size="xs"
																		component="pre"
																		className="mt-1 whitespace-pre-wrap break-words rounded border border-cyan-100 bg-white p-2 font-mono"
																	>
																		{item.rawOutput}
																	</Text>
																</Box>
															)}
															{item.rawError && (
																<Box>
																	<Text size="xs" c="dimmed" fw={700}>
																		Error
																	</Text>
																	<Text
																		size="xs"
																		component="pre"
																		className="mt-1 whitespace-pre-wrap break-words rounded border border-red-100 bg-red-50 p-2 font-mono"
																	>
																		{item.rawError}
																	</Text>
																</Box>
															)}
														</Stack>
													</details>
												)}
											</Stack>
										)}
									</details>
								</Box>
							</Box>
						);
					})}
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
					disabled={isSubmitting || isRunInFlight || input.trim().length === 0}
				>
					<Trans>Send</Trans>
				</Button>
			</Group>
		</Stack>
	);
};
