import { t } from "@lingui/core/macro";
import { ActionIcon, Tooltip } from "@mantine/core";
import { IconArrowDown } from "@tabler/icons-react";

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
        variant="default"
        radius="xl"
        size={32}
        aria-label={t`Scroll to bottom`}
        className="rounded-full"
        onClick={scrollToBottom}
      >
        <IconArrowDown style={{ width: "70%", height: "70%" }} stroke={2} />
      </ActionIcon>
    </Tooltip>
  );
};
