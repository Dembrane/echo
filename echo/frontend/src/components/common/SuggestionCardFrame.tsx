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
	/** Hug the content instead of filling the column. For small cards like a
	 * drafted insight, where the default 80% width reads as loose and empty. */
	tight?: boolean;
	testId?: string;
}) => (
	<Box className="flex justify-start">
		<Paper
			className={
				tight
					? "w-full max-w-full rounded-md shadow-none md:w-fit md:max-w-[36rem]"
					: "w-full max-w-full rounded-md shadow-none md:max-w-[80%]"
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
