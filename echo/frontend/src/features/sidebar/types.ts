export type SidebarScope = "user" | "org" | "workspace" | "project" | "admin";

export type SidebarViewId =
	| "inbox"
	| "help"
	| "user-home"
	| "user-settings"
	| "org-home"
	| "org-settings"
	| "workspace-home"
	| "workspace-settings"
	| "project-home"
	| "project-settings"
	| "admin-home";

export interface ResolvedSidebarView {
	view: SidebarViewId;
	scope: SidebarScope;
	backTo: string | null;
	params: {
		orgId?: string;
		workspaceId?: string;
		projectId?: string;
		section?: string;
	};
	overlay?: "inbox" | "help";
}
