import posthog from "posthog-js";
import { useEffect, useRef } from "react";
import { readNetworkTelemetry } from "@/lib/deviceTelemetry";
import type { ParticipantState } from "../participantState";

type RecordingTelemetryOptions = {
	conversationId: string | undefined;
	projectId: string | undefined;
	participantState: ParticipantState;
	isRecording: boolean;
	recordingTime: number;
	documentHidden: boolean;
	/** How many chunk uploads are still in flight. */
	pendingUploadCount: () => number;
};

/**
 * PostHog events for what happens to a recording outside the participant's
 * control: the tab going to the background, the network dropping, the tab
 * closing mid-recording. Each fires once per transition.
 */
export const useRecordingTelemetry = ({
	conversationId,
	projectId,
	participantState,
	isRecording,
	recordingTime,
	documentHidden,
	pendingUploadCount,
}: RecordingTelemetryOptions) => {
	// Ticking values, read through a ref so the listeners below report current
	// ones without re-subscribing every tick.
	const liveRef = useRef({ isRecording, participantState, recordingTime });
	liveRef.current = { isRecording, participantState, recordingTime };

	// Backgrounding while recording is our proxy for a call/lock/tab-switch.
	const backgroundedAtRef = useRef<number | null>(null);
	useEffect(() => {
		if (!conversationId) return;
		if (documentHidden && isRecording && backgroundedAtRef.current === null) {
			backgroundedAtRef.current = Date.now();
			posthog.capture("portal_recording_backgrounded", {
				conversation_id: conversationId,
				project_id: projectId,
				recording_time_seconds: liveRef.current.recordingTime,
			});
		} else if (!documentHidden && backgroundedAtRef.current !== null) {
			posthog.capture("portal_recording_foregrounded", {
				backgrounded_seconds: Math.round(
					(Date.now() - backgroundedAtRef.current) / 1000,
				),
				conversation_id: conversationId,
				project_id: projectId,
			});
			backgroundedAtRef.current = null;
		}
	}, [documentHidden, isRecording, conversationId, projectId]);

	// Browser-level connectivity (radio drop), distinct from per-chunk upload
	// failures.
	const offlineAtRef = useRef<number | null>(null);
	useEffect(() => {
		if (!conversationId) return;
		const onOffline = () => {
			if (offlineAtRef.current !== null) return;
			offlineAtRef.current = Date.now();
			posthog.capture("portal_network_offline", {
				conversation_id: conversationId,
				effective_type: readNetworkTelemetry()?.effective_type,
				project_id: projectId,
				recording_time_seconds: liveRef.current.recordingTime,
			});
		};
		const onOnline = () => {
			if (offlineAtRef.current === null) return;
			posthog.capture("portal_network_online", {
				conversation_id: conversationId,
				offline_seconds: Math.round((Date.now() - offlineAtRef.current) / 1000),
				project_id: projectId,
			});
			offlineAtRef.current = null;
		};
		window.addEventListener("offline", onOffline);
		window.addEventListener("online", onOnline);
		return () => {
			window.removeEventListener("offline", onOffline);
			window.removeEventListener("online", onOnline);
		};
	}, [conversationId, projectId]);

	// The tab closed while still recording.
	useEffect(() => {
		if (!conversationId) return;
		const onPageHide = () => {
			const live = liveRef.current;
			if (!live.isRecording) return;
			posthog.capture("portal_abandoned", {
				conversation_id: conversationId,
				participant_state: live.participantState,
				pending_uploads: pendingUploadCount(),
				project_id: projectId,
				recording_time_seconds: live.recordingTime,
			});
		};
		window.addEventListener("pagehide", onPageHide);
		return () => window.removeEventListener("pagehide", onPageHide);
	}, [conversationId, projectId, pendingUploadCount]);
};

type ChunkHistory = { size: number }[];

// Chunks this small carry no real audio; a run of them is how the recorder
// spots an interruption.
const isSuspicious = (chunk: { size: number }) => chunk.size < 1024;

/** The recorder detected an interruption. Fired at detection, not on reconnect. */
export const captureRecordingInterrupted = (event: {
	conversationId: string | undefined;
	projectId: string | undefined;
	recordingTime: number;
	chunkHistory: ChunkHistory;
}) => {
	posthog.capture("portal_recording_interrupted", {
		conversation_id: event.conversationId,
		project_id: event.projectId,
		recording_time_seconds: event.recordingTime,
		suspicious_chunk_count: event.chunkHistory.filter(isSuspicious).length,
		total_chunks: event.chunkHistory.length,
	});
};

/** The participant reconnected after an interruption: report it as an error. */
export const captureInterruptionError = (event: {
	conversationId: string | undefined;
	projectId: string | undefined;
	recordingTime: number;
	chunkHistory: ChunkHistory;
}) => {
	const { chunkHistory } = event;
	posthog.captureException(
		new Error("Recording interrupted by consecutive suspicious chunks"),
		{
			chunkSizes: chunkHistory.map((c) => c.size),
			conversationId: event.conversationId,
			deviceInfo: navigator.userAgent,
			issue_type: "audio_interruption",
			platform: "participant_portal",
			projectId: event.projectId,
			recordingDurationSeconds: event.recordingTime,
			suspiciousChunkIndices: chunkHistory
				.map((c, i) => (isSuspicious(c) ? i : -1))
				.filter((i) => i >= 0),
			totalChunks: chunkHistory.length,
		},
	);

	// Also emit a plain event so we can chart a recording-error rate (the
	// exception above lands in error tracking, which doesn't funnel cleanly).
	posthog.capture("portal_recording_error", {
		conversation_id: event.conversationId,
		issue_type: "audio_interruption",
		project_id: event.projectId,
		recording_duration_seconds: event.recordingTime,
		total_chunks: chunkHistory.length,
	});
};
