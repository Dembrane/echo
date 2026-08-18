import { describe, expect, it } from "vitest";
import {
	createWatchTracker,
	PLAYER_STATE_ENDED,
	PLAYER_STATE_PLAYING,
	playerInfoFromMessage,
	type WatchEvent,
} from "./videoWatchTracker";

const types = (events: WatchEvent[]) => events.map((event) => event.type);

describe("the watch tracker", () => {
	it("reports started once, on the first playing state", () => {
		const tracker = createWatchTracker();
		expect(
			types(tracker.handleInfo({ playerState: PLAYER_STATE_PLAYING })),
		).toEqual(["started"]);
		expect(tracker.handleInfo({ playerState: PLAYER_STATE_PLAYING })).toEqual(
			[],
		);
		expect(tracker.snapshot().started).toBe(true);
	});

	it("adds up playback ticks but never a seek", () => {
		const tracker = createWatchTracker();
		tracker.handleInfo({
			currentTime: 0,
			duration: 100,
			playerState: PLAYER_STATE_PLAYING,
		});
		tracker.handleInfo({ currentTime: 0.5 });
		tracker.handleInfo({ currentTime: 1.0 });
		// A 40 second jump is a scrub, not 40 seconds of watching.
		tracker.handleInfo({ currentTime: 41 });
		tracker.handleInfo({ currentTime: 41.5 });

		const snap = tracker.snapshot();
		expect(snap.watchedSeconds).toBe(1.5);
		// The seek still counts as ground covered.
		expect(snap.maxPercent).toBe(42);
	});

	it("holds the playing state across deliveries that omit it", () => {
		const tracker = createWatchTracker();
		tracker.handleInfo({
			currentTime: 0,
			duration: 100,
			playerState: PLAYER_STATE_PLAYING,
		});
		// The delta stream sends bare currentTime while playing.
		tracker.handleInfo({ currentTime: 1 });
		expect(tracker.snapshot().watchedSeconds).toBe(1);

		// Paused: positions may still arrive (a scrub) but are not watching.
		tracker.handleInfo({ currentTime: 10, playerState: 2 });
		tracker.handleInfo({ currentTime: 11 });
		expect(tracker.snapshot().watchedSeconds).toBe(1);
	});

	it("fires each milestone once as the furthest position crosses it", () => {
		const tracker = createWatchTracker();
		tracker.handleInfo({
			currentTime: 0,
			duration: 100,
			playerState: PLAYER_STATE_PLAYING,
		});

		const atQuarter = tracker.handleInfo({ currentTime: 26 });
		expect(atQuarter).toEqual([{ milestone: 25, type: "milestone" }]);

		// Rewinding and passing 25% again does not refire it.
		tracker.handleInfo({ currentTime: 1 });
		expect(tracker.handleInfo({ currentTime: 27 })).toEqual([]);

		const atEightyPercent = tracker.handleInfo({ currentTime: 80 });
		expect(atEightyPercent).toEqual([
			{ milestone: 50, type: "milestone" },
			{ milestone: 75, type: "milestone" },
		]);
	});

	it("treats ending as reaching the end, milestones and all", () => {
		const tracker = createWatchTracker();
		tracker.handleInfo({
			currentTime: 0,
			duration: 100,
			playerState: PLAYER_STATE_PLAYING,
		});
		const finale = tracker.handleInfo({
			currentTime: 99.4,
			playerState: PLAYER_STATE_ENDED,
		});
		expect(types(finale)).toEqual([
			"milestone",
			"milestone",
			"milestone",
			"milestone",
			"ended",
		]);
		const snap = tracker.snapshot();
		expect(snap.ended).toBe(true);
		expect(snap.maxPercent).toBe(100);
	});

	it("answers null percentages until the player has named a duration", () => {
		const tracker = createWatchTracker();
		tracker.handleInfo({ currentTime: 5, playerState: PLAYER_STATE_PLAYING });
		const snap = tracker.snapshot();
		expect(snap.percentWatched).toBeNull();
		expect(snap.maxPercent).toBeNull();
	});

	it("caps percent watched at 100 when a section is rewatched", () => {
		const tracker = createWatchTracker();
		tracker.handleInfo({
			currentTime: 0,
			duration: 2,
			playerState: PLAYER_STATE_PLAYING,
		});
		// Watch the two seconds, twice over.
		tracker.handleInfo({ currentTime: 1 });
		tracker.handleInfo({ currentTime: 2 });
		tracker.handleInfo({ currentTime: 0.1 });
		tracker.handleInfo({ currentTime: 1.1 });
		tracker.handleInfo({ currentTime: 2.0 });
		const snap = tracker.snapshot();
		expect(snap.watchedSeconds).toBeGreaterThan(2);
		expect(snap.percentWatched).toBe(100);
	});
});

describe("reading widget messages", () => {
	it("reads an infoDelivery", () => {
		expect(
			playerInfoFromMessage(
				JSON.stringify({
					event: "infoDelivery",
					info: { currentTime: 3.2, duration: 90, playerState: 1 },
				}),
			),
		).toEqual({ currentTime: 3.2, duration: 90, playerState: 1 });
	});

	it("reads an initialDelivery and drops fields of the wrong type", () => {
		expect(
			playerInfoFromMessage(
				JSON.stringify({
					event: "initialDelivery",
					info: { currentTime: "soon", duration: 90 },
				}),
			),
		).toEqual({ duration: 90 });
	});

	it("reads an onStateChange, whose info is the bare state number", () => {
		expect(
			playerInfoFromMessage(
				JSON.stringify({ event: "onStateChange", info: 1 }),
			),
		).toEqual({ playerState: 1 });
	});

	it("ignores everything else", () => {
		expect(playerInfoFromMessage(undefined)).toBeNull();
		expect(playerInfoFromMessage({ event: "infoDelivery" })).toBeNull();
		expect(playerInfoFromMessage("not json")).toBeNull();
		expect(playerInfoFromMessage('"a json string"')).toBeNull();
		expect(
			playerInfoFromMessage(JSON.stringify({ event: "onReady" })),
		).toBeNull();
	});
});
