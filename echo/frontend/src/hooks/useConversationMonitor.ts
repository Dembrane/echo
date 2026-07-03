import { useQuery } from "@tanstack/react-query";

import { bff } from "@/lib/bff";

export type TranscriptionStatus =
	| "up_to_date"
	| "transcribing"
	| "failing"
	| "idle";

export type MonitorConversation = {
	id: string;
	label: string | null;
	is_live: boolean;
	is_finished: boolean;
	last_chunk_at: string | null;
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

export type MonitorResponse = {
	conversations: MonitorConversation[];
	summary: MonitorSummary;
	live_window_seconds: number;
};

// Poll every few seconds so hosts see a conversation go live (or start
// failing) without a manual refresh. The endpoint is two bounded reads.
const POLL_INTERVAL_MS = 5000;

export const useConversationMonitor = (
	projectId: string | undefined,
	enabled = true,
) => {
	const query = useQuery({
		enabled: enabled && !!projectId,
		queryFn: async () =>
			bff.get<MonitorResponse>("/conversations/monitor", {
				project_id: projectId,
			}),
		queryKey: ["v2", "conversation-monitor", projectId],
		refetchInterval: POLL_INTERVAL_MS,
	});

	return {
		conversations: query.data?.conversations ?? [],
		error: query.error ? query.error.message : null,
		isLoading: query.isLoading,
		summary: query.data?.summary ?? {
			finished: 0,
			live: 0,
			total: 0,
			transcribing: 0,
			with_errors: 0,
		},
	};
};
