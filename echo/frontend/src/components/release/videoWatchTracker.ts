/**
 * Watch-progress accounting for the release video, fed by the messages the
 * YouTube embed already posts.
 *
 * With `enablejsapi=1` on the embed URL the player inside the frame speaks
 * the widget postMessage protocol: after a `listening` handshake it sends
 * `initialDelivery` and then streams `infoDelivery` carrying `currentTime`,
 * `duration` and `playerState`. Listening to that stream is the whole
 * integration. No YouTube script is loaded, no origin is added to the CSP,
 * and the frame stays on www.youtube-nocookie.com. This is the deliberate
 * alternative to the official IFrame API loader, which serves from
 * www.youtube.com and is blocked by `script-src` (vercel.json) anyway.
 *
 * This module is the pure half: it turns player snapshots into the analytics
 * events they imply. The modal owns the wiring (message listener, handshake,
 * PostHog).
 */

/** Player states from the widget protocol, same values the IFrame API documents. */
export const PLAYER_STATE_ENDED = 0;
export const PLAYER_STATE_PLAYING = 1;

/**
 * Furthest-position marks that each earn a durable event. The close summary
 * only exists if the tab survives to send it; a milestone sent at the moment
 * it is crossed is what remains of a session that ends with the tab.
 */
export const MILESTONES = [25, 50, 75, 95] as const;

/**
 * Playback ticks arrive a few times a second, so consecutive `currentTime`
 * readings differ by well under a second even at double speed. A gap above
 * this is a seek, and a seek is not watching.
 */
const MAX_PLAYBACK_STEP_SECONDS = 3;

/** The slice of a delivery message the tracker cares about. */
export interface PlayerInfo {
	currentTime?: number;
	duration?: number;
	playerState?: number;
}

export type WatchEvent =
	| { type: "started" }
	| { milestone: (typeof MILESTONES)[number]; type: "milestone" }
	| { type: "ended" };

export interface WatchSnapshot {
	/** Total length the player reported, 0 until it has said. */
	durationSeconds: number;
	/** True once the player reported the ended state. */
	ended: boolean;
	/** Furthest position reached as a percentage, null without a duration. */
	maxPercent: number | null;
	/** Watched seconds over duration, capped at 100, null without a duration. */
	percentWatched: number | null;
	/** True once playback started at all. */
	started: boolean;
	/**
	 * Content seconds actually played: the sum of small forward `currentTime`
	 * steps. Seeks are skipped (the step is too large), rewatching counts
	 * again, and double speed counts the content covered, not the wall clock.
	 */
	watchedSeconds: number;
}

export type WatchTracker = ReturnType<typeof createWatchTracker>;

export const createWatchTracker = () => {
	let duration = 0;
	let ended = false;
	let lastTime: number | null = null;
	let maxPosition = 0;
	let playing = false;
	let started = false;
	let watched = 0;
	const milestonesReached = new Set<number>();

	const handleInfo = (info: PlayerInfo): WatchEvent[] => {
		const events: WatchEvent[] = [];
		let justEnded = false;

		if (typeof info.duration === "number" && info.duration > 0) {
			duration = info.duration;
		}

		// Most deliveries carry no playerState (the stream sends deltas), so
		// `playing` holds its last value until a message says otherwise.
		if (typeof info.playerState === "number") {
			if (info.playerState === PLAYER_STATE_PLAYING && !started) {
				started = true;
				events.push({ type: "started" });
			}
			if (info.playerState === PLAYER_STATE_ENDED && !ended) {
				ended = true;
				justEnded = true;
				// The last delivery can stop just short of the end; ending IS
				// reaching the end, so the milestones below all settle.
				if (duration > 0) {
					maxPosition = duration;
				}
			}
			playing = info.playerState === PLAYER_STATE_PLAYING;
			if (!playing) {
				lastTime = null;
			}
		}

		if (typeof info.currentTime === "number") {
			if (playing) {
				if (lastTime !== null) {
					const step = info.currentTime - lastTime;
					if (step > 0 && step <= MAX_PLAYBACK_STEP_SECONDS) {
						watched += step;
					}
				}
				lastTime = info.currentTime;
			}
			if (info.currentTime > maxPosition) {
				maxPosition = info.currentTime;
			}
		}

		if (duration > 0) {
			const percent = (maxPosition / duration) * 100;
			for (const milestone of MILESTONES) {
				if (percent >= milestone && !milestonesReached.has(milestone)) {
					milestonesReached.add(milestone);
					events.push({ milestone, type: "milestone" });
				}
			}
		}

		// Ordered after the milestones so an ended video reports 95 before done.
		if (justEnded) {
			events.push({ type: "ended" });
		}

		return events;
	};

	const snapshot = (): WatchSnapshot => ({
		durationSeconds: roundTenth(duration),
		ended,
		maxPercent:
			duration > 0
				? Math.min(100, Math.round((maxPosition / duration) * 100))
				: null,
		percentWatched:
			duration > 0
				? Math.min(100, Math.round((watched / duration) * 100))
				: null,
		started,
		watchedSeconds: roundTenth(watched),
	});

	return { handleInfo, snapshot };
};

const roundTenth = (value: number): number => Math.round(value * 10) / 10;

/**
 * Read a widget message into a PlayerInfo, or null when the message is not
 * one of ours. The widget posts JSON strings; `infoDelivery` and
 * `initialDelivery` carry the info object, `onStateChange` carries the state
 * number alone. Anything else (onReady, foreign frames, junk) is ignored.
 */
export const playerInfoFromMessage = (data: unknown): PlayerInfo | null => {
	if (typeof data !== "string") return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(data);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const message = parsed as { event?: unknown; info?: unknown };

	if (
		(message.event === "infoDelivery" || message.event === "initialDelivery") &&
		typeof message.info === "object" &&
		message.info !== null
	) {
		const raw = message.info as Record<string, unknown>;
		const info: PlayerInfo = {};
		if (typeof raw.currentTime === "number") info.currentTime = raw.currentTime;
		if (typeof raw.duration === "number") info.duration = raw.duration;
		if (typeof raw.playerState === "number") info.playerState = raw.playerState;
		return info;
	}

	if (message.event === "onStateChange" && typeof message.info === "number") {
		return { playerState: message.info };
	}

	return null;
};
