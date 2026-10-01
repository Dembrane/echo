import { Trans } from "@lingui/react/macro";
import { Button, Tooltip } from "@mantine/core";
import { IconMicrophone } from "@tabler/icons-react";
import { testId } from "@/lib/testUtils";

/** Starts a voice note. Shaped like the composer's other footer control so the
 * bottom bar keeps one look, and labelled in full for screen readers even
 * where the label is too narrow to show. */
export const VoiceInputButton = ({
	ariaLabel,
	disabled,
	locked,
	onClick,
	testId: id,
	tooltip,
}: {
	ariaLabel: string;
	disabled?: boolean;
	locked?: boolean;
	onClick: () => void;
	testId?: string;
	tooltip?: string;
}) => {
	const button = (
		<Button
			aria-disabled={locked || undefined}
			aria-label={ariaLabel}
			className="tap-target"
			data-disabled={locked || undefined}
			disabled={!locked && disabled}
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

	if (!tooltip) return button;
	return (
		<Tooltip label={tooltip} multiline openDelay={200} w={240} withArrow>
			{button}
		</Tooltip>
	);
};
