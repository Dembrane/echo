/**
 * What the audio screen layers on top of the recorder. Whether audio is
 * running is the recorder's to say (`isRecording`); this tracks what the
 * participant did with it: stopped at a time and maybe confirming, finishing,
 * cut off by an interruption, or left with a deleted conversation.
 *
 * `live` means nothing is layered on: the recorder alone decides whether the
 * screen is idle or recording.
 */
export type RecordingSession =
	| { phase: "live" }
	| { phase: "paused"; at: number; confirming: boolean }
	| { phase: "finishing"; at: number; confirming: boolean }
	| { phase: "interrupted"; at: number; reconnecting: boolean }
	| { phase: "deleted" };

export type RecordingSessionEvent =
	| { type: "stop"; at: number }
	| { type: "resume" }
	| { type: "recordingStarted" }
	| { type: "switchToText" }
	| { type: "finishStarted" }
	| { type: "skipVerification" }
	| { type: "finishFailed" }
	| { type: "finishSucceeded" }
	| { type: "interrupted"; at: number }
	| { type: "reconnectStarted" }
	| { type: "reconnectFailed" }
	| { type: "conversationDeleted" };

export const initialRecordingSession: RecordingSession = { phase: "live" };

/** Events that don't apply to the current phase leave it as it is. */
export const recordingSessionReducer = (
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

		// From the verify prompt: the confirm modal closes, then finishing starts.
		case "skipVerification":
			return session.phase === "paused"
				? { at: session.at, confirming: false, phase: "finishing" }
				: session;

		case "finishFailed":
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

		case "reconnectFailed":
			return session.phase === "interrupted"
				? { ...session, reconnecting: false }
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
 * Partway through a recording: running, or held by a stop, a finish or an
 * interruption. The timer and the meter show for all of it.
 */
export const isMidRecording = (
	session: RecordingSession,
	isRecording: boolean,
): boolean =>
	isRecording || (session.phase !== "live" && session.phase !== "deleted");

/** The time the timer shows: frozen while held, the recorder's otherwise. */
export const displayTime = (
	session: RecordingSession,
	recordingTime: number,
): number =>
	session.phase === "interrupted"
		? session.at
		: (pausedAt(session) ?? recordingTime);
