import type { PropsWithChildren } from "react";
import { Outlet } from "react-router";
import { useAuthenticated } from "@/components/auth/hooks";
import { AppSidebar, useSidebarView } from "@/features/sidebar";
import { AppBreadcrumbs } from "@/features/sidebar/breadcrumbs/AppBreadcrumbs";
import { InboxView } from "@/features/sidebar/views/InboxView";
import { useSidebarState } from "@/features/sidebar/hooks/useSidebarState";
import { useV2Me } from "@/hooks/useV2Me";
import { ActionIcon } from "@mantine/core";
import { List } from "@phosphor-icons/react";
import { Toaster } from "../common/Toaster";
import { ErrorBoundary } from "../error/ErrorBoundary";
import { TransitionCurtainProvider } from "./TransitionCurtainProvider";

const SidebarFailure = () => (
	<aside
		className="flex h-screen w-[240px] shrink-0 flex-col items-center justify-center border-r p-4 text-center text-xs"
		style={{
			backgroundColor: "#f6f4f1",
			borderColor: "rgba(45, 45, 44, 0.08)",
			color: "rgba(45, 45, 44, 0.55)",
		}}
	>
		<div>Sidebar couldn't load.</div>
		<button
			type="button"
			className="mt-2 underline"
			onClick={() => window.location.reload()}
		>
			Reload
		</button>
	</aside>
);

export const BaseLayout = ({ children }: PropsWithChildren) => {
	const { isAuthenticated } = useAuthenticated();
	const { overlay } = useSidebarView();
	const { collapsed, setCollapsed } = useSidebarState();
	const { data: me } = useV2Me();
	const isCollapsible = !!me?.settings?.enable_collapsible_sidebar;

	return (
		<TransitionCurtainProvider>
			<div className="flex h-screen w-screen overflow-hidden">
				{isAuthenticated ? (
					<ErrorBoundary fallback={<SidebarFailure />}>
						<AppSidebar />
					</ErrorBoundary>
				) : null}
				<ErrorBoundary>
					<main className="relative flex flex-1 flex-col overflow-hidden">
						{isAuthenticated && isCollapsible && collapsed && (
							<div className="absolute left-3 top-[12.5px] z-40">
								<ActionIcon
									variant="subtle"
									color="gray"
									onClick={() => setCollapsed(false)}
									aria-label="Expand sidebar"
									size={32}
								>
									<List size={20} />
								</ActionIcon>
							</div>
						)}
						{isAuthenticated ? <AppBreadcrumbs /> : null}
						<div className="flex-1 overflow-auto">
							<Outlet />
							{children}
						</div>
						{overlay === "inbox" && (
							<div
								role="dialog"
								aria-modal="true"
								aria-label="Inbox"
								tabIndex={-1}
								className="absolute inset-0 z-50 flex flex-col overflow-hidden"
								style={{ backgroundColor: "var(--app-background)" }}
							>
								<InboxView />
							</div>
						)}
					</main>
				</ErrorBoundary>
				<Toaster />
			</div>
		</TransitionCurtainProvider>
	);
};
