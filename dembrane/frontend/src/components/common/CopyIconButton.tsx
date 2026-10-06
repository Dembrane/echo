import { t } from "@lingui/core/macro";
import { ActionIcon, type ActionIconProps, Tooltip } from "@mantine/core";
import { CheckIcon, CopyIcon } from "@phosphor-icons/react";

export const CopyIconButton = ({
	onCopy,
	copied,
	copyTooltip = t`Copy`,
	size = 20,
	...props
}: {
	copyTooltip?: string;
	onCopy: () => void;
	copied: boolean;
} & ActionIconProps) => {
	return (
		<Tooltip label={copied ? t`Copied` : copyTooltip} position="bottom">
			<ActionIcon
				p="xs"
				color={copied ? "teal" : "gray"}
				variant="subtle"
				onClick={onCopy}
				{...props}
			>
				{copied ? <CheckIcon size={size} /> : <CopyIcon size={size} />}
			</ActionIcon>
		</Tooltip>
	);
};
