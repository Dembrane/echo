import useSessionStorageState from "use-session-storage-state";

export const useSidebar = () => {
	const [sidebarWidth, setSidebarWidth] = useSessionStorageState(
		"project-sidebar-width",
		{
			defaultValue: 400,
		},
	);
	const [isCollapsed, setIsCollapsed] = useSessionStorageState(
		"project-sidebar-collapsed",
		{
			defaultValue: false,
		},
	);

	const toggleSidebar = () => {
		setIsCollapsed(!isCollapsed);
		setSidebarWidth(isCollapsed ? 400 : 0);
	};

	return {
		isCollapsed,
		setIsCollapsed,
		setSidebarWidth,
		sidebarWidth,
		toggleSidebar,
	};
};
