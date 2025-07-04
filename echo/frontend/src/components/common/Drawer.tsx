import {
  Drawer as MantineDrawer,
  DrawerProps as MantineDrawerProps,
  Text,
} from "@mantine/core";
import { ReactNode } from "react";

type DrawerProps = Partial<MantineDrawerProps> & {
  opened: boolean;
  onClose: () => void;
  title?: ReactNode;
  children?: ReactNode;
};

export const Drawer = ({
  opened,
  onClose,
  title,
  children,
  position = "right",
  size = "md",
  ...rest
}: DrawerProps) => {
  return (
    <MantineDrawer
      opened={opened}
      onClose={onClose}
      position={position}
      size={size}
      title={title}
      {...rest}
    >
      {children}
    </MantineDrawer>
  );
};
