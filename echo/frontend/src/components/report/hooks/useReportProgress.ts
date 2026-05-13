import { useEffect, useRef, useState } from "react";
import { API_BASE_URL } from "@/config";

export interface ReportProgressEvent {
	type:
		| "connected"
		| "summarizing"
		| "waiting_for_summaries"
		| "fetching_transcripts"
		| "generating"
		| "completed"
		| "failed";
	message: string;
	detail?: Record<string, unknown>;
}

export const useReportProgress = (
	projectId: string | undefined,
	reportId: number | null,
) => {
	const [progress, setProgress] = useState<ReportProgressEvent | null>(null);
	const [isConnected, setIsConnected] = useState(false);
	const eventSourceRef = useRef<EventSource | null>(null);

	useEffect(() => {
		if (!reportId || !projectId) return;

		const eventSource = new EventSource(
			`${API_BASE_URL}/projects/${projectId}/reports/${reportId}/progress`,
		);
		eventSourceRef.current = eventSource;

		eventSource.addEventListener("progress", (ev: Event) => {
			if (ev instanceof MessageEvent) {
				try {
					const data = JSON.parse(ev.data) as ReportProgressEvent;
					if (data.type === "connected") {
						setIsConnected(true);
						return; // Don't overwrite meaningful progress message
					}
					setProgress(data);
				} catch {
					// ignore parse errors
				}
			}
		});

		eventSource.addEventListener("heartbeat", () => {
			// Connection is alive
		});

		eventSource.addEventListener("error", () => {
			setIsConnected(false);
		});

		return () => {
			eventSource.close();
			eventSourceRef.current = null;
		};
	}, [projectId, reportId]);

	return { progress, isConnected };
};
