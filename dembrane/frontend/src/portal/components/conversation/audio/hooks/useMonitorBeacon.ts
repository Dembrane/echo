import { useEffect, useRef } from "react";
import { ENABLE_MONITOR } from "@/config";
import { pingConversation, pingConversationLeft } from "@/lib/api";
import {
	readBatteryTelemetry,
	readNetworkTelemetry,
} from "@/lib/deviceTelemetry";
import { getVisitorId } from "@/lib/visitorId";
import type { ParticipantState } from "../participantState";

// A snappier beacon while on the recording screen so the host sees state
// changes in a few seconds rather than tens of seconds.
const PING_INTERVAL_MS = 3000;

const round1 = (n: number) => Math.round(n * 10) / 10;

const toAudioLevel = (raw: number | undefined) =>
	typeof raw === "number" && Number.isFinite(raw)
		? Math.round(Math.min(1, Math.max(0, raw)) * 100) / 100
		: undefined;

type MonitorBeaconOptions = {
	conversationId: string | undefined;
	projectId: string | undefined;
	participantState: ParticipantState;
	isRecording: boolean;
	recordingTime: number;
	/** The length a paused recording was stopped at, null when not paused. */
	stoppedRecordingTime: number | null;
	getAudioLevel: () => number | undefined;
	/** Told whether each ping got through, to judge connection health. */
	reportPing: (answered: boolean) => void;
};

/**
 * Liveness + telemetry beacon for the host monitor. Runs the whole time the
 * participant is on the conversation screen (not just while recording) so the
 * monitor sees a session the moment it is initiated, and reflects pauses /
 * verify without waiting for the next chunk. Pings again immediately when the
 * participant's state changes. Best-effort; failures never disrupt recording.
 */
export const useMonitorBeacon = ({
	conversationId,
	projectId,
	participantState,
	isRecording,
	recordingTime,
	stoppedRecordingTime,
	getAudioLevel,
	reportPing,
}: MonitorBeaconOptions) => {
	// Ticking values, read through a ref so the interval samples current ones
	// without restarting every tick.
	const liveRef = useRef({
		getAudioLevel,
		isRecording,
		recordingTime,
		stoppedRecordingTime,
	});
	liveRef.current = {
		getAudioLevel,
		isRecording,
		recordingTime,
		stoppedRecordingTime,
	};

	// Recorded time when the current run started, so the beacon can report how
	// long THIS run has been going (segment_seconds); resets on resume.
	const segmentBaselineRef = useRef(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: capture recordingTime only at the recording (re)start edge
	useEffect(() => {
		if (isRecording) segmentBaselineRef.current = recordingTime;
	}, [isRecording]);

	useEffect(() => {
		// Monitor off: no host reads these, so don't collect/beacon telemetry.
		if (!conversationId || !ENABLE_MONITOR) return;
		let cancelled = false;
		const sendPing = async () => {
			// Stamp before the battery await so a ping delayed by getBattery keeps
			// its initiation time and can't out-order a later "left" beacon.
			const client_ts = Date.now();
			// Backgrounded/locked: skip the extra device reads (battery is an
			// async native call, network reads sensor state) to avoid waking the
			// device just to report telemetry nobody is looking at. Still send
			// the lightweight state ping so the monitor sees "backgrounded".
			const hidden = document.hidden;
			const battery = hidden ? undefined : await readBatteryTelemetry();
			if (cancelled) return;
			const live = liveRef.current;
			// Pause resets recordingTime to 0 and freezes the length in
			// stoppedRecordingTime, so report that while paused.
			const recorded = live.stoppedRecordingTime ?? live.recordingTime;
			const answered = await pingConversation(conversationId, {
				audio_level: toAudioLevel(live.getAudioLevel()),
				battery,
				client_ts,
				mode: "voice",
				network: hidden ? undefined : readNetworkTelemetry(),
				project_id: projectId,
				recorded_seconds:
					live.isRecording || recorded > 0 ? round1(recorded) : undefined,
				segment_seconds: live.isRecording
					? round1(Math.max(0, live.recordingTime - segmentBaselineRef.current))
					: undefined,
				state: participantState,
				visitor_id: projectId ? getVisitorId(projectId) : undefined,
			});
			reportPing(answered);
		};
		void sendPing();
		const interval = setInterval(() => void sendPing(), PING_INTERVAL_MS);
		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, [conversationId, projectId, participantState, reportPing]);

	// Terminal "left" beacon on tab close (fires on real unload, not SPA
	// navigation), so a graceful exit shows as "left" on the host monitor
	// instead of aging paused -> idle -> finished over minutes.
	useEffect(() => {
		if (!conversationId || !ENABLE_MONITOR) return;
		const onPageHide = () => pingConversationLeft(conversationId, projectId);
		window.addEventListener("pagehide", onPageHide);
		return () => window.removeEventListener("pagehide", onPageHide);
	}, [conversationId, projectId]);
};
