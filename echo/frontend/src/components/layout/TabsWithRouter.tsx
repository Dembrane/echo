import { Box, LoadingOverlay, Stack, Tabs } from "@mantine/core";
import { Suspense, useCallback, useEffect, useState } from "react";
import { Outlet, useLocation, useParams } from "react-router";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";

const TabLoadingFallback = () => (
	<Box pos="relative" h="100%">
		<LoadingOverlay
			visible={true}
			zIndex={1000}
			overlayProps={{
				backgroundOpacity: 0.1,
				blur: 2,
				radius: "sm",
			}}
			loaderProps={{
				size: "md",
				type: "dots",
			}}
		/>
	</Box>
);

export const TabsWithRouter = ({
	basePath,
	tabs,
	loading = false,
}: {
	basePath: string;
	tabs: { value: string; label: string }[];
	loading?: boolean;
}) => {
	const navigate = useI18nNavigate();
	const location = useLocation();
	const params = useParams();

	const determineInitialTab = useCallback(() => {
		return (
			tabs.find((tab) => location.pathname.includes(`/${tab.value}`))?.value ||
			tabs[0].value
		);
	}, [tabs, location.pathname]);

	const [activeTab, setActiveTab] = useState(determineInitialTab());

	useEffect(() => {
		const newTab = determineInitialTab();
		if (newTab !== activeTab) {
			setActiveTab(newTab);
		}
	}, [determineInitialTab, activeTab]);

	const handleTabChange = (value: string | null) => {
		const path = basePath.replace(/:(\w+)/g, (_, param) => params[param] || "");
		navigate(`${path}/${value}`);
		setActiveTab(value ?? "");
	};

	return (
		<Stack className="relative">
			<Tabs value={activeTab} onChange={handleTabChange} variant="default">
				<Tabs.List grow justify="space-between">
					{tabs.map((tab) => (
						<Tabs.Tab disabled={loading} key={tab.value} value={tab.value}>
							{tab.label}
						</Tabs.Tab>
					))}
				</Tabs.List>
			</Tabs>
			<Suspense fallback={<TabLoadingFallback />}>
				<Outlet />
			</Suspense>
		</Stack>
	);
};
