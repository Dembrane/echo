import { t } from "@lingui/core/macro";
import { Button, Tooltip, VisuallyHidden } from "@mantine/core";
import { QuotesIcon } from "@phosphor-icons/react";
import { useId } from "react";
import { testId } from "@/lib/testUtils";
import type { DigestProvenance } from "../digest";

/**
 * Where a part came from: the source's name, and on hover or focus the words it was taken
 * from. The snippet is also read out with the button.
 */
export const Provenance = ({
	provenance,
	id,
}: {
	provenance?: DigestProvenance | null;
	id: string;
}) => {
	const snippetId = useId();
	if (!provenance) return null;
	return (
		<>
			<Tooltip
				label={`“${provenance.snippet}”`}
				events={{ focus: true, hover: true, touch: true }}
				multiline
				maw={320}
				withArrow
			>
				<Button
					variant="subtle"
					size="compact-xs"
					color="gray"
					leftSection={<QuotesIcon size={16} aria-hidden />}
					aria-describedby={snippetId}
					styles={{ label: { textTransform: "none" } }}
					{...testId(`project-digest-provenance-${id}`)}
				>
					{t`From ${provenance.source}`}
				</Button>
			</Tooltip>
			<VisuallyHidden id={snippetId}>{provenance.snippet}</VisuallyHidden>
		</>
	);
};
