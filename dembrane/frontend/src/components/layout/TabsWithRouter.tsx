import { Stack } from "@mantine/core";
import { Suspense } from "react";
import { Outlet } from "react-router";
import { BeautifulLoading } from "@/components/common/BeautifulLoading";

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
			<Suspense fallback={<BeautifulLoading />}>
				<Outlet />
			</Suspense>
		</Stack>
	);
};
