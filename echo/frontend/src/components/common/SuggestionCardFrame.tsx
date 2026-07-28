import { Box, Paper } from "@mantine/core";
import type { ReactNode } from "react";

export const SuggestionCardFrame = ({
	children,
	compact = false,
	testId,
}: {
	children: ReactNode;
	compact?: boolean;
	testId?: string;
}) => (
	<Box className="flex justify-start">
		<Paper
			className="w-full max-w-full rounded-md shadow-none md:max-w-[80%]"
			px="md"
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
