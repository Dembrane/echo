import { ActionIcon, Box } from "@mantine/core";
import { Resizable } from "re-resizable";
import { Outlet } from "react-router";
import { useSidebar } from "@/components/layout/hooks/useSidebar";
import { Icons } from "@/icons";
import { cn } from "@/lib/utils";
import { ProjectSidebar } from "../project/ProjectSidebar";

// can be rendered inside BaseLayout
export const ProjectLayout = () => {
	const { sidebarWidth, setSidebarWidth, toggleSidebar } = useSidebar();

	const isCollapsed = false;

	return (
		<Box
			// className={`relative ${isMobile ? "flex flex-col" : "flex h-[calc(100vh-60px)]"} `}
			className={cn(
				"relative flex flex-col md:h-project-layout-height md:flex-row",
			)}
		>
			<aside
				className={`block w-full overflow-y-auto border-b md:hidden ${isCollapsed ? "h-12" : "h-1/2"} transition-all duration-300`}
			>
				<ProjectSidebar />
			</aside>

			<Resizable
				className="hidden md:block"
				size={{ width: sidebarWidth }}
				minWidth={325}
				maxWidth="45%"
				maxHeight={"100%"}
				onResizeStop={(_e, _direction, _ref, d) => {
					setSidebarWidth(sidebarWidth + d.width);
				}}
				enable={{
					bottom: false,
					bottomLeft: false,
					bottomRight: false,
					left: false,
					right: !isCollapsed,
					top: false,
					topLeft: false,
					topRight: false,
				}}
				handleStyles={{
					right: {
						cursor: "col-resize",
						right: "-4px",
						width: "8px",
					},
				}}
				handleClasses={{
					right: "hover:bg-blue-500/20 transition-colors",
				}}
			>
				<aside
					className={`h-full overflow-y-auto border-r transition-all duration-300 ${isCollapsed ? "w-0" : ""}`}
				>
					<ProjectSidebar />
				</aside>
			</Resizable>

			{isCollapsed && (
				<ActionIcon
					className="absolute left-2 top-2 z-10"
					variant="subtle"
					onClick={toggleSidebar}
				>
					<Icons.Sidebar />
				</ActionIcon>
			)}

			<section className={"flex-grow overflow-y-auto px-2"} style={{ backgroundColor: "var(--app-background)" }}>
				<Outlet />
			</section>
		</Box>
	);
};
