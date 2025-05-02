import React from "react";
import { t } from "@lingui/core/macro";
import { Tooltip, ActionIcon } from "@mantine/core";
import { IconInfoCircle } from "@tabler/icons-react";

interface ReferencesIconButtonProps {
  showCitations: boolean;
  setShowCitations: (value: boolean) => void;
}

export const ReferencesIconButton = ({
  showCitations,
  setShowCitations,
}: {
  showCitations: boolean;
  setShowCitations: (value: boolean) => void;
}) => {
  return (
    <Tooltip
      transitionProps={{ duration: 200 }}
      label={t`Show references`}
      px={5}
    >
      <ActionIcon
        variant={showCitations ? "light" : "subtle"}
        color={showCitations ? "teal" : "gray"}
        onClick={() => setShowCitations(!showCitations)}
        aria-label={t`Show references`}
        size="md"
        radius="xl"
      >
        <IconInfoCircle size={18} />
      </ActionIcon>
    </Tooltip>
  );
};
