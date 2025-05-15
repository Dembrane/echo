import { Tooltip } from "@mantine/core";
import { IconInfoCircle } from "@tabler/icons-react";
import { ReactNode } from "react";

export const InformationTooltip = ({
  label,
  size = 16,
  children,
}: {
  label: ReactNode;
  size?: number;
  children?: ReactNode;
}) => {
  return (
    <Tooltip label={label}>
      {children ?? <IconInfoCircle size={size} />}
    </Tooltip>
  );
};
