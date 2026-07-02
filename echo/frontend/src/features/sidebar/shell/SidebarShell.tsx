import type { ReactNode } from "react";
import { useSidebarState } from "../hooks/useSidebarState";
import { ResizeHandle } from "./ResizeHandle";

interface SidebarShellProps {
	children: ReactNode;
	header?: ReactNode;
	footer?: ReactNode;
}

// Flush-left full-height rail. Parchment background, no shadow — the
// main content panel is the floating piece, not the sidebar.
export const SidebarShell = ({
	children,
	header,
	footer,
}: SidebarShellProps) => {
	const { width } = useSidebarState();

		return (
			<aside
				className="relative flex h-screen flex-col border-r print:hidden"
				style={{
					backgroundColor: "#f6f4f1",
					borderColor: "rgba(45, 45, 44, 0.08)",
					width,
					borderRight: width === 0 ? "none" : undefined,
					overflow: width === 0 ? "hidden" : undefined,
				}}
			>
			{header ?? null}
			<div className="flex flex-1 flex-col overflow-hidden">{children}</div>
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
	);
};
