import { Outlet, useLocation } from "react-router";
import { AppSidebar } from "@/features/sidebar";

// Strip locale + preview prefix to render readable breadcrumbs.
function pathSegments(pathname: string): string[] {
	const segs = pathname.split("/").filter(Boolean);
	if (segs[0] && /^[a-z]{2}(-[A-Z]{2})?$/.test(segs[0])) segs.shift();
	if (segs[0] === "sidebar-preview") segs.shift();
	return segs;
}

const Breadcrumbs = () => {
	const { pathname } = useLocation();
	const segs = pathSegments(pathname);
	if (segs.length < 2) return null;
	return (
		<div
			className="flex items-center gap-1.5 px-4 text-[12px]"
			style={{ color: "rgba(45, 45, 44, 0.55)" }}
		>
			{segs.map((s, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: breadcrumb segments derived from URL path; position-stable, never reordered
				<span key={`${s}-${i}`} className="flex items-center gap-1.5">
					{i > 0 && <span style={{ opacity: 0.4 }}>/</span>}
					<span>{s}</span>
				</span>
			))}
		</div>
	);
};

export const SidebarPreviewLayout = () => {
	return (
		<div
			className="flex h-screen w-screen"
			style={{ backgroundColor: "#efece8" }}
		>
			<AppSidebar />
			<div className="flex flex-1 flex-col p-2">
				<div
					className="flex flex-1 flex-col overflow-hidden rounded-[10px] border"
					style={{
						backgroundColor: "#f6f4f1",
						borderColor: "rgba(45, 45, 44, 0.08)",
					}}
				>
					<div
						className="flex h-8 shrink-0 items-center border-b"
						style={{ borderColor: "rgba(45, 45, 44, 0.06)" }}
					>
						<Breadcrumbs />
					</div>
					<main className="flex-1 overflow-auto p-6">
						<Outlet />
					</main>
				</div>
			</div>
		</div>
	);
};
