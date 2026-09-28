import type { MouseEvent } from "react";
import type { ResultActions } from "../useResultActions";

/** What every shape in this panel is given. */
export type ShapeProps = {
	actions: ResultActions;
	/** Whether this host may change the analysis at all. */
	canEdit: boolean;
	projectId: string;
	/** The way to the whole picture of a finding, kept so a host can come back. */
	analysisHref: string;
};

/** Anything in a row that answers for itself, so a click on it is its own. */
export const OWN_CONTROLS =
	"button, a, input, textarea, select, label, [data-step]";

/**
 * A row opens the finding from anywhere that is not a control of its own: the
 * words, which edit, and the buttons, which do what they say.
 */
export function openOnClick(event: MouseEvent, open: () => void) {
	const own = (event.target as Element).closest(OWN_CONTROLS);
	if (own && own !== event.currentTarget && event.currentTarget.contains(own))
		return;
	open();
}
