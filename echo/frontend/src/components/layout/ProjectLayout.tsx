import { Outlet } from "react-router";

// Project pages no longer host their own secondary sidebar — the
// unified AppSidebar (mounted in BaseLayout) handles all navigation.
// This layout used to wrap routes with <ProjectSidebar />; that's been
// retired.
export const ProjectLayout = () => {
	return (
		<section
			className="h-full overflow-y-auto px-2"
			style={{ backgroundColor: "var(--app-background)" }}
		>
			<Outlet />
		</section>
	);
};
