import { Box, Group, Text } from "@mantine/core";
import type { ReactNode } from "react";

/**
 * A titled block on the account page and the staff card: title left, its action right.
 * `info` is an InfoTip beside the title, for what would otherwise sit on the page.
 */
export const Section = ({
	title,
	info,
	action,
	children,
	id,
	testId,
}: {
	title: ReactNode;
	info?: ReactNode;
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
			{info ? (
				<Group gap={4} wrap="nowrap">
					<Text>{title}</Text>
					{info}
				</Group>
			) : (
				<Text>{title}</Text>
			)}
			{action}
		</Group>
		{children}
	</Box>
);

/**
 * Keeps an email address or a short label in one piece inside a sentence: the line breaks
 * around it while it fits on a line, and inside it only when it is longer than the line
 * (an address would otherwise split at its hyphen on a phone, or run off it when long).
 */
export const Whole = ({ children }: { children: string }) => (
	<span className="inline-block max-w-full [overflow-wrap:anywhere]">
		{children}
	</span>
);
