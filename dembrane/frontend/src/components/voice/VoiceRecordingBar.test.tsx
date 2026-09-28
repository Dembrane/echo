// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { VOICE_WAVEFORM_BARS } from "./voiceInput";
import { VoiceRecordingBar } from "./VoiceRecordingBar";

let prefersReducedMotion = false;

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");
});

beforeEach(() => {
	prefersReducedMotion = false;
	// MantineProvider and useReducedMotion both read matchMedia; jsdom has none.
	vi.stubGlobal("matchMedia", (query: string) => ({
		addEventListener: () => {},
		addListener: () => {},
		dispatchEvent: () => false,
		matches: query.includes("prefers-reduced-motion") && prefersReducedMotion,
		media: query,
		onchange: null,
		removeEventListener: () => {},
		removeListener: () => {},
	}));
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

const renderBar = (props: Parameters<typeof VoiceRecordingBar>[0]) =>
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<VoiceRecordingBar {...props} />
			</MantineProvider>
		</I18nProvider>,
	);

it("shows how long the recording has been running", () => {
	renderBar({ elapsedMs: 65_000, isTranscribing: false, levels: [] });
	expect(screen.getByTestId("chat-voice-elapsed").textContent).toBe("1:05");
	expect(screen.getByRole("status").textContent).toBe("Recording");
});

it("draws one bar per meter position whatever has arrived so far", () => {
	renderBar({ elapsedMs: 1000, isTranscribing: false, levels: [0.2, 0.9] });
	const waveform = screen.getByTestId("chat-voice-waveform");
	expect(waveform.children.length).toBe(VOICE_WAVEFORM_BARS);
	// Decorative: the status text and the timer carry this for a screen reader.
	expect(waveform.getAttribute("aria-hidden")).toBe("true");
});

it("stops animating the meter when motion is unwelcome", () => {
	prefersReducedMotion = true;
	renderBar({ elapsedMs: 1000, isTranscribing: false, levels: [0.1, 0.95] });
	const bars = Array.from(
		screen.getByTestId("chat-voice-waveform").children,
	) as HTMLElement[];
	expect(bars.every((bar) => bar.style.transition === "")).toBe(true);
	// Every bar the same height: nothing moves, and the ticking timer beside it
	// is what proves the recording is still live.
	expect(new Set(bars.map((bar) => bar.style.height)).size).toBe(1);
});

it("drops the meter and the clock once recording has stopped", () => {
	renderBar({ elapsedMs: 12_000, isTranscribing: true, levels: [0.5] });
	expect(screen.queryByTestId("chat-voice-waveform")).toBeNull();
	expect(screen.queryByTestId("chat-voice-elapsed")).toBeNull();
	expect(screen.getByRole("status").textContent).toBe(
		"Turning your voice note into text",
	);
});
