/**
 * What the audio screen layers on top of the recorder. Whether audio is
 * running is the recorder's to say (`isRecording`); this tracks what the
 * participant did with it: stopped at a time and maybe confirming, finishing,
 * cut off by an interruption, or left with a deleted conversation.
 *
 * `live` means nothing is layered on: the recorder alone decides whether the
 * screen is idle or recording. `at` is null when finishing without having
 * stopped here first, from the bar's Finish after a reload.
 */
export type RecordingSession =
	| { phase: "live" }
	| { phase: "paused"; at: number | null; confirming: boolean }
	| { phase: "finishing"; at: number | null; confirming: boolean }
	| { phase: "interrupted"; at: number; reconnecting: boolean }
	| { phase: "deleted" };

export type RecordingSessionEvent =
	| { type: "stop"; at: number }
	| { type: "confirmFinish" }
	| { type: "resume" }
	| { type: "recordingStarted" }
	| { type: "switchToText" }
	| { type: "finishStarted" }
	| { type: "finishFailed" }
	| { type: "finishCancelled" }
	| { type: "finishSucceeded" }
	| { type: "interrupted"; at: number }
	| { type: "reconnectStarted" }
	| { type: "conversationDeleted" };

export const initialRecordingSession: RecordingSession = { phase: "live" };

/** Events that don't apply to the current phase leave it as it is. */
export const recordingSessionReducer = (
	session: RecordingSession,
	event: RecordingSessionEvent,
): RecordingSession => {
	const next = transition(session, event);
	// Paused with no time and no modal holds nothing.
	return next.phase === "paused" && next.at === null && !next.confirming
		? initialRecordingSession
		: next;
};

const transition = (
	session: RecordingSession,
	event: RecordingSessionEvent,
): RecordingSession => {
	if (session.phase === "deleted") return session;

	switch (event.type) {
		case "conversationDeleted":
			return { phase: "deleted" };

		case "interrupted":
			return { at: event.at, phase: "interrupted", reconnecting: false };

		case "stop":
			return session.phase === "live"
				? { at: event.at, confirming: true, phase: "paused" }
				: session;

		case "confirmFinish":
			return session.phase === "live"
				? { at: null, confirming: true, phase: "paused" }
				: session;

		// The paused time stays until the recorder has actually started again,
		// so the timer doesn't flash back to zero in between.
		case "resume":
			return session.phase === "paused"
				? { ...session, confirming: false }
				: session;

		case "recordingStarted":
			return session.phase === "paused" ? initialRecordingSession : session;

		case "switchToText":
			return session.phase === "paused" ? initialRecordingSession : session;

		case "finishStarted":
			return session.phase === "paused"
				? { ...session, phase: "finishing" }
				: session;

		// Back to the confirm modal, to resume or try again.
		case "finishFailed":
		case "finishCancelled":
			return session.phase === "finishing"
				? { ...session, phase: "paused" }
				: session;

		case "finishSucceeded":
			return session.phase === "finishing"
				? { ...session, confirming: false }
				: session;

		case "reconnectStarted":
			return session.phase === "interrupted"
				? { ...session, reconnecting: true }
				: session;
	}
};

/** Where the participant stopped, while stopped or finishing. */
export const pausedAt = (session: RecordingSession): number | null =>
	session.phase === "paused" || session.phase === "finishing"
		? session.at
		: null;

export const isConfirmOpen = (session: RecordingSession): boolean =>
	(session.phase === "paused" || session.phase === "finishing") &&
	session.confirming;

/**
 * Held partway through a recording, by a stop, the confirm modal or an
 * interruption. The timer shows paused, and the start buttons stay away.
 */
export const isHeld = (session: RecordingSession): boolean =>
	session.phase === "interrupted" ||
	isConfirmOpen(session) ||
	pausedAt(session) !== null;

/** The time the timer shows: frozen while held, the recorder's otherwise. */
export const displayTime = (
	session: RecordingSession,
	recordingTime: number,
): number =>
	session.phase === "interrupted"
		? session.at
		: (pausedAt(session) ?? recordingTime);
