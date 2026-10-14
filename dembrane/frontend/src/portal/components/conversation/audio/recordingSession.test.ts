import { describe, expect, it } from "vitest";
import {
	displayTime,
	isConfirmOpen,
	isHeld,
	initialRecordingSession as live,
	pausedAt,
	type RecordingSession,
	type RecordingSessionEvent,
	recordingSessionReducer as reduce,
} from "./recordingSession";

const paused: RecordingSession = { at: 75, confirming: true, phase: "paused" };
const resuming: RecordingSession = { ...paused, confirming: false };
const finishing: RecordingSession = { ...paused, phase: "finishing" };
const interrupted: RecordingSession = {
	at: 42,
	phase: "interrupted",
	reconnecting: false,
};
const deleted: RecordingSession = { phase: "deleted" };

const run = (session: RecordingSession, ...events: RecordingSessionEvent[]) =>
	events.reduce(reduce, session);

describe("recordingSessionReducer", () => {
	it("pauses at the stopped time with the confirm modal open", () => {
		expect(reduce(live, { at: 75, type: "stop" })).toEqual(paused);
	});

	it("keeps the paused time after resume until recording has started", () => {
		expect(reduce(paused, { type: "resume" })).toEqual(resuming);
		expect(reduce(resuming, { type: "recordingStarted" })).toEqual(live);
	});

	it("clears the pause when switching to text", () => {
		expect(reduce(paused, { type: "switchToText" })).toEqual(live);
	});

	it("finishes from the confirm modal, and lands back in it on failure", () => {
		expect(reduce(paused, { type: "finishStarted" })).toEqual(finishing);
		expect(reduce(finishing, { type: "finishFailed" })).toEqual(paused);
	});

	it("closes the confirm modal once finished", () => {
		expect(reduce(finishing, { type: "finishSucceeded" })).toEqual({
			...finishing,
			confirming: false,
		});
	});

	it("confirms a finish from the bar with no stopped time", () => {
		const confirming = reduce(live, { type: "confirmFinish" });
		expect(confirming).toEqual({ at: null, confirming: true, phase: "paused" });
		expect(reduce(confirming, { type: "finishStarted" })).toEqual({
			at: null,
			confirming: true,
			phase: "finishing",
		});
	});

	it("drops back to live when a pause has no time and no modal", () => {
		const confirming = reduce(live, { type: "confirmFinish" });
		expect(reduce(confirming, { type: "resume" })).toEqual(live);
	});

	it("holds an interruption at its time while reconnecting", () => {
		const cutOff = reduce(live, { at: 42, type: "interrupted" });
		expect(cutOff).toEqual(interrupted);
		expect(reduce(cutOff, { type: "reconnectStarted" })).toEqual({
			...interrupted,
			reconnecting: true,
		});
		expect(
			run(cutOff, { type: "reconnectStarted" }, { type: "reconnectFailed" }),
		).toEqual(interrupted);
	});

	it("ends in deleted, from anywhere, for good", () => {
		for (const from of [live, paused, finishing, interrupted]) {
			expect(reduce(from, { type: "conversationDeleted" })).toEqual(deleted);
		}
		expect(reduce(deleted, { at: 1, type: "stop" })).toBe(deleted);
		expect(reduce(deleted, { at: 1, type: "interrupted" })).toBe(deleted);
	});

	it("ignores events that don't apply to the phase", () => {
		const ignored: [RecordingSession, RecordingSessionEvent][] = [
			[live, { type: "resume" }],
			[live, { type: "recordingStarted" }],
			[live, { type: "finishStarted" }],
			[live, { type: "reconnectStarted" }],
			[paused, { at: 90, type: "stop" }],
			[paused, { type: "confirmFinish" }],
			[paused, { type: "finishSucceeded" }],
			[finishing, { type: "resume" }],
			[finishing, { type: "finishStarted" }],
			[finishing, { type: "switchToText" }],
			[interrupted, { at: 90, type: "stop" }],
			[interrupted, { type: "recordingStarted" }],
		];
		for (const [session, event] of ignored) {
			expect(reduce(session, event)).toBe(session);
		}
	});
});

describe("selectors", () => {
	it("has a paused time while paused or finishing", () => {
		expect(pausedAt(live)).toBeNull();
		expect(pausedAt(paused)).toBe(75);
		expect(pausedAt(resuming)).toBe(75);
		expect(pausedAt(finishing)).toBe(75);
		expect(pausedAt(interrupted)).toBeNull();
	});

	it("opens the confirm modal only while confirming", () => {
		expect(isConfirmOpen(paused)).toBe(true);
		expect(isConfirmOpen(finishing)).toBe(true);
		expect(isConfirmOpen(resuming)).toBe(false);
		expect(isConfirmOpen(interrupted)).toBe(false);
	});

	it("is held by a stopped time, the confirm modal or an interruption", () => {
		for (const held of [paused, resuming, finishing, interrupted]) {
			expect(isHeld(held)).toBe(true);
		}
		expect(isHeld(reduce(live, { type: "confirmFinish" }))).toBe(true);
		expect(isHeld({ at: null, confirming: false, phase: "finishing" })).toBe(
			false,
		);
		expect(isHeld(live)).toBe(false);
		expect(isHeld(deleted)).toBe(false);
	});

	it("shows the held time, or the recorder's while live", () => {
		expect(displayTime(live, 10)).toBe(10);
		expect(displayTime(paused, 10)).toBe(75);
		expect(displayTime(finishing, 10)).toBe(75);
		expect(displayTime(interrupted, 10)).toBe(42);
	});
});
