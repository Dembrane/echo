import { Trans } from "@lingui/react/macro";
import type { RefineMode } from "./refineMode";

/**
 * The recorder's button after the first minute (ECHO-1052): named after where it goes.
 * With both on it opens the choice, and says so, instead of the old "ECHO".
 */
export const RefineButtonLabel = ({ mode }: { mode: RefineMode | null }) => {
	if (mode === "verify")
		return <Trans id="participant.button.refine.verify">Verify</Trans>;
	if (mode === "explore")
		return <Trans id="participant.button.refine.explore">Explore</Trans>;
	return <Trans id="participant.button.refine.both">Verify or explore</Trans>;
};
