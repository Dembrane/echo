import { Trans } from "@lingui/react/macro";
import type { RefineMode } from "./refineMode";

/**
 * The recorder's button after the first minute (ECHO-1052): named after where it goes.
 * With both on it is "ECHO", the product name, in every language (never translated), and
 * opens the choice between Verify and Explore.
 */
export const RefineButtonLabel = ({ mode }: { mode: RefineMode | null }) => {
	if (mode === "verify")
		return <Trans id="participant.button.refine.verify">Verify</Trans>;
	if (mode === "explore")
		return <Trans id="participant.button.refine.explore">Explore</Trans>;
	return "ECHO";
};
