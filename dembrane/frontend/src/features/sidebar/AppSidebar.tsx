import { Trans } from "@lingui/react/macro";
import { Button, Stack, Text } from "@mantine/core";
import { ErrorBoundary } from "@/components/error/ErrorBoundary";
import { ViewTransition } from "./animations/ViewTransition";
import { HelpBlock } from "./blocks/HelpBlock";
import { InboxBlock } from "./blocks/InboxBlock";
import { SearchBlock } from "./blocks/SearchBlock";
import { HelpModalsProvider } from "./hooks/useHelpModals";
import { useRecordRecents } from "./hooks/useRecordRecents";
import { useSidebarView } from "./hooks/useSidebarView";
import { SidebarHeader } from "./shell/SidebarHeader";
import { SidebarShell } from "./shell/SidebarShell";
import { UserMenu } from "./shell/UserMenu";
import { useSidebarWhitelabelLogo } from "./shell/useSidebarWhitelabelLogo";
import { AdminHomeView } from "./views/admin/AdminHomeView";
import { HelpView } from "./views/HelpView";
import { OrgHomeView } from "./views/org/OrgHomeView";
import { OrgSettingsView } from "./views/org/OrgSettingsView";
import { ProjectHomeView } from "./views/project/ProjectHomeView";
import { ProjectSettingsView } from "./views/project/ProjectSettingsView";
import { UserHomeView } from "./views/user/UserHomeView";
import { UserSettingsView } from "./views/user/UserSettingsView";
import { WorkspaceHomeView } from "./views/workspace/WorkspaceHomeView";
import { WorkspaceSettingsView } from "./views/workspace/WorkspaceSettingsView";

export const AppSidebar = () => {
	useSidebarWhitelabelLogo();
	useRecordRecents();
	const { view } = useSidebarView();

	const content = (() => {
		switch (view) {
			case "help":
				return <HelpView />;
			case "user-home":
				return <UserHomeView />;
			case "user-settings":
				return <UserSettingsView />;
			case "org-home":
				return <OrgHomeView />;
			case "org-settings":
				return <OrgSettingsView />;
			case "workspace-home":
				return <WorkspaceHomeView />;
			case "workspace-settings":
				return <WorkspaceSettingsView />;
			case "project-home":
				return <ProjectHomeView />;
			case "project-settings":
				return <ProjectSettingsView />;
			case "admin-home":
				return <AdminHomeView />;
		}
	})();

	return (
		<HelpModalsProvider>
			<SidebarShell
				header={
					<>
						<SidebarHeader />
						<div
							className="flex shrink-0 flex-col gap-0.5 border-b p-1.5"
							style={{ borderColor: "var(--app-rule-color)" }}
						>
							<SearchBlock />
							<InboxBlock />
						</div>
					</>
				}
				footer={
					<div className="pb-1">
						<UserMenu />
					</div>
				}
			>
				<ViewTransition>
					<ErrorBoundary fallback={<ViewError />}>{content}</ErrorBoundary>
				</ViewTransition>
				<div
					className="flex shrink-0 flex-col gap-0.5 border-t p-1.5"
					style={{ borderColor: "var(--app-rule-color)" }}
				>
					<HelpBlock />
				</div>
			</SidebarShell>
		</HelpModalsProvider>
	);
};

const ViewError = () => (
	<Stack align="flex-start" gap="xs" p="sm">
		<Text size="sm" c="dimmed" className="app-muted">
			<Trans>This view couldn't load.</Trans>
		</Text>
		<Button
			variant="subtle"
			color="gray"
			size="xs"
			onClick={() => window.location.reload()}
		>
			<Trans>Reload page</Trans>
		</Button>
	</Stack>
);
