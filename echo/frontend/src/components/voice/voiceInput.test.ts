import { AxiosError, AxiosHeaders } from "axios";
import { expect, it } from "vitest";
import {
	captureErrorKind,
	formatElapsed,
	isEmptyTranscript,
	mergeTranscriptIntoDraft,
	NOTHING_TO_TRANSCRIBE,
	transcribeErrorKind,
	VOICE_WAVEFORM_BARS,
	waveformHeights,
} from "./voiceInput";

const axiosErrorWithStatus = (status: number) => {
	const headers = new AxiosHeaders();
	return new AxiosError("failed", "ERR", { headers }, undefined, {
		config: { headers },
		data: {},
		headers: {},
		status,
		statusText: "",
	});
};

it("reads a denied microphone as a permission answer, not a fault", () => {
	const denied = new DOMException("denied", "NotAllowedError");
	expect(captureErrorKind(denied)).toBe("permission");
});

it("separates a missing or busy device from a denial", () => {
	expect(captureErrorKind(new DOMException("gone", "NotFoundError"))).toBe(
		"device",
	);
	expect(captureErrorKind(new DOMException("busy", "NotReadableError"))).toBe(
		"device",
	);
});

it("maps each failure the endpoint can return onto its own message", () => {
	expect(transcribeErrorKind(axiosErrorWithStatus(413))).toBe("too_large");
	expect(transcribeErrorKind(axiosErrorWithStatus(400))).toBe("empty");
	expect(transcribeErrorKind(axiosErrorWithStatus(403))).toBe("not_allowed");
	expect(transcribeErrorKind(axiosErrorWithStatus(404))).toBe("not_found");
	expect(transcribeErrorKind(axiosErrorWithStatus(502))).toBe(
		"transcription_failed",
	);
});

it("calls a request that never reached the server a network problem", () => {
	const headers = new AxiosHeaders();
	const offline = new AxiosError("Network Error", "ERR_NETWORK", { headers });
	expect(transcribeErrorKind(offline)).toBe("network");
});

it("does not guess at a failure that is not an HTTP one", () => {
	expect(transcribeErrorKind(new Error("something else"))).toBe("unknown");
});

it("formats elapsed time as minutes and padded seconds", () => {
	expect(formatElapsed(0)).toBe("0:00");
	expect(formatElapsed(7_400)).toBe("0:07");
	expect(formatElapsed(65_000)).toBe("1:05");
	expect(formatElapsed(300_000)).toBe("5:00");
	expect(formatElapsed(-10)).toBe("0:00");
});

it("adds the transcript to a draft instead of replacing what was typed", () => {
	expect(mergeTranscriptIntoDraft("", "hello there")).toBe("hello there");
	expect(mergeTranscriptIntoDraft("my question:  ", " and then this ")).toBe(
		"my question: and then this",
	);
});

it("leaves the draft alone when the transcript is only whitespace", () => {
	expect(mergeTranscriptIntoDraft("keep me", "   ")).toBe("keep me");
});

it("recognises the pipeline's own word for silence", () => {
	expect(isEmptyTranscript(NOTHING_TO_TRANSCRIBE)).toBe(true);
	expect(isEmptyTranscript("   ")).toBe(true);
	expect(isEmptyTranscript("a real sentence")).toBe(false);
});

it("keeps the waveform a fixed width however few samples have arrived", () => {
	expect(waveformHeights([]).length).toBe(VOICE_WAVEFORM_BARS);
	expect(waveformHeights([0.5, 0.5]).length).toBe(VOICE_WAVEFORM_BARS);
	expect(waveformHeights(Array(200).fill(0.5)).length).toBe(
		VOICE_WAVEFORM_BARS,
	);
});

it("keeps a silent meter visible and clamps a loud one", () => {
	const heights = waveformHeights([0, 1, 2, -1]);
	expect(Math.min(...heights)).toBeGreaterThanOrEqual(8);
	expect(Math.max(...heights)).toBeLessThanOrEqual(100);
});

it("shows the newest samples, dropping the oldest", () => {
	const levels = [...Array(VOICE_WAVEFORM_BARS).fill(0), 1];
	expect(waveformHeights(levels).at(-1)).toBe(100);
});
