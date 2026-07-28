import { t } from "@lingui/core/macro";
import { ArrowDown } from "@phosphor-icons/react";
import { ActionIcon, Tooltip } from "@mantine/core";

interface ScrollToBottomButtonProps {
	elementRef: React.RefObject<HTMLDivElement | null>;
	isVisible: boolean;
}

export const ScrollToBottomButton = ({
	elementRef,
	isVisible,
}: ScrollToBottomButtonProps) => {
	const scrollToBottom = () => {
		elementRef.current?.scrollIntoView({ behavior: "smooth" });
	};

	if (isVisible) return null; // Hide when visible

	return (
		<Tooltip label={t`Scroll to bottom`}>
			<ActionIcon
				variant="outline"
				radius="xl"
				size={32}
				aria-label={t`Scroll to bottom`}
				className="rounded-full shadow-sm"
				style={{ backgroundColor: "var(--app-background)" }}
				onClick={scrollToBottom}
			>
				<ArrowDown size="70%" weight="bold" />
			</ActionIcon>
		</Tooltip>
	);
};
