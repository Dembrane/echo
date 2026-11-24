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
			<Text>{title}</Text>
			{action}
		</Group>
		{children}
	</Box>
);

/**
 * Keeps an email address or a short label on one line inside a sentence: the line breaks
 * around it, never inside it (an address would otherwise split at its hyphen on a phone).
 */
export const Whole = ({ children }: { children: string }) => (
	<span className="whitespace-nowrap">{children}</span>
);
