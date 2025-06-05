import { ActionIcon, Box } from "@mantine/core";
import { Outlet } from "react-router-dom";
import { ProjectSidebar } from "../project/ProjectSidebar";
import { Resizable } from "re-resizable";
import { useSidebar } from "@/hooks/useSidebar";
import { Icons } from "@/icons";
import { useMediaQuery } from "@mantine/hooks";
import { cn } from "@/lib/utils";

// can be rendered inside BaseLayout
export const ProjectLayout = () => {
  const { sidebarWidth, setSidebarWidth, toggleSidebar } = useSidebar();

  const isCollapsed = false;

  return (
    <Box
      // className={`relative ${isMobile ? "flex flex-col" : "flex h-[calc(100vh-60px)]"} `}
      className={cn(
        "relative flex flex-col md:h-[calc(100vh-60px)] md:flex-row",
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
          right: !isCollapsed,
          bottom: false,
          bottomLeft: false,
          bottomRight: false,
          top: false,
          topLeft: false,
          topRight: false,
          left: false,
        }}
        handleStyles={{
          right: {
            width: "8px",
            right: "-4px",
            cursor: "col-resize",
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

      <section className={`flex-grow overflow-y-auto px-2`}>
        <Outlet />
      </section>
    </Box>
  );
};
