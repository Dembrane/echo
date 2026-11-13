import "@mantine/core/styles.css";
import "@mantine/dropzone/styles.css";
import "@/index.css";

import { MantineProvider } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import { IconContext } from "@phosphor-icons/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { Toaster } from "@/components/common/Toaster";
import { I18nProvider } from "@/components/layout/I18nProvider";
import { PortalSectionEditor } from "@/components/project/portal-editor/PortalSectionEditor/PortalSectionEditor";
import { useTemplatesCatalog } from "@/components/project/templates/i18n";
import {
	CARD_KEYS,
	type CardKey,
	cardTags,
	templateGreatFor,
	templateName,
} from "@/components/project/templates/projectTemplates";
import {
	TEMPLATE_SUMMARIES,
	TEMPLATE_SUMMARIES_NL,
} from "@/components/project/templates/projectTemplates.fixture";
import { TemplateCard } from "@/components/project/templates/TemplateCard/TemplateCard";
import { AppPreferencesProvider } from "@/hooks/useAppPreferences";
import {
	WorkspaceContext,
	type WorkspaceContextValue,
} from "@/hooks/useWorkspace";
import { ParticipantInitiateForm } from "@/portal/components/start/ParticipantInitiateForm";
import { CreateProjectRoute } from "@/routes/project/CreateProjectRoute";
import { HostGuidePage } from "@/routes/project/HostGuidePage";
import { ProjectsHomeRoute } from "@/routes/project/ProjectsHome";
import { cssVariablesResolver, theme } from "@/theme";

// The create flow and workspace home's first-project state (ECHO-1042, ECHO-1053), the
// portal editor's name box label and a host guide a template filled in, outside the
// signed-in shell, for screenshots. ?path= picks the page; the spec answers the API.
const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});
queryClient.setQueryData(["v2", "project-templates", "en"], TEMPLATE_SUMMARIES);
queryClient.setQueryData(
	["v2", "project-templates", "nl"],
	TEMPLATE_SUMMARIES_NL,
);
queryClient.setQueryData(["v2", "me"], { is_staff: false });
// The portal editor's legal basis section and Verify topics, for the editor page.
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

// A project as the resident evening template creates it, for the portal editor.
const Editor = () => {
	const nl = window.location.search.includes("nl-NL");
	return (
		<div style={{ padding: 24 }}>
			<PortalSectionEditor
				section="about"
				option="name-label"
				readOnly={false}
				tags={[]}
				project={
					{
						conversation_ask_for_participant_name_label: nl
							? "Naam of nummer van je tafel"
							: "Table name or number",
						default_conversation_ask_for_participant_email: false,
						default_conversation_ask_for_participant_name: true,
						default_conversation_description: "",
						default_conversation_finish_text: "",
						default_conversation_title: "",
						default_conversation_transcript_prompt: "",
						default_conversation_tutorial_slug: "advanced",
						get_reply_mode: "summarize",
						get_reply_prompt: "",
						id: "p1",
						is_get_reply_cross_pollination_enabled: true,
						is_get_reply_enabled: true,
						is_project_notification_subscription_allowed: false,
						is_verify_enabled: true,
						is_verify_on_finish_enabled: true,
						language: nl ? "nl" : "en",
						name: nl
							? "Bewonersavond Lindenwijk"
							: "Lindenwijk resident evening",
						tags: [],
						updated_at: "2026-11-10T09:00:00Z",
						workspace_id: "w1",
					} as never
				}
				verificationTopics={{
					available_topics: [],
					selected_topics: ["agreements"],
				}}
			/>
		</div>
	);
};

// The portal's name box: ?label= the host's label, none for the default "Session name".
const PortalNameBox = () => {
	const label = new URLSearchParams(window.location.search).get("label");
	return (
		<div style={{ margin: "0 auto", maxWidth: 672, padding: "24px 16px" }}>
			<ParticipantInitiateForm
				project={
					{
						conversation_ask_for_participant_name_label: label,
						default_conversation_ask_for_participant_name: true,
						id: "p1",
						tags: [],
					} as never
				}
			/>
		</div>
	);
};

// All sixteen cards on one sheet (ECHO-1058), to judge the drawings side by side.
const ContactSheet = () => {
	const ready = useTemplatesCatalog();
	const nl = window.location.search.includes("nl-NL");
	if (!ready) return null;
	const summaries = nl ? TEMPLATE_SUMMARIES_NL : TEMPLATE_SUMMARIES;
	return (
		<div
			data-testid="contact-sheet"
			style={{
				display: "grid",
				gap: 16,
				gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
				padding: 24,
			}}
		>
			{CARD_KEYS.map((key: CardKey) => {
				const tpl = summaries.find((x) => x.key === key);
				return (
					<div key={key} className="app-do" style={{ padding: 16 }}>
						<TemplateCard
							template={key}
							name={templateName(key)}
							greatFor={templateGreatFor(key)}
							tags={tpl ? cardTags(tpl) : []}
						/>
					</div>
				);
			})}
		</div>
	);
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
		{ element: <Editor />, path: "/:language/editor" },
		{ element: <ContactSheet />, path: "/:language/contact-sheet" },
		{
			element: <HostGuidePage />,
			path: "/:language/w/:workspaceId/projects/:projectId/host-guide",
		},
		{ element: <PortalNameBox />, path: "/:language/:projectId/start" },
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
