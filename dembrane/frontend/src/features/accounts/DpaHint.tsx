import { t } from "@lingui/core/macro";
import { Tooltip } from "@mantine/core";
import type { ReactElement } from "react";

/**
 * Spells "DPA" out, in the reader's language, for whoever hovers, focuses or taps the
 * label, tag or heading it wraps. The account area says "DPA" everywhere; this is where
 * someone who has never met the abbreviation finds what it stands for.
 */
/** The tooltip of a link that opens the DPA: what it does, and what "DPA" stands for. */
export const openDpaHint = () => t`Open the DPA (data processing agreement)`;

export function DpaHint({ children }: { children: ReactElement }) {
	return (
		<Tooltip
			label={t`DPA: data processing agreement`}
			events={{ focus: true, hover: true, touch: true }}
			// Under what it explains, from its left edge, so it never covers the line above.
			position="bottom-start"
		>
			{children}
		</Tooltip>
	);
}
