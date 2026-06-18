import { useLocation } from "react-router";

export const SidebarPreviewRoute = () => {
	const { pathname } = useLocation();
	return (
		<div className="flex flex-col gap-4">
			<h1
				className="text-lg leading-tight"
				style={{ color: "#2d2d2c" }}
			>
				Sidebar preview
			</h1>
			<p
				className="text-sm"
				style={{ color: "rgba(45, 45, 44, 0.7)", maxWidth: 560 }}
			>
				Click around the sidebar to test view transitions, the back button,
				and active-state animations. Current path:
			</p>
			<code
				className="rounded-md px-2 py-1 text-xs"
				style={{
					backgroundColor: "rgba(65, 105, 225, 0.08)",
					color: "#4169e1",
					width: "fit-content",
				}}
			>
				{pathname}
			</code>
		</div>
	);
};
