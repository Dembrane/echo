import { useEffect, useRef, useState } from "react";
import { UNDO_SECONDS } from "../resultEditing";
import type { ResultActions } from "../useResultActions";

/**
 * Hiding a finding from this presentation, in one click.
 *
 * Keeping a finding off the screen is an editorial decision a host makes in
 * the minutes before doors open, and the row it is made in is not the place to
 * ask for an essay: the eye-slash hides, the words dim, and the line under
 * them offers the way back for ten seconds and the way to say why for as long
 * as the panel is open. Withdrawing from the analysis is the heavy one, and
 * that one still asks.
 */
export function useHide({
	objectId,
	actions,
}: {
	objectId: string;
	actions: ResultActions;
}) {
	// The ten seconds after the click in which the line offers the way straight
	// back out of it.
	const [undoable, setUndoable] = useState(false);
	// The host asked to say why: the reason prompt takes the line over.
	const [asking, setAsking] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const control = useRef<HTMLButtonElement>(null);

	// The timer belongs to the row: it stops when the row goes.
	useEffect(
		() => () => {
			if (timer.current) clearTimeout(timer.current);
		},
		[],
	);

	const held = actions.isHeld(objectId);
	const canHide = Boolean(actions.holdBack);

	const offer = () => {
		setUndoable(true);
		if (timer.current) clearTimeout(timer.current);
		timer.current = setTimeout(() => setUndoable(false), UNDO_SECONDS * 1000);
	};

	return {
		/** The host is writing the reason for a hide already made. */
		asking,
		askReason: () => setAsking(true),
		canHide,
		control,
		held,
		/** One click. No reason, no prompt, no dialog. */
		hide: () => {
			actions.holdBack?.(objectId, "");
			setAsking(false);
			offer();
		},
		objectId,
		/** Why this host hid it, where they said so on this page. */
		reason: held ? actions.heldReason(objectId) : undefined,
		/** The reason the host gave, against a finding already hidden. */
		saveReason: (reason: string) => {
			actions.holdBack?.(objectId, reason);
			setAsking(false);
			control.current?.focus();
		},
		show: () => {
			actions.showAgain?.(objectId, "");
			setAsking(false);
			setUndoable(false);
		},
		stopAsking: () => {
			setAsking(false);
			control.current?.focus();
		},
		undoable,
	};
}

export type Hide = ReturnType<typeof useHide>;
