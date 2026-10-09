import { describe, expect, it } from "vitest";
import { deriveParticipantState } from "./participantState";

const idle = {
	documentHidden: false,
	isOnRefineRoute: false,
	isOnVerifyRoute: false,
	isPaused: false,
	isRecording: false,
	isStopping: false,
};

describe("deriveParticipantState", () => {
	it("is waiting with nothing going on", () => {
		expect(deriveParticipantState(idle)).toBe("waiting");
	});

	it("is recording, or paused once stopped at a time", () => {
		expect(deriveParticipantState({ ...idle, isRecording: true })).toBe(
			"recording",
		);
		expect(deriveParticipantState({ ...idle, isPaused: true })).toBe("paused");
	});

	it("is backgrounded only when hidden while recording", () => {
		expect(
			deriveParticipantState({
				...idle,
				documentHidden: true,
				isRecording: true,
			}),
		).toBe("backgrounded");
		expect(deriveParticipantState({ ...idle, documentHidden: true })).toBe(
			"waiting",
		);
	});

	it("reports verify and refine over recording", () => {
		const recording = { ...idle, isRecording: true };
		expect(
			deriveParticipantState({ ...recording, isOnVerifyRoute: true }),
		).toBe("verifying");
		expect(
			deriveParticipantState({ ...recording, isOnRefineRoute: true }),
		).toBe("refining");
	});

	it("reports finishing over everything", () => {
		expect(
			deriveParticipantState({
				documentHidden: true,
				isOnRefineRoute: true,
				isOnVerifyRoute: true,
				isPaused: true,
				isRecording: true,
				isStopping: true,
			}),
		).toBe("finishing");
	});
});
