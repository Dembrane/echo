import { t } from "@lingui/core/macro";

import type {
	MonitorConversation,
	ParticipantState,
} from "@/hooks/useConversationMonitor";

/** The host-facing buckets a conversation can sit in. These drive both the
 * funnel columns and the "group by status" dimension in the monitor grid, so a
 * column count and the rows under it can't disagree. */
export type MonitorStatusGroup =
	| "live"
	| "recording_page"
	| "offline"
	| "finished";

/** States that mean "the participant is on the recording page right now, but
 * audio is not flowing": waiting to start, paused, or screen locked (away).
 * They sit apart from the active `live` column so a host can see at a glance
 * who might need a nudge.
 *
 * `left` is deliberately not here. It means the tab was closed or the page was
 * navigated away from without finishing, which is terminal: that participant is
 * not still sitting on the recording page. It groups under `finished` instead,
 * so a host can see how many sessions ended cleanly next to how many just
 * stopped, without either being implied to be still present or hidden. */
const RECORDING_PAGE_STATES: ReadonlySet<ParticipantState> = new Set([
	"waiting",
	"initiated",
	"idle",
	"paused",
	"backgrounded",
]);

export const monitorStatusGroup = (
	conversation: MonitorConversation,
): MonitorStatusGroup => {
	if (
		conversation.is_finished ||
		conversation.state === "finished" ||
		// Ended without finishing. A different outcome, but the same ending.
		conversation.state === "left"
	) {
		return "finished";
	}
	// Contact lost mid-recording. The alarm, and its own bucket.
	if (conversation.state === "offline") return "offline";
	if (RECORDING_PAGE_STATES.has(conversation.state)) return "recording_page";
	if (conversation.is_live) return "live";
	// Not live, not finished, not offline: treat as still on the page rather
	// than claiming it is recording.
	return "recording_page";
};

/** Fixed order. Group order never depends on counts or on live state, so the
 * sections themselves hold their place while conversations move between them.
 *
 * This follows the funnel's left-to-right progression (recording page -> live
 * -> finished) so the grid below never contradicts the funnel above. `offline`
 * has no funnel column of its own; it sits after `live` because that is what an
 * offline session was a moment ago. */
export const STATUS_GROUP_ORDER: MonitorStatusGroup[] = [
	"recording_page",
	"live",
	"offline",
	"finished",
];

export const statusGroupLabel = (group: MonitorStatusGroup): string => {
	switch (group) {
		case "live":
			return t`Live`;
		case "recording_page":
			return t`On recording page`;
		case "offline":
			return t`Offline`;
		default:
			return t`Finished`;
	}
};

/** The three conversation columns of the live funnel: on the recording page,
 * live, then finished. Offline is the one status with no column of its own; a
 * dropped connection is not a stage of the journey, and it is already loud in
 * the summary badges and the state pill. */
export const isOnRecordingPage = (conversation: MonitorConversation): boolean =>
	monitorStatusGroup(conversation) === "recording_page";

export const isLiveRecording = (conversation: MonitorConversation): boolean =>
	monitorStatusGroup(conversation) === "live";

export const isFinishedSession = (conversation: MonitorConversation): boolean =>
	monitorStatusGroup(conversation) === "finished";

// ── Settling ──────────────────────────────────────────────────────────────
//
// Status is live data, so grouping by it would otherwise let a card jump to
// another section on every transient blip (a pause that lasts a second, a
// screen that locks while someone reads a notification). We commit a status
// change only once the new status has held for SETTLE_MS, so the grid moves
// when something really changed and stays put when it didn't.

export const STATUS_SETTLE_MS = 4000;

export type SettledStatus = {
	/** The group the card is rendered under right now. */
	group: MonitorStatusGroup;
	/** A different group observed but not yet committed. */
	pending: MonitorStatusGroup | null;
	/** When `pending` was first observed (epoch ms). */
	since: number;
};

export type SettledStatusMap = ReadonlyMap<string, SettledStatus>;

/** Pure reducer: fold the latest snapshot into the committed status map.
 * Conversations that dropped out of the snapshot are forgotten. */
export const settleStatusGroups = (
	previous: SettledStatusMap,
	conversations: MonitorConversation[],
	now: number,
	delayMs: number = STATUS_SETTLE_MS,
): Map<string, SettledStatus> => {
	const next = new Map<string, SettledStatus>();
	for (const conversation of conversations) {
		const current = monitorStatusGroup(conversation);
		const prior = previous.get(conversation.id);
		// First sighting: adopt immediately, there is nothing to settle against.
		if (!prior) {
			next.set(conversation.id, { group: current, pending: null, since: now });
			continue;
		}
		// Back to (or still on) the committed group: cancel any pending change.
		if (prior.group === current) {
			next.set(conversation.id, {
				group: current,
				pending: null,
				since: prior.since,
			});
			continue;
		}
		// A different group, held long enough: commit it.
		if (prior.pending === current && now - prior.since >= delayMs) {
			next.set(conversation.id, { group: current, pending: null, since: now });
			continue;
		}
		next.set(conversation.id, {
			group: prior.group,
			// Restart the clock when the observed group itself changes.
			pending: current,
			since: prior.pending === current ? prior.since : now,
		});
	}
	return next;
};
