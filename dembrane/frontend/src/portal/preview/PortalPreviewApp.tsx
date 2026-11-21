import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { ADMIN_BASE_URL } from "@/config";
import {
	originOf,
	PREVIEW_READY,
	type PreviewMessage,
	parsePreviewMessage,
} from "@/lib/portalPreview/protocol";
import { ParticipantLayout } from "../layout/ParticipantLayout";
import { answerRequests, previewEntry, seedPreview } from "./fixtures";
import { PreviewHighlight } from "./PreviewHighlight";
import {
	ExploreReplyContext,
	FinishScreen,
	OnboardingScreen,
	RecordingScreen,
	RefineScreen,
	VerifySummaryScreen,
	VerifyTopicsScreen,
} from "./PreviewScreens";

/**
 * The portal's preview mode (ECHO-1060): the real participant screens, drawn with the
 * values the dashboard's portal editor sends, inside its preview frame, at their own
 * addresses in a router of its own.
 *
 * It listens to its parent only, and only to the dashboard's origin; it reads only
 * messages parsePreviewMessage accepts. The host can click through the screens (ECHO-1062):
 * every screen reads fixtures seeded into a query client of its own, and the portal's own
 * requests (starting a conversation, a Verify draft, approving it) are answered from those
 * fixtures inside the frame (answerRequests), so nothing is sent. lockDown (see entry.tsx)
 * has already taken away real requests, devices, storage writes and analytics.
 *
 * A new reset from the dashboard starts the screen again, but only when the host clicked
 * inside the phone since the last one: typing in the editor changes the values in place.
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

	useEffect(
		() => answerRequests(queryClient, projectId),
		[queryClient, projectId],
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
	const reset = message?.reset;
	// Clicked or typed in since the screen last started.
	const touched = useRef(false);
	const [run, setRun] = useState(0);
	// A new router per screen and language, and per run: each screen opens at its own
	// address, as it would for a participant, and the host moves on from there. Values
	// change in place, through the seeded queries.
	// biome-ignore lint/correctness/useExhaustiveDependencies: run starts the screen again
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
									// The recording screen, with an Explore reply when asked for
									// one (?echo=1), as on the live portal.
									element: <RecordingScreen />,
									path: "conversation/:conversationId",
								},
								{
									element: <RefineScreen />,
									path: "conversation/:conversationId/refine",
								},
								{
									element: <VerifyTopicsScreen />,
									path: "conversation/:conversationId/verify",
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
	}, [screen, language, projectId, run]);
	// A new router is an untouched screen. Before the reset below, so a message that both
	// moves the screen and resets it starts it once.
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new router is the moment
	useEffect(() => {
		touched.current = false;
	}, [router]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new reset is the moment, not its value
	useEffect(() => {
		if (!touched.current) return;
		touched.current = false;
		setRun((r) => r + 1);
	}, [reset]);

	if (!router || !message) return null;
	return (
		<QueryClientProvider client={queryClient}>
			<div
				className="h-dvh overflow-hidden"
				data-preview-screen={message.screen}
				data-testid="portal-preview-root"
				onPointerDownCapture={() => {
					touched.current = true;
				}}
				onKeyDownCapture={() => {
					touched.current = true;
				}}
			>
				<ExploreReplyContext.Provider value={message.explore}>
					{/* Keyed: a router provider reads its router's state once. */}
					<RouterProvider
						key={`${screen}-${language}-${run}`}
						router={router}
					/>
				</ExploreReplyContext.Provider>
			</div>
			<PreviewHighlight
				key={run}
				target={message.highlight}
				screen={message.screen}
			/>
		</QueryClientProvider>
	);
};
