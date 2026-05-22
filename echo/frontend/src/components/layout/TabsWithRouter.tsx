import { Box, LoadingOverlay, Stack } from "@mantine/core";
import { Suspense } from "react";
import { Outlet } from "react-router";

const TabLoadingFallback = () => (
	<Box pos="relative" h="100%">
		<LoadingOverlay
			visible={true}
			zIndex={1000}
			overlayProps={{ backgroundOpacity: 0.1, blur: 2, radius: "sm" }}
			loaderProps={{ size: "md", type: "dots" }}
		/>
	</Box>
);

// Tab strip retired — section navigation lives in the main AppSidebar.
// Now a thin Outlet wrapper; props kept for callsite compat but ignored.
export const TabsWithRouter = (
	_props: {
		basePath?: string;
		tabs?: { value: string; label: string }[];
		loading?: boolean;
	} & Record<string, unknown>,
) => {
	return (
		<Stack className="relative">
			<Suspense fallback={<TabLoadingFallback />}>
				<Outlet />
			</Suspense>
		</Stack>
	);
};
