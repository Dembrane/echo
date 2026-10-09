import { Navigate, type RouteObject } from "react-router";
import { createLazyNamedRoute } from "@/components/common/LazyRoute";
import { ErrorPage } from "@/components/error/ErrorPage";
import { ParticipantConversationAudio } from "./components/conversation/audio/ParticipantConversationAudio";
import { ParticipantConversationAudioContent } from "./components/conversation/audio/ParticipantConversationAudioContent";
import { ParticipantConversationText } from "./components/conversation/text/ParticipantConversationText";
import { RefineSelection } from "./components/refine/RefineSelection";
import { Verify } from "./components/verify/Verify";
import { VerifyArtefact } from "./components/verify/VerifyArtefact";
import { VerifySelection } from "./components/verify/VerifySelection";
import { ParticipantLayout } from "./layout/ParticipantLayout";
import { ParticipantPostConversation } from "./routes/ParticipantPostConversation";
import { ParticipantStartRoute } from "./routes/ParticipantStart";

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
 * keeps that load small); the rest are lazy.
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
				element: <ErrorPage />,
				path: "*",
			},
		],
		element: <ParticipantLayout />,
		errorElement: <ErrorPage />,
		path: "/:language?/:projectId",
	},
];
