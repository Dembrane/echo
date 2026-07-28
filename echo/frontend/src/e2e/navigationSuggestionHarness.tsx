import "@fontsource-variable/space-grotesk";
import "@mantine/core/styles.css";
import "@/index.css";

import { MantineProvider, Stack, Text } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import {
	extractTopLevelToolActivity,
	parseNavigationSuggestion,
} from "@/components/chat/agenticToolActivity";
import { NavigationSuggestionCard } from "@/components/chat/NavigationSuggestionCard";
import { Toaster } from "@/components/common/Toaster";
import { I18nProvider } from "@/components/layout/I18nProvider";
import type { AgenticRunEvent } from "@/lib/api";
import { testId } from "@/lib/testUtils";
import { theme } from "@/theme";

const projectId = "project-harness";
const workspaceId = "workspace-harness";
const chatPath = `/en-US/w/${workspaceId}/projects/${projectId}/chats/chat-harness`;

window.history.replaceState({}, "", chatPath);

const navigateToEvent: AgenticRunEvent = {
	event_type: "on_tool_end",
	id: 1,
	payload: {
		name: "navigateTo",
		output: {
			kwargs: {
				content: JSON.stringify({
					entity_id: null,
					label: "overview",
					page: "overview",
					project_id: projectId,
					type: "navigation_suggestion",
					visible_to_user: true,
				}),
			},
		},
	},
	project_agentic_run_id: "run-harness",
	seq: 1,
	timestamp: new Date("2026-07-08T12:00:00Z").toISOString(),
};

const NavigationHarness = () => {
	const activity = extractTopLevelToolActivity([navigateToEvent])[0];
	const suggestion = activity ? parseNavigationSuggestion(activity) : null;

	return (
		<Stack p="lg" maw={720} {...testId("navigation-harness-chat")}>
			<Text size="sm">Chat stayed mounted.</Text>
			{suggestion ? (
				<NavigationSuggestionCard suggestion={suggestion} />
			) : (
				<Text size="sm">No navigation suggestion parsed.</Text>
			)}
		</Stack>
	);
};

const Destination = () => (
	<Stack p="lg" {...testId("navigation-harness-destination")}>
		<Text size="sm">Overview route reached.</Text>
	</Stack>
);

const router = createBrowserRouter([
	{
		element: <NavigationHarness />,
		path: "/:language/w/:workspaceId/projects/:projectId/chats/:chatId",
	},
	{
		element: <Destination />,
		path: "/:language/w/:workspaceId/projects/:projectId/home",
	},
]);

createRoot(document.getElementById("root") as HTMLElement).render(
	<MantineProvider theme={theme}>
		<I18nProvider>
			<ModalsProvider>
				<RouterProvider router={router} />
				<Toaster />
			</ModalsProvider>
		</I18nProvider>
	</MantineProvider>,
);
