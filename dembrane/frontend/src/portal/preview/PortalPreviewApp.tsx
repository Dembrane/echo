import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { ADMIN_BASE_URL } from "@/config";
import {
	originOf,
	PREVIEW_READY,
	type PreviewMessage,
	parsePreviewMessage,
} from "@/lib/portalPreview/protocol";
import { ParticipantLayout } from "../layout/ParticipantLayout";
import { previewEntry, seedPreview } from "./fixtures";
import { PreviewHighlight } from "./PreviewHighlight";
import {
	ExploreScreen,
	FinishScreen,
	OnboardingScreen,
	PreviewResultContext,
	RecordingScreen,
	VerifySummaryScreen,
	VerifyTopicsScreen,
} from "./PreviewScreens";

/**
 * The portal's preview mode (ECHO-1060): the real participant screens, drawn with the
 * values the dashboard's portal editor sends, inside its preview frame.
 *
 * It listens to its parent only, and only to the dashboard's origin; it reads only
 * messages parsePreviewMessage accepts. It fetches nothing: every screen reads fixtures
 * seeded into a query client of its own. lockDown (see entry.tsx) has already taken away
 * requests, devices and analytics, and the screens are inert.
 */
export const PortalPreviewApp = ({ projectId }: { projectId: string }) => {
	const [message, setMessage] = useState<PreviewMessage | null>(null);
	const queryClient = useMemo(
		() =>
			new QueryClient({
				defaultOptions: {
					mutations: { retry: false },
					queries: {
						gcTime: Number.POSITIVE_INFINITY,
						refetchOnMount: false,
						refetchOnReconnect: false,
						refetchOnWindowFocus: false,
						retry: false,
						staleTime: Number.POSITIVE_INFINITY,
					},
				},
			}),
		[],
	);

	useEffect(() => {
		const dashboard = originOf(ADMIN_BASE_URL);
		if (!dashboard) return;
		const onMessage = (event: MessageEvent) => {
			if (event.source !== window.parent || event.origin !== dashboard) return;
			const parsed = parsePreviewMessage(event.data);
			if (!parsed) return;
			seedPreview(queryClient, projectId, parsed);
			setMessage(parsed);
		};
		window.addEventListener("message", onMessage);
		window.parent.postMessage({ type: PREVIEW_READY }, dashboard);
		return () => window.removeEventListener("message", onMessage);
	}, [queryClient, projectId]);

	const language = message?.project.language;
	const screen = message?.screen;
	// A new router per screen and language: each screen opens at its own address, as it
	// would for a participant. Values change in place, through the seeded queries.
	const router = useMemo(() => {
		if (!screen || !language) return null;
		return createMemoryRouter(
			[
				{
					children: [
						{
							children: [
								{
									element: <OnboardingScreen card="first" />,
									path: "start",
								},
								{
									element: <OnboardingScreen card="privacy" />,
									path: "start/privacy",
								},
								{
									element: <OnboardingScreen card="last" />,
									path: "start/form",
								},
								{
									element: <RecordingScreen />,
									path: "conversation/:conversationId",
								},
								{
									element: <ExploreScreen />,
									path: "conversation/:conversationId/explore",
								},
								{
									// No conversation in the address: the picker then starts no
									// draft on its own when only one topic is chosen.
									element: <VerifyTopicsScreen />,
									path: "choose/verify",
								},
								{
									element: <VerifySummaryScreen />,
									path: "conversation/:conversationId/verify/approve",
								},
								{
									element: <FinishScreen />,
									path: "conversation/:conversationId/finish",
								},
							],
							element: <ParticipantLayout />,
						},
					],
					element: <Outlet />,
					path: "/:language/:projectId",
				},
			],
			{ initialEntries: [previewEntry(screen, language, projectId)] },
		);
	}, [screen, language, projectId]);

	if (!router || !message) return null;
	return (
		<QueryClientProvider client={queryClient}>
			<div
				inert
				className="h-dvh overflow-hidden"
				data-preview-screen={message.screen}
				data-testid="portal-preview-root"
			>
				<PreviewResultContext.Provider value={message.result}>
					<RouterProvider router={router} />
				</PreviewResultContext.Provider>
			</div>
			<PreviewHighlight target={message.highlight} screen={message.screen} />
		</QueryClientProvider>
	);
};
