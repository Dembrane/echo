import type { ResultActions } from "../useResultActions";

/**
 * Hiding a finding from this presentation, in one click.
 *
 * Keeping a finding off the screen is an editorial decision a host makes in
 * the minutes before doors open, and the row it is made in is not the place to
 * ask for an essay: the eye-slash hides, the row greys, and the same glyph in
 * the same place brings it back. No prompt, no reason, no countdown — the way
 * out of a hide is the way into it. Withdrawing from the analysis is the heavy
 * one, and that one still asks.
 */
export function useHide({
	objectId,
	actions,
}: {
	objectId: string;
	actions: ResultActions;
}) {
	return {
		canHide: Boolean(actions.holdBack),
		held: actions.isHeld(objectId),
		/** One click. No reason, no prompt, no dialog. */
		hide: () => actions.holdBack?.(objectId, ""),
		objectId,
		show: () => actions.showAgain?.(objectId, ""),
	};
}

export type Hide = ReturnType<typeof useHide>;
