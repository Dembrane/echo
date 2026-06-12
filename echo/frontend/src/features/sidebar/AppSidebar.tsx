import { ErrorBoundary } from "@/components/error/ErrorBoundary";
import { ViewTransition } from "./animations/ViewTransition";
import { HelpBlock } from "./blocks/HelpBlock";
import { InboxBlock } from "./blocks/InboxBlock";
import { SearchBlock } from "./blocks/SearchBlock";
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
		<SidebarShell
			header={<SidebarHeader />}
			footer={
				<>
					<HelpBlock />
					<div
						className="mt-1 border-t pt-1.5 pb-1"
						style={{ borderColor: "rgba(45, 45, 44, 0.06)" }}
					>
						<UserMenu />
					</div>
				</>
			}
		>
			<div
				className="flex shrink-0 flex-col gap-0.5 border-b p-1.5"
				style={{ borderColor: "rgba(45, 45, 44, 0.06)" }}
			>
				<SearchBlock />
				<InboxBlock />
			</div>
			<ViewTransition>
				<ErrorBoundary fallback={<ViewError />}>{content}</ErrorBoundary>
			</ViewTransition>
		</SidebarShell>
	);
};

const ViewError = () => (
	<div
		className="flex flex-col items-start gap-1 p-3 text-xs"
		style={{ color: "rgba(45, 45, 44, 0.55)" }}
	>
		<div>This view couldn't load.</div>
		<button
			type="button"
			className="underline"
			onClick={() => window.location.reload()}
		>
			Reload
		</button>
	</div>
);
