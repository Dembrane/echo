import "@mantine/core/styles.css";
import "@/index.css";

import { Trans } from "@lingui/react/macro";
import { Box, Button, Group, MantineProvider, Stack } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import { IconContext, StopIcon } from "@phosphor-icons/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { Toaster } from "@/components/common/Toaster";
import { I18nProvider } from "@/components/layout/I18nProvider";
import { RefineButtonLabel } from "@/portal/components/refine/RefineButtonLabel";
import { RefineSelection } from "@/portal/components/refine/RefineSelection";
import { refineMode } from "@/portal/components/refine/refineMode";
import { StopRecordingConfirmationModal } from "@/portal/components/conversation/audio/StopRecordingConfirmationModal";
import { VerifySelection } from "@/portal/components/verify/VerifySelection";
import { ProjectPortalEditor } from "@/components/project/ProjectPortalEditor";
import { AppPreferencesProvider } from "@/hooks/useAppPreferences";
import {
	WorkspaceContext,
	type WorkspaceContextValue,
} from "@/hooks/useWorkspace";
import { cssVariablesResolver, theme } from "@/theme";

// The participant's Verify and Explore states and the portal editor's Verify and Explore
// sections (ECHO-1052), outside the app shell, for screenshots. ?view= picks the state and
// ?lang= the language; the data is seeded here, the spec answers anything else.
const params = new URLSearchParams(window.location.search);
const view = params.get("view") ?? "choice-both";
const lang = params.get("lang") ?? "en-US";
const nl = lang === "nl-NL";

const LABELS: Record<string, [string, string]> = {
	actions: ["Decisions and actions", "Besluiten en acties"],
	agreements: ["Table check", "Tafelcheck"],
	disagreements: ["Differences", "Verschillen"],
	gems: ["Ideas worth keeping", "Ideeën om te bewaren"],
	heard: ["What we heard", "Wat we hoorden"],
	moments: ["Turning points", "Kantelpunten"],
	truths: ["Hard points", "Lastige punten"],
};
const topic = (key: string) => ({
	is_custom: false,
	key,
	translations: {
		"en-US": { label: LABELS[key]?.[0] ?? key },
		"nl-NL": { label: LABELS[key]?.[1] ?? key },
	},
});
const custom = {
	is_custom: true,
	key: "our-question-1a2b3c4d",
	translations: {
		"en-US": { label: "What should the council hear first?" },
		"nl-NL": { label: "Wat moet de gemeente als eerste horen?" },
	},
};
const allTopics = [
	"agreements",
	"disagreements",
	"actions",
	"gems",
	"truths",
	"heard",
	"moments",
].map(topic);

const both = { is_get_reply_enabled: true, is_verify_enabled: true };
const projectFor: Record<string, Record<string, unknown>> = {
	"button-both": both,
	"button-explore": { is_get_reply_enabled: true, is_verify_enabled: false },
	"button-verify": { is_get_reply_enabled: false, is_verify_enabled: true },
	"choice-both": both,
	picker: both,
};
const participantProject: Record<string, unknown> & {
	is_get_reply_enabled?: boolean;
	is_verify_enabled?: boolean;
} = {
	id: "p1",
	is_ai_available: true,
	language: nl ? "nl" : "en",
	...(projectFor[view] ?? both),
};

const queryClient = new QueryClient({
	defaultOptions: {
		queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
	},
});
queryClient.setQueryData(["participantProject", "p1"], participantProject);
queryClient.setQueryData(["verify", "topics", "p1"], {
	available_topics: [...allTopics, custom],
	selected_topics: ["agreements", "disagreements", "actions", "heard"],
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
	role: "owner",
	tier: "innovator",
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

/** The recorder's footer while recording past the first minute, with the real label. */
const RecorderFooter = () => (
	<Box className="flex h-dvh flex-col justify-end">
		<Stack className="border-t border-[var(--app-rule-color)] p-4">
			{/* As in ParticipantConversationAudio while recording. */}
			<Group justify="center" gap="lg">
				<Button
					size="lg"
					variant="filled"
					data-testid="portal-audio-echo-button"
				>
					<RefineButtonLabel mode={refineMode(participantProject)} />
				</Button>
				<Button
					size="lg"
					color="red"
					leftSection={<StopIcon size={20} className="hidden md:block" />}
					data-testid="portal-audio-stop-button"
				>
					<Trans id="participant.button.stop">Stop</Trans>
				</Button>
			</Group>
		</Stack>
	</Box>
);

const editorProject = {
	default_conversation_ask_for_participant_email: false,
	default_conversation_ask_for_participant_name: true,
	default_conversation_description: "",
	default_conversation_finish_text: "",
	default_conversation_title: "",
	default_conversation_transcript_prompt: "Lindenwijk, Kastanjeplein",
	default_conversation_tutorial_slug: "none",
	get_reply_mode: "summarize",
	get_reply_prompt: "",
	id: "p1",
	is_get_reply_cross_pollination_enabled: false,
	is_get_reply_enabled: true,
	is_project_notification_subscription_allowed: false,
	is_verify_enabled: true,
	is_verify_on_finish_enabled: true,
	language: nl ? "nl" : "en",
	name: nl ? "Toekomst van Lindenwijk" : "The future of Lindenwijk",
	tags: [],
	updated_at: "2026-11-10T09:00:00Z",
};

const Editor = () => (
	<ProjectPortalEditor
		project={editorProject as never}
		verificationTopics={{
			available_topics: [...allTopics, custom],
			selected_topics: ["agreements", "actions"],
		}}
	/>
);

const Reminder = () => (
	<StopRecordingConfirmationModal
		opened
		close={() => {}}
		isStopping={false}
		handleConfirmFinish={() => {}}
		handleResume={() => {}}
		handleSwitchToText={() => {}}
		showVerifyOnFinish
		handleSkipVerification={() => {}}
		handleVerify={() => {}}
	/>
);

const element = (() => {
	if (view.startsWith("button-")) return <RecorderFooter />;
	if (view === "picker") return <VerifySelection />;
	if (view === "reminder") return <Reminder />;
	if (view === "editor") return <Editor />;
	return <RefineSelection />;
})();

const router = createMemoryRouter(
	[
		{
			element: (
				<main
					style={{
						margin: "0 auto",
						maxWidth: view === "editor" ? 1100 : 672,
						padding: view === "editor" ? 24 : "0 16px",
					}}
				>
					{element}
				</main>
			),
			path: "/:language/:projectId/conversation/:conversationId/*",
		},
		{ element: <div data-testid="harness-landed" />, path: "*" },
	],
	{ initialEntries: [`/${lang}/p1/conversation/c1/refine`] },
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
