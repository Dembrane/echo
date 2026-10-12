import { Box, Group, Title } from "@mantine/core";
import type { ReactNode } from "react";

/**
 * A section of the customer's account page: a real heading (so a screen reader can jump
 * between them) one step up the type ladder, with an optional action at its right.
 */
export const PageSection = ({
	title,
	action,
	children,
	testId,
}: {
	title: ReactNode;
	action?: ReactNode;
	children: ReactNode;
	testId?: string;
}) => (
	<Box component="section" data-testid={testId}>
		<Group
			justify="space-between"
			align="baseline"
			mb="sm"
			gap="xs"
			wrap="nowrap"
		>
			<Title order={2} size="h3">
				{title}
			</Title>
			{action}
		</Group>
		{children}
	</Box>
);

/** One row of a ruled list: a hairline above it, and one below the last. */
export const Row = ({
	children,
	testId,
	...data
}: {
	children: ReactNode;
	testId?: string;
} & Record<`data-${string}`, string | undefined>) => (
	<Box
		component="li"
		py="sm"
		data-testid={testId}
		{...data}
		style={{
			borderTop: "var(--app-stroke) solid var(--app-quiet)",
		}}
	>
		{children}
	</Box>
);

/** Closes a list of rows with the rule below the last one. */
export const Rows = ({ children }: { children: ReactNode }) => (
	<Box
		component="ul"
		p={0}
		m={0}
		style={{
			borderBottom: "var(--app-stroke) solid var(--app-quiet)",
			listStyle: "none",
		}}
	>
		{children}
	</Box>
);
