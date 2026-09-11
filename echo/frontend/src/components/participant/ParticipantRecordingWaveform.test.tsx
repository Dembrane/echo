// @vitest-environment jsdom
import { MantineProvider } from "@mantine/core";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { VOICE_WAVEFORM_BARS } from "@/components/voice/voiceInput";
import {
	ParticipantRecordingWaveform,
	type RecordingMeterStatus,
} from "./ParticipantRecordingWaveform";

beforeEach(() => {
	vi.useFakeTimers();
	// MantineProvider and useReducedMotion both read matchMedia; jsdom has none.
	vi.stubGlobal("matchMedia", (query: string) => ({
		addEventListener: () => {},
		addListener: () => {},
		dispatchEvent: () => false,
		matches: false,
		media: query,
		onchange: null,
		removeEventListener: () => {},
		removeListener: () => {},
	}));
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

const renderWaveform = (
	peekAudioLevel?: () => number,
	props: {
		onSilence?: () => void;
		status?: RecordingMeterStatus;
	} = {},
) =>
	render(
		<MantineProvider>
			<ParticipantRecordingWaveform
				peekAudioLevel={peekAudioLevel}
				{...props}
			/>
		</MantineProvider>,
	);

const barColor = () =>
	(screen.getByTestId("chat-voice-waveform").firstElementChild as HTMLElement)
		.style.backgroundColor;

it("draws a bar per sample slot once the meter is running", () => {
	renderWaveform(() => 0.5);

	act(() => {
		vi.advanceTimersByTime(2000);
	});

	const waveform = screen.getByTestId("chat-voice-waveform");
	expect(waveform.childElementCount).toBe(VOICE_WAVEFORM_BARS);
});

it("polls the level without ever resetting it", () => {
	// The destructive read belongs to the liveness beacon. If the waveform ever
	// swapped to that one, the beacon would start seeing a silent mic.
	const peek = vi.fn(() => 0.25);
	renderWaveform(peek);

	act(() => {
		vi.advanceTimersByTime(1000);
	});

	expect(peek).toHaveBeenCalled();
	expect(peek.mock.results.every((r) => r.value === 0.25)).toBe(true);
});

it("renders nothing when no meter is available", () => {
	renderWaveform(undefined);

	expect(screen.queryByTestId("chat-voice-waveform")).toBeNull();
});

it("runs blue while everything is fine and yellow when the connection is not", () => {
	const { unmount } = renderWaveform(() => 0.5, { status: "healthy" });
	act(() => {
		vi.advanceTimersByTime(500);
	});
	expect(barColor()).toContain("primary-6");
	unmount();

	renderWaveform(() => 0.5, { status: "unhealthy" });
	act(() => {
		vi.advanceTimersByTime(500);
	});
	expect(barColor()).toContain("yellow");
});

it("turns red and asks for help when no sound arrives at all", () => {
	const onSilence = vi.fn();
	renderWaveform(() => 0, { onSilence, status: "healthy" });

	// A pause in the conversation is not a dead microphone.
	act(() => {
		vi.advanceTimersByTime(4000);
	});
	expect(onSilence).not.toHaveBeenCalled();
	expect(barColor()).toContain("primary-6");

	act(() => {
		vi.advanceTimersByTime(5000);
	});
	expect(onSilence).toHaveBeenCalledTimes(1);
	expect(barColor()).toContain("red");
});

it("asks only once until sound comes back", () => {
	const onSilence = vi.fn();
	let level = 0;
	renderWaveform(() => level, { onSilence });

	act(() => {
		vi.advanceTimersByTime(20000);
	});
	expect(onSilence).toHaveBeenCalledTimes(1);

	// Somebody dismisses it and the microphone recovers, then dies again.
	level = 0.5;
	act(() => {
		vi.advanceTimersByTime(1000);
	});
	expect(barColor()).toContain("primary-6");

	level = 0;
	act(() => {
		vi.advanceTimersByTime(9000);
	});
	expect(onSilence).toHaveBeenCalledTimes(2);
});

it("keeps a red recording problem even while the connection is only unhealthy", () => {
	renderWaveform(() => 0, { status: "unhealthy" });

	act(() => {
		vi.advanceTimersByTime(9000);
	});

	expect(barColor()).toContain("red");
});
