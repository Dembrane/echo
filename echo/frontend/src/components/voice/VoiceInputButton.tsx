import { Trans } from "@lingui/react/macro";
import { Button } from "@mantine/core";
import { IconMicrophone } from "@tabler/icons-react";
import { testId } from "@/lib/testUtils";

/** Starts a voice note. Shaped like the composer's other footer control so the
 * bottom bar keeps one look, and labelled in full for screen readers even
 * where the label is too narrow to show. */
export const VoiceInputButton = ({
	ariaLabel,
	disabled,
	onClick,
	testId: id,
}: {
	ariaLabel: string;
	disabled?: boolean;
	onClick: () => void;
	testId?: string;
}) => (
	<Button
		aria-label={ariaLabel}
		className="tap-target"
		disabled={disabled}
		onClick={onClick}
		size="compact-sm"
		type="button"
		variant="subtle"
		{...(id ? testId(id) : {})}
	>
		<IconMicrophone size={18} />
		<span className="ms-1.5 hidden md:inline">
			<Trans>Voice</Trans>
		</span>
	</Button>
);
