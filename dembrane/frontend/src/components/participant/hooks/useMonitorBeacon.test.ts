// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ParticipantState } from "../participantState";
import { useMonitorBeacon } from "./useMonitorBeacon";

const ping = vi.fn();
const pingLeft = vi.fn();

vi.mock("@/lib/api", () => ({
	pingConversation: (...args: unknown[]) => ping(...args),
	pingConversationLeft: (...args: unknown[]) => pingLeft(...args),
}));

vi.mock("@/lib/deviceTelemetry", () => ({
	readBatteryTelemetry: async () => ({ level: 0.8 }),
	readNetworkTelemetry: () => ({ effective_type: "4g" }),
}));

vi.mock("@/lib/visitorId", () => ({ getVisitorId: () => "visitor1" }));

type Props = Parameters<typeof useMonitorBeacon>[0];

const baseProps: Props = {
	conversationId: "c1",
	getAudioLevel: () => 0.5,
	isRecording: false,
	participantState: "waiting",
	projectId: "p1",
	recordingTime: 0,
	reportPing: vi.fn(),
	stoppedRecordingTime: null,
};

const renderBeacon = (props: Partial<Props> = {}) =>
	renderHook((p: Props) => useMonitorBeacon(p), {
		initialProps: { ...baseProps, ...props },
	});

const lastPayload = () => ping.mock.lastCall?.[1];

beforeEach(() => {
	vi.useFakeTimers();
	ping.mockResolvedValue(true);
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	vi.useRealTimers();
	Object.defineProperty(document, "hidden", {
		configurable: true,
		value: false,
	});
});

it("pings on mount, then every 3 seconds, and reports whether each got through", async () => {
	const reportPing = vi.fn();
	ping.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
	renderBeacon({ reportPing });
	await vi.advanceTimersByTimeAsync(0);
	expect(ping).toHaveBeenCalledTimes(1);

	await vi.advanceTimersByTimeAsync(3000);
	expect(ping).toHaveBeenCalledTimes(2);
	expect(reportPing.mock.calls).toEqual([[true], [false]]);
});

it("pings again at once when the participant's state changes", async () => {
	const { rerender } = renderBeacon();
	await vi.advanceTimersByTimeAsync(0);

	rerender({
		...baseProps,
		participantState: "verifying" satisfies ParticipantState,
	});
	await vi.advanceTimersByTimeAsync(0);

	expect(ping).toHaveBeenCalledTimes(2);
	expect(lastPayload().state).toBe("verifying");
});

it("sends device telemetry while visible", async () => {
	renderBeacon();
	await vi.advanceTimersByTimeAsync(0);

	expect(lastPayload()).toMatchObject({
		battery: { level: 0.8 },
		mode: "voice",
		network: { effective_type: "4g" },
		project_id: "p1",
		visitor_id: "visitor1",
	});
	expect(typeof lastPayload().client_ts).toBe("number");
});

it("skips device reads while the tab is hidden", async () => {
	Object.defineProperty(document, "hidden", {
		configurable: true,
		value: true,
	});
	renderBeacon();
	await vi.advanceTimersByTimeAsync(0);

	expect(lastPayload().battery).toBeUndefined();
	expect(lastPayload().network).toBeUndefined();
});

it("clamps the audio level to 0–1 at two decimals, and drops a non-number", async () => {
	const level = { current: 1.7 as number | undefined };
	renderBeacon({ getAudioLevel: () => level.current });
	await vi.advanceTimersByTimeAsync(0);
	expect(lastPayload().audio_level).toBe(1);

	level.current = 0.12345;
	await vi.advanceTimersByTimeAsync(3000);
	expect(lastPayload().audio_level).toBe(0.12);

	level.current = Number.NaN;
	await vi.advanceTimersByTimeAsync(3000);
	expect(lastPayload().audio_level).toBeUndefined();
});

it("reports no recorded time before anything is recorded", async () => {
	renderBeacon();
	await vi.advanceTimersByTimeAsync(0);

	expect(lastPayload().recorded_seconds).toBeUndefined();
	expect(lastPayload().segment_seconds).toBeUndefined();
});

it("reports total and this-run time while recording, sampled each tick", async () => {
	// Resumed at 40s, so this run's segment starts there.
	const { rerender } = renderBeacon({
		isRecording: true,
		participantState: "recording",
		recordingTime: 40,
	});
	await vi.advanceTimersByTimeAsync(0);
	expect(lastPayload()).toMatchObject({
		recorded_seconds: 40,
		segment_seconds: 0,
	});

	rerender({
		...baseProps,
		isRecording: true,
		participantState: "recording",
		recordingTime: 52.36,
	});
	await vi.advanceTimersByTimeAsync(3000);
	expect(lastPayload()).toMatchObject({
		recorded_seconds: 52.4,
		segment_seconds: 12.4,
	});
});

it("reports the stopped length while paused", async () => {
	renderBeacon({
		participantState: "paused",
		recordingTime: 0,
		stoppedRecordingTime: 75,
	});
	await vi.advanceTimersByTimeAsync(0);

	expect(lastPayload()).toMatchObject({ recorded_seconds: 75 });
	expect(lastPayload().segment_seconds).toBeUndefined();
});

it("drops a ping still reading the battery when it unmounts", async () => {
	const reportPing = vi.fn();
	const { unmount } = renderBeacon({ reportPing });
	unmount();
	await vi.advanceTimersByTimeAsync(0);

	expect(ping).not.toHaveBeenCalled();
	expect(reportPing).not.toHaveBeenCalled();
});

it("sends a left beacon when the tab closes, and stops listening after unmount", () => {
	const { unmount } = renderBeacon();

	act(() => {
		window.dispatchEvent(new Event("pagehide"));
	});
	expect(pingLeft).toHaveBeenCalledWith("c1", "p1");

	unmount();
	window.dispatchEvent(new Event("pagehide"));
	expect(pingLeft).toHaveBeenCalledTimes(1);
});

it("does nothing without a conversation", async () => {
	renderBeacon({ conversationId: undefined });
	await vi.advanceTimersByTimeAsync(3000);
	window.dispatchEvent(new Event("pagehide"));

	expect(ping).not.toHaveBeenCalled();
	expect(pingLeft).not.toHaveBeenCalled();
});
