import { t } from "@lingui/core/macro";
import { ActionIcon, Tooltip } from "@mantine/core";
import { ArrowDown } from "@phosphor-icons/react";

interface ScrollToBottomButtonProps {
	onClick: () => void;
	/** True means show the button. Note this is the opposite of the old
	 * `isVisible` prop, which described the scroll sentinel. */
	visible: boolean;
}

export const ScrollToBottomButton = ({
	onClick,
	visible,
}: ScrollToBottomButtonProps) => {
	if (!visible) return null;

	return (
		<Tooltip label={t`Scroll to bottom`}>
			<ActionIcon
				variant="outline"
				radius="xl"
				size={32}
				aria-label={t`Scroll to bottom`}
				className="rounded-full shadow-sm"
				style={{ backgroundColor: "var(--app-background)" }}
				onClick={onClick}
			>
				<ArrowDown size="70%" weight="bold" />
			</ActionIcon>
		</Tooltip>
	);
};
