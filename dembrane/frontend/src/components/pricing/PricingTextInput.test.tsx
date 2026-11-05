// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { MantineProvider } from "@mantine/core";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { VoiceRecorderResult } from "@/components/voice/useVoiceRecorder";
import { transcribeStateless } from "@/lib/api";
import { PricingTextInput } from "./PricingTextInput";

/** The composer is mounted directly here, not through the configurator, so the
 * one thing this file is about stays readable: what the transcription call
 * carries when the mount has a project, and what it carries when it has none.
 */

vi.mock("@/lib/api", () => ({
	transcribeStateless: vi.fn(),
}));

/** jsdom has no microphone. The recorder is replaced by a handle the test can
 * pull: `finish` plays the part of the browser handing over one whole file. */
const recorder = vi.hoisted(() => ({
	complete: null as ((result: VoiceRecorderResult) => void) | null,
	error: null as ((kind: string) => void) | null,
	isRecording: false,
	start: vi.fn(),
	stop: vi.fn(),
}));

vi.mock("@/components/voice/useVoiceRecorder", () => ({
	useVoiceRecorder: (options: {
		onComplete: (result: VoiceRecorderResult) => void;
		onError: (kind: string) => void;
	}) => {
		recorder.complete = options.onComplete;
		recorder.error = options.onError;
		return {
			cancel: () => {},
			elapsedMs: 0,
			isRecording: recorder.isRecording,
			isStarting: false,
			levels: [],
			start: recorder.start,
			stop: recorder.stop,
		};
	},
}));

const transcribeMock = vi.mocked(transcribeStateless);

beforeAll(() => {
	i18n.load("en", {});
	i18n.activate("en");

	// MantineProvider reads the OS colour scheme on mount; jsdom has no
	// matchMedia, so stub a minimal (always non-matching) implementation.
	window.matchMedia =
		window.matchMedia ||
		((query: string) => ({
			addEventListener: () => {},
			addListener: () => {},
			dispatchEvent: () => false,
			matches: false,
			media: query,
			onchange: null,
			removeEventListener: () => {},
			removeListener: () => {},
		}));

	if (!globalThis.ResizeObserver) {
		globalThis.ResizeObserver = class {
			disconnect() {}
			observe() {}
			unobserve() {}
		} as unknown as typeof ResizeObserver;
	}
	if (!URL.createObjectURL) {
		URL.createObjectURL = () => "blob:voice-note";
		URL.revokeObjectURL = () => {};
	}
});

beforeEach(() => {
	recorder.complete = null;
	recorder.error = null;
	recorder.isRecording = false;
	transcribeMock.mockReset();
});

afterEach(() => {
	cleanup();
});

const mount = (projectId?: string, workspaceId?: string) => {
	const onAudioRetained = vi.fn();
	const onChange = vi.fn();
	render(
		<I18nProvider i18n={i18n}>
			<MantineProvider>
				<PricingTextInput
					onAudioRetained={onAudioRetained}
					onChange={onChange}
					projectId={projectId}
					questionKey="timing"
					testIdPrefix="pricing-timing"
					value=""
					workspaceId={workspaceId}
				/>
			</MantineProvider>
		</I18nProvider>,
	);
	return { onAudioRetained, onChange };
};

/** One whole recording, well past the floor and well under the ceiling. */
const speak = async () =>
	act(async () => {
		recorder.complete?.({
			blob: new Blob([new Uint8Array(4096)], { type: "audio/webm" }),
			durationMs: 4000,
			reachedLimit: false,
		});
	});

it("names the intake purpose when there is no project to bill", async () => {
	transcribeMock.mockResolvedValue({ note: "", transcript: "six weekends" });
	const { onChange } = mount();

	// The button renders without a project: the purpose is what opens the
	// endpoint, so there is nothing left for a project to gate.
	expect(screen.getByTestId("pricing-timing-voice-record")).toBeTruthy();

	await speak();

	await waitFor(() => expect(transcribeMock).toHaveBeenCalledTimes(1));
	const payload = transcribeMock.mock.calls[0][0];
	expect(payload).toMatchObject({ purpose: "pricing_intake" });
	expect("projectId" in payload && payload.projectId).toBeFalsy();
	expect(onChange).toHaveBeenCalledWith("six weekends");
});

it("bills the project where the mount has one, and names no purpose", async () => {
	transcribeMock.mockResolvedValue({ note: "", transcript: "six weekends" });
	mount("p-1");

	expect(screen.getByTestId("pricing-timing-voice-record")).toBeTruthy();

	await speak();

	await waitFor(() => expect(transcribeMock).toHaveBeenCalledTimes(1));
	const payload = transcribeMock.mock.calls[0][0];
	expect(payload).toMatchObject({ projectId: "p-1" });
	expect("purpose" in payload && payload.purpose).toBeFalsy();
});

it("keeps the recording when the purpose call fails, and offers one retry", async () => {
	transcribeMock.mockRejectedValue(new Error("no transcription today"));
	const { onAudioRetained } = mount();

	await speak();

	await waitFor(() =>
		expect(screen.getByTestId("pricing-timing-voice-failed")).toBeTruthy(),
	);
	expect(onAudioRetained).toHaveBeenCalledWith(
		expect.objectContaining({ duration_ms: 4000, question_key: "timing" }),
	);

	// The second failure retires the retry: the audio travels with the answers
	// from here instead.
	await act(async () => {
		fireEvent.click(screen.getByTestId("pricing-timing-voice-retry"));
	});
	await waitFor(() => expect(transcribeMock).toHaveBeenCalledTimes(2));
	expect(transcribeMock.mock.calls[1][0]).toMatchObject({
		purpose: "pricing_intake",
	});
	expect(screen.queryByTestId("pricing-timing-voice-retry")).toBeNull();
});

it("names the workspace that pays when the form opens inside one", async () => {
	transcribeMock.mockResolvedValue({ note: "", transcript: "six weekends" });
	mount(undefined, "workspace-1");

	await speak();

	await waitFor(() => expect(transcribeMock).toHaveBeenCalledTimes(1));
	expect(transcribeMock.mock.calls[0][0]).toMatchObject({
		purpose: "pricing_intake",
		workspaceId: "workspace-1",
	});
});

it("says this month's AI is used up and steps the mic aside", async () => {
	transcribeMock.mockRejectedValue({
		isAxiosError: true,
		response: {
			data: {
				code: "billing.tier_limit",
				detail: {
					error: "FREE_TIER_LIMIT",
					limit: "ai_budget",
					resets_at: "2026-12-01T00:00:00Z",
				},
				params: { limit: "ai_budget" },
			},
			status: 402,
		},
	});
	const { onAudioRetained } = mount(undefined, "workspace-1");

	await speak();

	const blocked = await screen.findByTestId("pricing-timing-voice-blocked");
	expect(blocked.textContent).toBe("This month's AI is used up.");
	expect(screen.queryByTestId("pricing-timing-voice-record")).toBeNull();
	expect(screen.queryByTestId("pricing-timing-voice-retry")).toBeNull();
	expect(screen.queryByTestId("pricing-timing-voice-failed")).toBeNull();
	expect(screen.queryByTestId("pricing-timing-voice-nudge")).toBeNull();
	// Typing still works, and the recording travels with the answers.
	expect(screen.getByTestId("pricing-timing-input")).toBeTruthy();
	expect(onAudioRetained).toHaveBeenCalledWith(
		expect.objectContaining({ question_key: "timing" }),
	);
});
