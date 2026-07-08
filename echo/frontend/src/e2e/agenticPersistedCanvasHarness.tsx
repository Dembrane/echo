import "@fontsource-variable/space-grotesk";
import "@mantine/core/styles.css";
import "@/index.css";

import { Button, MantineProvider, Stack, Text } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { CanvasSuggestionCard } from "@/components/chat/CanvasSuggestionCard";
import {
	extractTopLevelToolActivity,
	parseCanvasSuggestion,
} from "@/components/chat/agenticToolActivity";
import { Toaster } from "@/components/common/Toaster";
import { I18nProvider } from "@/components/layout/I18nProvider";
import type { AgenticRunEvent } from "@/lib/api";
import { testId } from "@/lib/testUtils";
import { theme } from "@/theme";

const projectId = "project-harness";
const workspaceId = "workspace-harness";
const chatId = "chat-harness";
const chatPath = `/en-US/w/${workspaceId}/projects/${projectId}/chats/${chatId}`;

window.history.replaceState({}, "", chatPath);

const proposedAt = "2026-07-08T09:53:30.000Z";

const malformedCanvasEvent: AgenticRunEvent = {
	event_type: "on_tool_end",
	id: 1,
	payload: {
		name: "proposeCanvas",
		output: {
			kwargs: {
				content: "{ this is not valid json",
			},
		},
	},
	project_agentic_run_id: "run-harness",
	seq: 1,
	timestamp: proposedAt,
};

const persistedCanvasEvent: AgenticRunEvent = {
	event_type: "on_tool_end",
	id: 2,
	payload: {
		name: "proposeCanvas",
		output: {
			kwargs: {
				content: JSON.stringify({
					brief:
						"Update the text formatting on the dashboard so it displays '2 interviews had' instead of '2 interviews uploaded'.",
					cadence_minutes: 5,
					expires_at: "2026-07-08T19:53:00.000Z",
					gather_spec: { source: "all_conversations" },
					name: "Street Feedback Dashboard",
					project_id: projectId,
					target_canvas_id: "canvas-1",
					target_canvas_name: "Street Feedback Dashboard",
					type: "canvas_proposal",
					visible_to_user: true,
				}),
			},
		},
	},
	project_agentic_run_id: "run-harness",
	seq: 2,
	timestamp: proposedAt,
};

const PersistedCanvasHarness = () => {
	const [remountKey, setRemountKey] = useState(0);
	const suggestion = useMemo(() => {
		for (const activity of extractTopLevelToolActivity([
			malformedCanvasEvent,
			persistedCanvasEvent,
		])) {
			try {
				const parsed = parseCanvasSuggestion(activity);
				if (parsed) return parsed;
			} catch {
				// Mirrors AgenticChatPanel containment: one malformed payload must
				// never blank the rest of the thread.
			}
		}
		return null;
	}, []);

	return (
		<Stack p="lg" maw={760} {...testId("agentic-persisted-canvas-harness")}>
			<Text size="sm">Persisted canvas history loaded.</Text>
			<Button
				size="xs"
				variant="outline"
				onClick={() => setRemountKey((value) => value + 1)}
				{...testId("agentic-persisted-canvas-remount")}
			>
				Remount card
			</Button>
			{suggestion ? (
				<CanvasSuggestionCard
					key={remountKey}
					chatId={chatId}
					suggestion={suggestion}
				/>
			) : (
				<Text size="sm">No canvas suggestion parsed.</Text>
			)}
		</Stack>
	);
};

const router = createBrowserRouter([
	{
		element: <PersistedCanvasHarness />,
		path: "/:language/w/:workspaceId/projects/:projectId/chats/:chatId",
	},
]);

const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			retry: false,
		},
	},
});

createRoot(document.getElementById("root") as HTMLElement).render(
	<QueryClientProvider client={queryClient}>
		<MantineProvider theme={theme}>
			<I18nProvider>
				<ModalsProvider>
					<RouterProvider router={router} />
					<Toaster />
				</ModalsProvider>
			</I18nProvider>
		</MantineProvider>
	</QueryClientProvider>,
);
