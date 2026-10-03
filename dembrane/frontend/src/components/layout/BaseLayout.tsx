import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Button, Text } from "@mantine/core";
import type { PropsWithChildren } from "react";
import { Outlet, useSearchParams } from "react-router";
import { roles } from "@/colors";
import { useAuthenticated } from "@/components/auth/hooks";
import { BeautifulLoading } from "@/components/common/BeautifulLoading";
import { AppSidebar, useSidebarView } from "@/features/sidebar";
import { AppBreadcrumbs } from "@/features/sidebar/breadcrumbs/AppBreadcrumbs";
import { InboxView } from "@/features/sidebar/views/InboxView";
import { Toaster } from "../common/Toaster";
import { ErrorBoundary } from "../error/ErrorBoundary";
import { TransitionCurtainProvider } from "./TransitionCurtainProvider";

const SidebarFailure = () => (
	<aside
		className="flex h-dvh w-[240px] shrink-0 flex-col items-start gap-2 border-r p-4"
		style={{
			backgroundColor: roles.bg,
			borderColor: "var(--app-rule-color)",
		}}
	>
		<Text size="sm" c="dimmed" className="app-muted">
			<Trans>Sidebar couldn't load.</Trans>
		</Text>
		<Button
			variant="subtle"
			color="gray"
			size="xs"
			onClick={() => window.location.reload()}
		>
			<Trans>Reload page</Trans>
		</Button>
	</aside>
);

export const BaseLayout = ({ children }: PropsWithChildren) => {
	const { isAuthenticated } = useAuthenticated();
	const { overlay } = useSidebarView();
	// `?loading` holds the page in its loading state, to look at the loader.
	const [searchParams] = useSearchParams();
	const holdLoading = searchParams.has("loading");

	return (
		<TransitionCurtainProvider>
			<div className="flex h-dvh w-screen overflow-hidden">
				{isAuthenticated ? (
					<ErrorBoundary fallback={<SidebarFailure />}>
						<AppSidebar />
					</ErrorBoundary>
				) : null}
				<ErrorBoundary>
					<main className="relative flex flex-1 flex-col overflow-hidden">
						{isAuthenticated ? <AppBreadcrumbs /> : null}
						<div className="flex-1 overflow-auto" data-app-scroll-root>
							{holdLoading ? (
								<BeautifulLoading />
							) : (
								<>
									<Outlet />
									{children}
								</>
							)}
						</div>
						{overlay === "inbox" && (
							<div
								role="dialog"
								aria-modal="true"
								aria-label={t`Inbox`}
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
