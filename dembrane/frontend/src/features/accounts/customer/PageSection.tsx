import { Box, Group, Text, Title } from "@mantine/core";
import type { ReactNode } from "react";

/**
 * A section of the customer's account page: a real heading (so a screen reader can jump
 * between them) at the reading size over a rule in the text colour, with how many it
 * holds in muted beside it and an optional action at its right. The rule is the top of
 * the section's first row.
 */
export const PageSection = ({
	title,
	count,
	action,
	children,
	testId,
}: {
	title: ReactNode;
	count?: number;
	action?: ReactNode;
	children: ReactNode;
	testId?: string;
}) => (
	<Box component="section" data-testid={testId}>
		{title || action ? (
			<Group
				justify="space-between"
				align="baseline"
				gap="md"
				wrap="nowrap"
				pb="sm"
				style={{ borderBottom: "var(--app-stroke) solid var(--app-text)" }}
			>
				{title && (
					<Title order={2} size="h5">
						{title}
						{count != null && (
							<Text
								span
								size="xs"
								c="dimmed"
								ml="xs"
								data-testid="section-count"
							>
								{count}
							</Text>
						)}
					</Title>
				)}
				{action}
			</Group>
		) : (
			<Box style={{ borderTop: "var(--app-stroke) solid var(--app-text)" }} />
		)}
		{children}
	</Box>
);

/** One row of a ruled list, with a quiet rule under it. */
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
			borderBottom: "var(--app-stroke) solid var(--app-quiet)",
		}}
	>
		{children}
	</Box>
);

/** A list of rows, ruled between them; the section heading's rule is its top. */
export const Rows = ({ children }: { children: ReactNode }) => (
	<Box
		component="ul"
		p={0}
		m={0}
		style={{
			listStyle: "none",
		}}
	>
		{children}
	</Box>
);

/** The page's sections, 48px apart. */
export const Sections = ({ children }: { children: ReactNode }) => (
	<Box style={{ display: "flex", flexDirection: "column", gap: 48 }}>
		{children}
	</Box>
);
