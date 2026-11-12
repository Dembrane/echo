import "@mantine/core/styles.css";
import "@/index.css";

import { MantineProvider } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import { IconContext } from "@phosphor-icons/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { Toaster } from "@/components/common/Toaster";
import { I18nProvider } from "@/components/layout/I18nProvider";
import { ProjectAdvancedRoute } from "@/components/project/advanced/ProjectAdvancedRoute";
import { ProjectBriefRoute } from "@/components/project/brief/ProjectBriefRoute";
import { PortalEditorRoute } from "@/components/project/portal-editor/PortalEditorRoute";
import { ProjectHomeView } from "@/features/sidebar/views/project/ProjectHomeView";
import { ProjectPortalView } from "@/features/sidebar/views/project/ProjectPortalView";
import { ProjectSettingsView } from "@/features/sidebar/views/project/ProjectSettingsView";
import { AppPreferencesProvider } from "@/hooks/useAppPreferences";
import {
	WorkspaceContext,
	type WorkspaceContextValue,
} from "@/hooks/useWorkspace";
import { cssVariablesResolver, theme } from "@/theme";

// ECHO-1060: Brief, the portal editor's six pages with their live preview, and Manage's
// Advanced tab, outside the signed-in shell, for screenshots and the rendered grammar audit.
// ?path= picks the page, ?role= the workspace role; the spec answers the API. The preview
// frame loads the participant dev server (pnpm participant:dev, port 5174).
const params = new URLSearchParams(window.location.search);
const role = params.get("role") ?? "owner";
const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
queryClient.setQueryData(["v2", "me"], { is_staff: false });
const clientManaged = {
	legal_basis: "client-managed",
	privacy_policy_url: null,
	source: "system",
};
queryClient.setQueryData(["projects", "p1", "legal"], {
	_legal: {
		effective: clientManaged,
		inherited: clientManaged,
		organiser_name: null,
	},
	legal_basis: null,
	privacy_policy_url: null,
});

const workspace = {
	id: "w1",
	is_default: true,
	logo_url: null,
	member_count: 1,
	name: "Sam's workspace",
	org_id: "o1",
	org_logo_url: null,
	org_name: "Sam's organisation",
	project_count: 1,
	role,
	tier: "changemaker",
};
const context: WorkspaceContextValue = {
	clearWorkspace: () => {},
	isError: false,
	isLoading: false,
	refetch: () => {},
	setWorkspace: () => {},
	workspace,
	workspaceId: "w1",
	workspaceName: workspace.name,
	workspaces: [workspace],
} as unknown as WorkspaceContextValue;

const Shell = ({ nav }: { nav: "home" | "portal" | "manage" }) => (
	<I18nProvider>
		<div style={{ display: "flex", minHeight: "100vh" }}>
			<aside
				className="hidden md:block"
				style={{
					borderRight: "var(--app-stroke) solid var(--app-rule-color)",
					flexShrink: 0,
					width: 240,
				}}
			>
				{nav === "portal" ? (
					<ProjectPortalView />
				) : nav === "manage" ? (
					<ProjectSettingsView />
				) : (
					<ProjectHomeView />
				)}
			</aside>
			<main style={{ flex: 1, minWidth: 0 }}>
				<Outlet />
			</main>
		</div>
	</I18nProvider>
);

const base = "/:language/w/:workspaceId/projects/:projectId";
const router = createMemoryRouter(
	[
		{
			children: [{ element: <ProjectBriefRoute />, path: `${base}/brief` }],
			element: <Shell nav="home" />,
		},
		{
			children: [
				{
					element: <PortalEditorRoute />,
					path: `${base}/portal/:section/:option?`,
				},
			],
			element: <Shell nav="portal" />,
		},
		{
			children: [
				{ element: <ProjectAdvancedRoute />, path: `${base}/advanced` },
			],
			element: <Shell nav="manage" />,
		},
		{ element: <div data-testid="harness-landed" />, path: "*" },
	],
	{
		initialEntries: [
			params.get("path") ?? "/en-US/w/w1/projects/p1/portal/welcome",
		],
	},
);

createRoot(document.getElementById("root") as HTMLElement).render(
	<QueryClientProvider client={queryClient}>
		<MantineProvider theme={theme} cssVariablesResolver={cssVariablesResolver}>
			<IconContext.Provider value={{ weight: "light" }}>
				<AppPreferencesProvider>
					<WorkspaceContext.Provider value={context}>
						<ModalsProvider>
							<RouterProvider router={router} />
							<Toaster />
						</ModalsProvider>
					</WorkspaceContext.Provider>
				</AppPreferencesProvider>
			</IconContext.Provider>
		</MantineProvider>
	</QueryClientProvider>,
);
