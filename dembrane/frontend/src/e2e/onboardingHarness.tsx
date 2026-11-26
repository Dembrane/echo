import "@mantine/core/styles.css";
import "@/index.css";

import { MantineProvider } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import { IconContext } from "@phosphor-icons/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { Toaster } from "@/components/common/Toaster";
import { ReportIssueModal } from "@/components/feedback/ReportIssueModal";
import { Inbox } from "@/components/inbox/Inbox";
import { I18nProvider } from "@/components/layout/I18nProvider";
import { AppPreferencesProvider } from "@/hooks/useAppPreferences";
import {
	WorkspaceContext,
	type WorkspaceContextValue,
} from "@/hooks/useWorkspace";
import { OnboardingRoute } from "@/routes/onboarding/OnboardingRoute";
import { cssVariablesResolver, theme } from "@/theme";

// The About you questions (the real /onboarding route) and the feedback dialog, which
// share the voice text field, and the bell where staff read the answer, outside the
// signed-in shell, for screenshots. ?path= picks the page; the spec answers the API.
const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});

const context: WorkspaceContextValue = {
	clearWorkspace: () => {},
	isError: false,
	isLoading: false,
	refetch: () => {},
	setWorkspace: () => {},
	workspace: null,
	workspaceId: null,
	workspaceName: null,
	workspaces: [],
};

const Feedback = () => (
	<ReportIssueModal opened onClose={() => {}} locale="en-US" />
);

const path =
	new URLSearchParams(window.location.search).get("path") ??
	"/en-US/onboarding";
const router = createMemoryRouter(
	[
		{ element: <OnboardingRoute />, path: "/:language/onboarding" },
		{ element: <Feedback />, path: "/:language/feedback" },
		{ element: <Inbox />, path: "/:language/inbox" },
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
								<RouterProvider router={router} />
								<Toaster />
							</ModalsProvider>
						</I18nProvider>
					</WorkspaceContext.Provider>
				</AppPreferencesProvider>
			</IconContext.Provider>
		</MantineProvider>
	</QueryClientProvider>,
);
