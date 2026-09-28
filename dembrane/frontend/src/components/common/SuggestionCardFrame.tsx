import { Box, Paper } from "@mantine/core";
import type { ReactNode } from "react";

export const SuggestionCardFrame = ({
	children,
	compact = false,
	tight = false,
	testId,
}: {
	children: ReactNode;
	compact?: boolean;
	/** A narrower ceiling (36rem instead of 80%) and tighter padding, for small
	 * cards like a drafted insight that would read as loose at full width. */
	tight?: boolean;
	testId?: string;
}) => (
	<Box className="flex justify-start">
		<Paper
			// No w-full: blocks in the chat column size to their content and the
			// max-w is only a ceiling, so a short card ends where its text ends
			// rather than trailing an empty border across the column.
			className={
				tight
					? "max-w-full rounded-md shadow-none md:max-w-[36rem]"
					: "max-w-full rounded-md shadow-none md:max-w-[80%]"
			}
			px={tight ? "sm" : "md"}
			py={compact ? "xs" : "md"}
			style={{
				borderColor: "var(--mantine-color-primary-light)",
			}}
			{...(testId ? { "data-testid": testId } : {})}
		>
			{children}
		</Paper>
	</Box>
);
