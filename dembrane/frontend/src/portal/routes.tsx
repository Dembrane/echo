import { Navigate, type RouteObject } from "react-router";
import { createLazyNamedRoute } from "@/components/common/LazyRoute";
import { ParticipantConversationAudio } from "./components/conversation/audio/ParticipantConversationAudio";
import { ParticipantConversationAudioContent } from "./components/conversation/audio/ParticipantConversationAudioContent";
import { ParticipantConversationText } from "./components/conversation/text/ParticipantConversationText";
import { laterScreens } from "./laterScreens";
import { ParticipantErrorPage } from "./layout/ParticipantErrorPage";
import { ParticipantLayout } from "./layout/ParticipantLayout";
import { ParticipantStartRoute } from "./routes/ParticipantStart";

const RefineSelection = createLazyNamedRoute(
	laterScreens.refine,
	"RefineSelection",
);
const Verify = createLazyNamedRoute(laterScreens.verify, "Verify");
const VerifySelection = createLazyNamedRoute(
	laterScreens.verifySelection,
	"VerifySelection",
);
const VerifyArtefact = createLazyNamedRoute(
	laterScreens.verifyArtefact,
	"VerifyArtefact",
);
const ParticipantPostConversation = createLazyNamedRoute(
	laterScreens.finish,
	"ParticipantPostConversation",
);
const ParticipantReport = createLazyNamedRoute(
	() => import("./routes/ParticipantReport"),
	"ParticipantReport",
);
const ProjectUnsubscribe = createLazyNamedRoute(
	() => import("./routes/ProjectUnsubscribe"),
	"ProjectUnsubscribe",
);

/**
 * The participant portal's routes. The start screen and conversation are
 * imported eagerly so they land in the first load (scripts/check-portal-bundle
 * keeps that load small); the rest are lazy, and the screens of a conversation
 * under way are prefetched once the portal is idle (laterScreens.ts).
 */
export const participantRoutes: RouteObject[] = [
	{
		children: [
			{
				element: <Navigate to="start" />,
				path: "",
			},
			{
				element: <ParticipantStartRoute />,
				path: "start",
			},
			{
				children: [
					{
						element: <ParticipantConversationAudioContent />,
						index: true,
					},
					{
						element: <RefineSelection />,
						path: "refine",
					},
					{
						children: [
							{
								element: <VerifySelection />,
								index: true,
							},
							{
								element: <VerifyArtefact />,
								path: "approve",
							},
						],
						element: <Verify />,
						path: "verify",
					},
				],
				element: <ParticipantConversationAudio />,
				path: "conversation/:conversationId",
			},
			{
				element: <ParticipantConversationText />,
				path: "conversation/:conversationId/text",
			},
			{
				element: <ParticipantPostConversation />,
				path: "conversation/:conversationId/finish",
			},
			{
				element: <ParticipantReport />,
				path: "report",
			},
			{
				element: <ProjectUnsubscribe />,
				path: "unsubscribe",
			},
			{
				element: <ParticipantErrorPage />,
				path: "*",
			},
		],
		element: <ParticipantLayout />,
		errorElement: <ParticipantErrorPage />,
		path: "/:language?/:projectId",
	},
];
