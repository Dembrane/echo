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
	| "backgrounded"
	| "offline"
	| "left"
	| "idle";

// The host's first question: is audio actually coming in? "stalled" is the
// flag — should be recording but nothing has arrived for a while.
export type RecordingHealth =
	| "receiving"
	| "stalled"
	| "paused"
	| "backgrounded"
	| "offline"
	| "left"
	| "waiting"
	| "idle"
	| "finished";

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
	recording_health: RecordingHealth;
	/** Live mic input level (0..1) from the participant's last beacon, or null
	 * when not reported (older portal, text mode, or between beacons). */
	audio_level: number | null;
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
	not_receiving: number;
	offline: number;
	total: number;
	pending_transcription: number;
	catch_up_eta_seconds: number;
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
	/** First-seen timestamp per stage, for the drilldown timeline. */
	stages: Record<string, string>;
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

const EMPTY_FUNNEL: MonitorFunnel = { summary: { total: 0 }, visitors: [] };

const EMPTY_SUMMARY: MonitorSummary = {
	catch_up_eta_seconds: 0,
	finished: 0,
	live: 0,
	not_receiving: 0,
	offline: 0,
	pending_transcription: 0,
	total: 0,
	transcribing: 0,
	with_errors: 0,
};

// SSE is the primary channel; React Query is the fallback (first fetch + poll).
const FALLBACK_POLL_MS = 5000;
const SAFETY_POLL_MS = 30000;

type StreamState = { data: MonitorResponse | null; connected: boolean };

// One EventSource per project, shared + ref-counted so multiple components on the
// page reuse a single stream instead of each opening its own.
type SharedConnection = {
	refCount: number;
	state: StreamState;
	source: EventSource | null;
	listeners: Set<(state: StreamState) => void>;
};

const connections = new Map<string, SharedConnection>();

const notify = (conn: SharedConnection) => {
	for (const listener of conn.listeners) listener(conn.state);
};

const openSource = (projectId: string, conn: SharedConnection) => {
	const url = `${API_BASE_URL}/v2/bff/conversations/monitor/stream?project_id=${encodeURIComponent(
		projectId,
	)}`;
	const source = new EventSource(url, { withCredentials: true });
	conn.source = source;
	source.addEventListener("snapshot", (event: Event) => {
		if (!(event instanceof MessageEvent)) return;
		try {
			const data = JSON.parse(event.data) as MonitorResponse;
			conn.state = { connected: true, data };
			notify(conn);
		} catch {
			// Ignore a malformed frame; the next snapshot recovers.
		}
	});
	source.onerror = () => {
		// Auto-reconnects; mark down meanwhile so consumers fall back to the poll.
		conn.state = { connected: false, data: conn.state.data };
		notify(conn);
	};
};

const subscribeToMonitor = (
	projectId: string,
	listener: (state: StreamState) => void,
): (() => void) => {
	let conn = connections.get(projectId);
	if (!conn) {
		conn = {
			listeners: new Set(),
			refCount: 0,
			source: null,
			state: { connected: false, data: null },
		};
		connections.set(projectId, conn);
	}
	const connection = conn;
	connection.listeners.add(listener);
	connection.refCount += 1;
	if (connection.refCount === 1) openSource(projectId, connection);
	listener(connection.state);
	return () => {
		connection.listeners.delete(listener);
		connection.refCount -= 1;
		if (connection.refCount <= 0) {
			connection.source?.close();
			connections.delete(projectId);
		}
	};
};

export const useConversationMonitor = (
	projectId: string | undefined,
	enabled = true,
) => {
	const [stream, setStream] = useState<StreamState>({
		connected: false,
		data: null,
	});

	const query = useQuery({
		enabled: enabled && !!projectId,
		queryFn: async () =>
			bff.get<MonitorResponse>("/conversations/monitor", {
				project_id: projectId,
			}),
		queryKey: ["v2", "conversation-monitor", projectId],
		// Fast poll until the stream is live, then a slow safety net.
		refetchInterval: stream.connected ? SAFETY_POLL_MS : FALLBACK_POLL_MS,
	});

	useEffect(() => {
		if (!enabled || !projectId) {
			setStream({ connected: false, data: null });
			return;
		}
		return subscribeToMonitor(projectId, setStream);
	}, [enabled, projectId]);

	// Stream wins while live; when it's down, prefer the poll so a dead stream
	// can't freeze the view on a stale snapshot.
	const data = stream.connected
		? (stream.data ?? query.data)
		: (query.data ?? stream.data);

	return {
		conversations: data?.conversations ?? [],
		error: query.error ? query.error.message : null,
		funnel: data?.funnel ?? EMPTY_FUNNEL,
		isLoading: query.isLoading && !data,
		isStreaming: stream.connected,
		summary: data?.summary ?? EMPTY_SUMMARY,
	};
};
