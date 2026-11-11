import { describe, expect, it } from "vitest";
import {
	displayTime,
	isConfirmOpen,
	isFinishing,
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
const wrappedUp: RecordingSession = {
	at: 120,
	finishing: false,
	phase: "wrappedUp",
	reason: "conversation",
};

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

	it("wraps up a live recording at the limit's time", () => {
		expect(
			reduce(live, { at: 120, reason: "conversation", type: "wrapUp" }),
		).toEqual(wrappedUp);
	});

	it("wraps up a stopped recording at the time it stopped", () => {
		const wrap = { at: 0, reason: "account", type: "wrapUp" } as const;
		expect(reduce(paused, wrap)).toEqual({
			at: 75,
			finishing: false,
			phase: "wrappedUp",
			reason: "account",
		});
		expect(reduce(interrupted, wrap)).toMatchObject({
			at: 42,
			phase: "wrappedUp",
		});
		// Finish from the bar after a reload has no stopped time of its own.
		expect(reduce(reduce(live, { type: "confirmFinish" }), wrap)).toMatchObject(
			{ at: 0, phase: "wrappedUp" },
		);
	});

	it("finishes from the wrap-up, and stays in it on failure", () => {
		const started = reduce(wrappedUp, { type: "finishStarted" });
		expect(started).toEqual({ ...wrappedUp, finishing: true });
		expect(reduce(started, { type: "finishFailed" })).toEqual(wrappedUp);
	});

	it("never leaves a wrap-up to record again", () => {
		for (const event of [
			{ type: "resume" },
			{ type: "recordingStarted" },
			{ type: "switchToText" },
			{ type: "confirmFinish" },
			{ at: 5, type: "stop" },
			{ at: 5, type: "interrupted" },
			{ at: 5, reason: "account", type: "wrapUp" },
		] as RecordingSessionEvent[]) {
			expect(reduce(wrappedUp, event)).toBe(wrappedUp);
		}
	});

	it("doesn't wrap up a finish already under way", () => {
		expect(
			reduce(finishing, { at: 5, reason: "account", type: "wrapUp" }),
		).toBe(finishing);
	});

	it("ends in deleted, from anywhere, for good", () => {
		for (const from of [live, paused, finishing, interrupted, wrappedUp]) {
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
		expect(pausedAt(wrappedUp)).toBe(120);
	});

	it("is finishing from either modal", () => {
		expect(isFinishing(finishing)).toBe(true);
		expect(isFinishing({ ...wrappedUp, finishing: true })).toBe(true);
		expect(isFinishing(wrappedUp)).toBe(false);
		expect(isFinishing(paused)).toBe(false);
	});

	it("opens the confirm modal only while confirming", () => {
		expect(isConfirmOpen(paused)).toBe(true);
		expect(isConfirmOpen(finishing)).toBe(true);
		expect(isConfirmOpen(resuming)).toBe(false);
		expect(isConfirmOpen(interrupted)).toBe(false);
		expect(isConfirmOpen(wrappedUp)).toBe(false);
	});

	it("is held by a stopped time, the confirm modal or an interruption", () => {
		for (const held of [paused, resuming, finishing, interrupted, wrappedUp]) {
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
