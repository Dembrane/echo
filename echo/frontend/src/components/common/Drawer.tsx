import {
	Drawer as MantineDrawer,
	type DrawerProps as MantineDrawerProps,
} from "@mantine/core";
import type { ReactNode } from "react";

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
