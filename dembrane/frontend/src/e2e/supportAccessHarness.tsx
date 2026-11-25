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
import SupportAccessRequestPrompt from "@/components/workspace/SupportAccessRequestPrompt";
import { SupportAccessSection } from "@/components/workspace/SupportAccessSection";
import { InboxView } from "@/features/sidebar/views/InboxView";
import { AppPreferencesProvider } from "@/hooks/useAppPreferences";
import {
	WorkspaceContext,
	type WorkspaceContextValue,
} from "@/hooks/useWorkspace";
import { WorkspaceSelectorRoute } from "@/routes/workspaces/WorkspaceSelectorRoute";
import { cssVariablesResolver, theme } from "@/theme";

// The consent dialog for a support access request over Home (/o) and over the inbox, and
// the approve confirmation it sits beside in workspace settings, outside the signed-in
// shell, for screenshots. ?path= picks the page, ?workspace= names the workspace; the spec
// answers the API.
const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
const search = new URLSearchParams(window.location.search);
queryClient.setQueryData(["v2", "me"], {
	display_name: "Sam Jansen",
	is_staff: false,
	orgs: [{ id: "o1", name: "Gemeente Lindenwijk", role: "owner" }],
});

const workspace = {
	id: "w1",
	is_default: true,
	logo_url: null,
	member_count: 4,
	name: search.get("workspace") ?? "Neighbourhood panels",
	org_id: "o1",
	org_logo_url: null,
	org_name: "Gemeente Lindenwijk",
	project_count: 3,
	role: "admin",
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
};

// As BaseLayout mounts it: beside whatever page is open.
const Shell = () => (
	<>
		<Outlet />
		<SupportAccessRequestPrompt />
	</>
);

const path = search.get("path") ?? "/en-US/o";
const router = createMemoryRouter(
	[
		{
			children: [
				{ element: <WorkspaceSelectorRoute />, path: "/:language/o" },
				{ element: <InboxView />, path: "/:language/inbox" },
				{
					element: (
						<div style={{ padding: 24 }}>
							<SupportAccessSection workspaceId="w1" canEdit />
						</div>
					),
					path: "/:language/w/:workspaceId/settings/general",
				},
				{ element: <div data-testid="harness-landed" />, path: "*" },
			],
			element: <Shell />,
		},
	],
	{ initialEntries: [path] },
);

createRoot(document.getElementById("root") as HTMLElement).render(
	<QueryClientProvider client={queryClient}>
		<MantineProvider theme={theme} cssVariablesResolver={cssVariablesResolver}>
			<IconContext.Provider value={{ weight: "light" }}>
				<AppPreferencesProvider>
					<WorkspaceContext.Provider value={context}>
						<I18nProvider>
							<ModalsProvider>
								<main style={{ margin: "0 auto", maxWidth: 1100 }}>
									<RouterProvider router={router} />
								</main>
								<Toaster />
							</ModalsProvider>
						</I18nProvider>
					</WorkspaceContext.Provider>
				</AppPreferencesProvider>
			</IconContext.Provider>
		</MantineProvider>
	</QueryClientProvider>,
);
