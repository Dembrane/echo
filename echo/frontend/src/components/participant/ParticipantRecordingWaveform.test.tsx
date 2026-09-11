// @vitest-environment jsdom
import { MantineProvider } from "@mantine/core";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { VOICE_WAVEFORM_BARS } from "@/components/voice/voiceInput";
import { ParticipantRecordingWaveform } from "./ParticipantRecordingWaveform";

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

const renderWaveform = (peekAudioLevel?: () => number) =>
	render(
		<MantineProvider>
			<ParticipantRecordingWaveform peekAudioLevel={peekAudioLevel} />
		</MantineProvider>,
	);

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
