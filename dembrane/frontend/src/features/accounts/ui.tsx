import { Box, Group, Text } from "@mantine/core";
import type { ReactNode } from "react";

/** A titled block on the account page and the staff card: title left, its action right. */
export const Section = ({
	title,
	action,
	children,
	id,
	testId,
}: {
	title: ReactNode;
	action?: ReactNode;
	children: ReactNode;
	id?: string;
	testId?: string;
}) => (
	<Box component="section" id={id} data-testid={testId}>
		<Group
			justify="space-between"
			align="center"
			mb="xs"
			gap="xs"
			wrap="nowrap"
		>
			<Text fw={500}>{title}</Text>
			{action}
		</Group>
		{children}
	</Box>
);
