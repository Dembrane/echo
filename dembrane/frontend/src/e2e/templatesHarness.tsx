import "@mantine/core/styles.css";
import "@/index.css";

import { MantineProvider } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import { IconContext } from "@phosphor-icons/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { Toaster } from "@/components/common/Toaster";
import { I18nProvider } from "@/components/layout/I18nProvider";
import { TEMPLATE_SUMMARIES } from "@/components/project/templates/projectTemplates.fixture";
import { AppPreferencesProvider } from "@/hooks/useAppPreferences";
import {
	WorkspaceContext,
	type WorkspaceContextValue,
} from "@/hooks/useWorkspace";
import { CreateProjectRoute } from "@/routes/project/CreateProjectRoute";
import { ProjectsHomeRoute } from "@/routes/project/ProjectsHome";
import { cssVariablesResolver, theme } from "@/theme";

// The create flow and workspace home's first-project state (ECHO-1042) outside the
// signed-in shell, for screenshots. ?path= picks the page; the spec answers the API.
const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
queryClient.setQueryData(["v2", "project-templates"], TEMPLATE_SUMMARIES);
queryClient.setQueryData(["v2", "me"], { is_staff: false });

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
	role: "owner",
	tier: "free",
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

const path =
	new URLSearchParams(window.location.search).get("path") ??
	"/en-US/w/w1/projects/new";
const router = createMemoryRouter(
	[
		{
			element: <CreateProjectRoute />,
			path: "/:language/w/:workspaceId/projects/new",
		},
		{ element: <ProjectsHomeRoute />, path: "/:language/w/:workspaceId/home" },
		{ element: <div data-testid="harness-landed" />, path: "*" },
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
