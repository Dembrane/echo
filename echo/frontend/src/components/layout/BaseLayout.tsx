import type { PropsWithChildren } from "react";
import { Outlet } from "react-router";
import { useAuthenticated } from "@/components/auth/hooks";
import { WeakPasswordModal } from "@/components/auth/WeakPasswordModal";
import { SeatCapBanner } from "@/components/workspace/SeatCapBanner";
import { AppSidebar, useSidebarView } from "@/features/sidebar";
import { AppBreadcrumbs } from "@/features/sidebar/breadcrumbs/AppBreadcrumbs";
import { InboxView } from "@/features/sidebar/views/InboxView";
import { Toaster } from "../common/Toaster";
import { ErrorBoundary } from "../error/ErrorBoundary";
import { TransitionCurtainProvider } from "./TransitionCurtainProvider";

const SidebarFailure = () => (
	<aside
		className="flex h-screen w-[240px] shrink-0 flex-col items-center justify-center border-r p-4 text-center text-[12px]"
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
						{isAuthenticated ? <AppBreadcrumbs /> : null}
						{isAuthenticated ? <WeakPasswordModal /> : null}
						{/* SeatCapBanner self-gates on workspace context, so it only
						    appears on /w/:workspaceId/* routes. Lives here (inside
						    main) instead of WorkspaceLayout so it doesn't stretch
						    across the sidebar column. */}
						<div className="print:hidden">
							<SeatCapBanner />
						</div>
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
