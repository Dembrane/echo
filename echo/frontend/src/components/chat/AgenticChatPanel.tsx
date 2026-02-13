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
import { IconAlertCircle, IconSend } from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import type { AgenticRunEvent, AgenticRunStatus } from "@/lib/api";
import {
	appendAgenticRunMessage,
	createAgenticRun,
	getAgenticRun,
	getAgenticRunEvents,
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

const storageKeyForChat = (chatId: string) => `agentic-run:${chatId}`;

const isTerminalStatus = (status: AgenticRunStatus | null) =>
	status === "completed" || status === "failed" || status === "timeout";

const toMessage = (event: AgenticRunEvent): RenderMessage | null => {
	const payload =
		event.payload && typeof event.payload === "object"
			? (event.payload as Record<string, unknown>)
			: null;

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

	const payload =
		event.payload && typeof event.payload === "object"
			? (event.payload as Record<string, unknown>)
			: null;
	const state =
		payload?.state && typeof payload.state === "object"
			? (payload.state as Record<string, unknown>)
			: null;
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
	const [error, setError] = useState<string | null>(null);

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

	const mergeEvents = (incoming: AgenticRunEvent[]) => {
		if (incoming.length === 0) return;
		setEvents((previous) => {
			const bySeq = new Map<number, AgenticRunEvent>();
			for (const event of previous) bySeq.set(event.seq, event);
			for (const event of incoming) bySeq.set(event.seq, event);
			return Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);
		});
	};

	const refreshEvents = async (targetRunId: string, fromSeq: number) => {
		const payload = await getAgenticRunEvents(targetRunId, fromSeq);
		mergeEvents(payload.events);
		setAfterSeq(payload.next_seq);
		setRunStatus(payload.status);
	};

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
				await refreshEvents(storedRunId, 0);
			} catch {
				window.localStorage.removeItem(key);
			}
		})();

		return () => {
			active = false;
		};
	}, [chatId]);

	useEffect(() => {
		if (!runId || !runStatus || isTerminalStatus(runStatus)) return;

		let active = true;
		const interval = window.setInterval(async () => {
			if (!active) return;
			try {
				await refreshEvents(runId, afterSeq);
			} catch {
				// Keep polling retries lightweight; surfaced errors occur on submit path.
			}
		}, 1500);

		return () => {
			active = false;
			window.clearInterval(interval);
		};
	}, [runId, runStatus, afterSeq]);

	const handleSubmit = async () => {
		const message = input.trim();
		if (!message || !projectId || !chatId) return;

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
				await refreshEvents(targetRunId, 0);
			} else {
				const updated = await appendAgenticRunMessage(targetRunId, message);
				setRunStatus(updated.status);
				await refreshEvents(targetRunId, afterSeq);
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

	return (
		<Stack className="h-full min-h-0 px-2 pr-4" gap="sm">
			<Group justify="space-between" align="center">
				<Title order={4}>
					<Trans>Agentic Chat</Trans>
				</Title>
				{runStatus && (
					<Text size="sm" c="dimmed">
						<Trans>Run status:</Trans> {runStatus}
					</Text>
				)}
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
					disabled={isSubmitting || input.trim().length === 0}
				>
					<Trans>Send</Trans>
				</Button>
			</Group>
		</Stack>
	);
};
