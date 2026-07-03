import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { API_BASE_URL } from "@/config";
import { bff } from "@/lib/bff";

export type TranscriptionStatus =
	| "up_to_date"
	| "transcribing"
	| "failing"
	| "idle";

// Lifecycle the portal reports (plus the server-derived fallbacks). Unknown
// values render as a neutral "active", so this stays a soft contract.
export type ParticipantState =
	| "initiated"
	| "waiting"
	| "recording"
	| "paused"
	| "verifying"
	| "refining"
	| "finishing"
	| "finished"
	| "text"
	| "idle";

export type MonitorNetwork = {
	online?: boolean;
	effective_type?: string;
	downlink?: number;
	rtt?: number;
};

export type MonitorBattery = {
	level?: number;
	charging?: boolean;
};

export type MonitorConversation = {
	id: string;
	label: string | null;
	is_live: boolean;
	is_finished: boolean;
	state: ParticipantState;
	mode: "voice" | "text" | null;
	tags: string[];
	language: string | null;
	latest_transcript: string | null;
	created_at: string | null;
	duration: number | null;
	network: MonitorNetwork | null;
	battery: MonitorBattery | null;
	last_chunk_at: string | null;
	last_seen_at: string | null;
	chunk_count: number;
	transcribed_count: number;
	pending_transcription: number;
	transcription_status: TranscriptionStatus;
	has_error: boolean;
	error_message: string | null;
};

export type MonitorSummary = {
	live: number;
	finished: number;
	transcribing: number;
	with_errors: number;
	total: number;
};

export type FunnelStage =
	| "scanned"
	| "terms"
	| "mic_ok"
	| "mic_skipped"
	| "mic_blocked"
	| "profile";

export type FunnelVisitor = {
	id: string;
	stage: FunnelStage;
	name: string | null;
	tags: string[];
	tags_preselected: boolean;
	scan_count: number;
	device: string | null;
	network: MonitorNetwork | null;
	battery: MonitorBattery | null;
	last_seen_at: string | null;
};

export type MonitorFunnel = {
	visitors: FunnelVisitor[];
	summary: Record<string, number> & { total: number };
};

export type MonitorResponse = {
	conversations: MonitorConversation[];
	summary: MonitorSummary;
	funnel?: MonitorFunnel;
	live_window_seconds: number;
};

const EMPTY_FUNNEL: MonitorFunnel = { visitors: [], summary: { total: 0 } };

const EMPTY_SUMMARY: MonitorSummary = {
	finished: 0,
	live: 0,
	total: 0,
	transcribing: 0,
	with_errors: 0,
};

// The SSE stream is the primary channel: the server pushes a fresh snapshot on
// connect and on every change (a participant ping, transcription, or finish
// nudges it). React Query stays as a robust fallback — it does the very first
// fetch and keeps a slow safety poll in case the stream can't connect.
const FALLBACK_POLL_MS = 5000;
const SAFETY_POLL_MS = 30000;

export const useConversationMonitor = (
	projectId: string | undefined,
	enabled = true,
) => {
	const [streamData, setStreamData] = useState<MonitorResponse | null>(null);
	const [streamConnected, setStreamConnected] = useState(false);

	const query = useQuery({
		enabled: enabled && !!projectId,
		queryFn: async () =>
			bff.get<MonitorResponse>("/conversations/monitor", {
				project_id: projectId,
			}),
		queryKey: ["v2", "conversation-monitor", projectId],
		// Poll fast until the stream is live, then drop to a slow safety net.
		refetchInterval: streamConnected ? SAFETY_POLL_MS : FALLBACK_POLL_MS,
	});

	useEffect(() => {
		if (!enabled || !projectId) return;
		// Reset per-project so a stale snapshot never bleeds across projects.
		setStreamData(null);
		setStreamConnected(false);

		const url = `${API_BASE_URL}/v2/bff/conversations/monitor/stream?project_id=${encodeURIComponent(
			projectId,
		)}`;
		const source = new EventSource(url, { withCredentials: true });

		source.addEventListener("snapshot", (event: Event) => {
			if (event instanceof MessageEvent) {
				try {
					setStreamData(JSON.parse(event.data) as MonitorResponse);
					setStreamConnected(true);
				} catch {
					// Ignore a malformed frame; the next snapshot recovers.
				}
			}
		});

		source.onerror = () => {
			// EventSource auto-reconnects; until it does, fall back to polling.
			setStreamConnected(false);
		};

		return () => {
			source.close();
			setStreamConnected(false);
		};
	}, [enabled, projectId]);

	const data = streamData ?? query.data;

	return {
		conversations: data?.conversations ?? [],
		error: query.error ? query.error.message : null,
		funnel: data?.funnel ?? EMPTY_FUNNEL,
		isLoading: query.isLoading && !streamData,
		isStreaming: streamConnected,
		summary: data?.summary ?? EMPTY_SUMMARY,
	};
};
