// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	captureInterruptionError,
	captureRecordingInterrupted,
	useRecordingTelemetry,
} from "./useRecordingTelemetry";

const capture = vi.fn();
const captureException = vi.fn();

vi.mock("posthog-js", () => ({
	default: {
		capture: (...args: unknown[]) => capture(...args),
		captureException: (...args: unknown[]) => captureException(...args),
	},
}));

vi.mock("@/lib/deviceTelemetry", () => ({
	readNetworkTelemetry: () => ({ effective_type: "3g" }),
}));

type Props = Parameters<typeof useRecordingTelemetry>[0];

const baseProps: Props = {
	conversationId: "c1",
	documentHidden: false,
	isRecording: false,
	participantState: "waiting",
	pendingUploadCount: () => 0,
	projectId: "p1",
	recordingTime: 0,
};

const recording: Partial<Props> = {
	isRecording: true,
	participantState: "recording",
	recordingTime: 30,
};

const renderTelemetry = (props: Partial<Props> = {}) => {
	const view = renderHook((p: Props) => useRecordingTelemetry(p), {
		initialProps: { ...baseProps, ...props },
	});
	return {
		...view,
		update: (next: Partial<Props>) => view.rerender({ ...baseProps, ...next }),
	};
};

const fire = (target: EventTarget, type: string) =>
	act(() => {
		target.dispatchEvent(new Event(type));
	});

const eventsNamed = (name: string) =>
	capture.mock.calls.filter(([event]) => event === name);

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	vi.useRealTimers();
});

describe("backgrounding", () => {
	it("reports going to the background while recording, and how long it stayed there", () => {
		const { update } = renderTelemetry(recording);

		update({ ...recording, documentHidden: true });
		expect(capture).toHaveBeenCalledWith("portal_recording_backgrounded", {
			conversation_id: "c1",
			project_id: "p1",
			recording_time_seconds: 30,
		});

		vi.advanceTimersByTime(12_400);
		update({ ...recording, documentHidden: false });
		expect(capture).toHaveBeenCalledWith("portal_recording_foregrounded", {
			backgrounded_seconds: 12,
			conversation_id: "c1",
			project_id: "p1",
		});
	});

	it("reports once per trip to the background, however much else changes", () => {
		const { update } = renderTelemetry(recording);

		update({ ...recording, documentHidden: true });
		update({ ...recording, documentHidden: true, recordingTime: 31 });
		update({ ...recording, documentHidden: true, recordingTime: 32 });

		expect(eventsNamed("portal_recording_backgrounded")).toHaveLength(1);
	});

	it("ignores the tab hiding when not recording", () => {
		const { update } = renderTelemetry();

		update({ documentHidden: true });
		update({ documentHidden: false });

		expect(capture).not.toHaveBeenCalled();
	});

	it("still reports the return if recording stopped while away", () => {
		const { update } = renderTelemetry(recording);

		update({ ...recording, documentHidden: true });
		update({ documentHidden: true });
		update({ documentHidden: false });

		expect(eventsNamed("portal_recording_foregrounded")).toHaveLength(1);
	});
});

describe("network", () => {
	it("reports going offline and how long it lasted", () => {
		renderTelemetry(recording);

		fire(window, "offline");
		expect(capture).toHaveBeenCalledWith("portal_network_offline", {
			conversation_id: "c1",
			effective_type: "3g",
			project_id: "p1",
			recording_time_seconds: 30,
		});

		vi.advanceTimersByTime(5_600);
		fire(window, "online");
		expect(capture).toHaveBeenCalledWith("portal_network_online", {
			conversation_id: "c1",
			offline_seconds: 6,
			project_id: "p1",
		});
	});

	it("reports one outage when the browser repeats offline, and ignores a stray online", () => {
		renderTelemetry();

		fire(window, "online");
		fire(window, "offline");
		fire(window, "offline");
		fire(window, "online");
		fire(window, "online");

		expect(eventsNamed("portal_network_offline")).toHaveLength(1);
		expect(eventsNamed("portal_network_online")).toHaveLength(1);
	});

	it("reads the recording time when the network drops, not when it subscribed", () => {
		const { update } = renderTelemetry(recording);
		update({ ...recording, recordingTime: 95 });

		fire(window, "offline");

		expect(capture).toHaveBeenCalledWith(
			"portal_network_offline",
			expect.objectContaining({ recording_time_seconds: 95 }),
		);
	});
});

describe("abandoning", () => {
	it("reports closing the tab mid-recording, with uploads still in flight", () => {
		renderTelemetry({ ...recording, pendingUploadCount: () => 2 });

		fire(window, "pagehide");

		expect(capture).toHaveBeenCalledWith("portal_abandoned", {
			conversation_id: "c1",
			participant_state: "recording",
			pending_uploads: 2,
			project_id: "p1",
			recording_time_seconds: 30,
		});
	});

	it("says nothing when the tab closes while not recording", () => {
		renderTelemetry({ participantState: "paused" });

		fire(window, "pagehide");

		expect(capture).not.toHaveBeenCalled();
	});
});

it("does nothing without a conversation", () => {
	const { update } = renderTelemetry({
		...recording,
		conversationId: undefined,
	});

	update({ ...recording, conversationId: undefined, documentHidden: true });
	fire(window, "offline");
	fire(window, "pagehide");

	expect(capture).not.toHaveBeenCalled();
});

it("stops listening once unmounted", () => {
	const { unmount } = renderTelemetry(recording);
	unmount();

	fire(window, "offline");
	fire(window, "pagehide");

	expect(capture).not.toHaveBeenCalled();
});

describe("interruption reports", () => {
	const chunkHistory = [
		{ size: 50_000 },
		{ size: 12 },
		{ size: 1023 },
		{ size: 1024 },
	];

	it("counts chunks under 1KB as suspicious when the interruption is detected", () => {
		captureRecordingInterrupted({
			chunkHistory,
			conversationId: "c1",
			projectId: "p1",
			recordingTime: 42,
		});

		expect(capture).toHaveBeenCalledWith("portal_recording_interrupted", {
			conversation_id: "c1",
			project_id: "p1",
			recording_time_seconds: 42,
			suspicious_chunk_count: 2,
			total_chunks: 4,
		});
	});

	it("reports an exception naming the suspicious chunks, plus a chartable event", () => {
		captureInterruptionError({
			chunkHistory,
			conversationId: "c1",
			projectId: "p1",
			recordingTime: 42,
		});

		expect(captureException).toHaveBeenCalledWith(
			expect.objectContaining({
				message: "Recording interrupted by consecutive suspicious chunks",
			}),
			expect.objectContaining({
				chunkSizes: [50_000, 12, 1023, 1024],
				issue_type: "audio_interruption",
				platform: "participant_portal",
				recordingDurationSeconds: 42,
				suspiciousChunkIndices: [1, 2],
				totalChunks: 4,
			}),
		);
		expect(capture).toHaveBeenCalledWith("portal_recording_error", {
			conversation_id: "c1",
			issue_type: "audio_interruption",
			project_id: "p1",
			recording_duration_seconds: 42,
			total_chunks: 4,
		});
	});
});
