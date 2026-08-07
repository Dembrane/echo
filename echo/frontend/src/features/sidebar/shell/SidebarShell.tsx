import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useIsMobile } from "../hooks/useIsMobile";
import { useSidebarState } from "../hooks/useSidebarState";
import { MobileSidebarAutoClose } from "./MobileSidebarAutoClose";
import { ResizeHandle } from "./ResizeHandle";

interface SidebarShellProps {
	children: ReactNode;
	header?: ReactNode;
	footer?: ReactNode;
}

// Flush-left full-height rail. Parchment background, no shadow — the
// main content panel is the floating piece, not the sidebar.
// Below the md breakpoint the open rail renders as a fixed drawer with backdrop.
export const SidebarShell = ({
	children,
	header,
	footer,
}: SidebarShellProps) => {
	const { width, setCollapsed } = useSidebarState();
	const isMobile = useIsMobile();
	const mobileOpen = isMobile && width > 0;

	return (
		<>
			{mobileOpen ? (
				<div
					data-testid="sidebar-mobile-backdrop"
					aria-hidden="true"
					className="fixed inset-0 z-40 touch-none bg-black/40"
					onClick={() => setCollapsed(true)}
				/>
			) : null}
			{/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-modal is valid for role="dialog", biome incorrectly flags conditional roles */}
			<aside
				role={mobileOpen ? "dialog" : undefined}
				aria-modal={mobileOpen ? "true" : undefined}
				aria-label={mobileOpen ? "Navigation" : undefined}
				className={cn(
					"flex h-screen flex-col border-r print:hidden",
					mobileOpen
						? "fixed inset-y-0 left-0 z-50 max-w-[85vw] shadow-xl"
						: "relative",
				)}
				style={{
					backgroundColor: "#f6f4f1",
					borderColor: "rgba(45, 45, 44, 0.08)",
					borderRight: width === 0 ? "none" : undefined,
					overflow: width === 0 ? "hidden" : undefined,
					width,
				}}
			>
				{header ?? null}
				<div className="flex-1 overflow-x-hidden overflow-y-auto">
					<div className="flex min-h-full flex-col">{children}</div>
				</div>
				{footer ? (
					<div
						className="flex flex-col gap-0.5 border-t p-1.5"
						style={{ borderColor: "rgba(45, 45, 44, 0.06)" }}
					>
						{footer}
					</div>
				) : null}
				<ResizeHandle />
			</aside>
			<MobileSidebarAutoClose />
		</>
	);
};
