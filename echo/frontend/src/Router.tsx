import { createBrowserRouter, Navigate } from "react-router";
import {
	createLazyNamedRoute,
	createLazyRoute,
} from "./components/common/LazyRoute";
import { Protected } from "./components/common/Protected";
import { ErrorPage } from "./components/error/ErrorPage";
import { AuthLayout } from "./components/layout/AuthLayout";
// Layout components - keep as regular imports since they're used frequently
import { BaseLayout } from "./components/layout/BaseLayout";
import { LanguageLayout } from "./components/layout/LanguageLayout";
import { ParticipantLayout } from "./components/layout/ParticipantLayout";
import { ProjectConversationLayout } from "./components/layout/ProjectConversationLayout";
import { ProjectLayout } from "./components/layout/ProjectLayout";
import { ProjectLibraryLayout } from "./components/layout/ProjectLibraryLayout";
import { ProjectOverviewLayout } from "./components/layout/ProjectOverviewLayout";
import {
	ParticipantConversationAudioRoute,
	ParticipantConversationTextRoute,
} from "./routes/participant/ParticipantConversation";
import { ParticipantPostConversation } from "./routes/participant/ParticipantPostConversation";
import { ParticipantStartRoute } from "./routes/participant/ParticipantStart";
import { ProjectConversationOverviewRoute } from "./routes/project/conversation/ProjectConversationOverview";
import { ProjectConversationTranscript } from "./routes/project/conversation/ProjectConversationTranscript";
// Tab-based routes - import directly for now to debug
import {
	ProjectPortalSettingsRoute,
	ProjectSettingsRoute,
} from "./routes/project/ProjectRoutes";

// Lazy-loaded route components
const ProjectsHomeRoute = createLazyNamedRoute(
	() => import("./routes/project/ProjectsHome"),
	"ProjectsHomeRoute",
);

const ProjectLibraryRoute = createLazyNamedRoute(
	() => import("./routes/project/library/ProjectLibrary"),
	"ProjectLibraryRoute",
);

const ProjectLibraryView = createLazyNamedRoute(
	() => import("./routes/project/library/ProjectLibraryView"),
	"ProjectLibraryView",
);
const ProjectLibraryAspect = createLazyNamedRoute(
	() => import("./routes/project/library/ProjectLibraryAspect"),
	"ProjectLibraryAspect",
);
const LoginRoute = createLazyNamedRoute(
	() => import("./routes/auth/Login"),
	"LoginRoute",
);
const RegisterRoute = createLazyNamedRoute(
	() => import("./routes/auth/Register"),
	"RegisterRoute",
);
const CheckYourEmailRoute = createLazyNamedRoute(
	() => import("./routes/auth/CheckYourEmail"),
	"CheckYourEmailRoute",
);
const VerifyEmailRoute = createLazyNamedRoute(
	() => import("./routes/auth/VerifyEmail"),
	"VerifyEmailRoute",
);
const PasswordResetRoute = createLazyNamedRoute(
	() => import("./routes/auth/PasswordReset"),
	"PasswordResetRoute",
);
const RequestPasswordResetRoute = createLazyNamedRoute(
	() => import("./routes/auth/RequestPasswordReset"),
	"RequestPasswordResetRoute",
);
const ProjectChatRoute = createLazyNamedRoute(
	() => import("./routes/project/chat/ProjectChatRoute"),
	"ProjectChatRoute",
);

const ProjectReportRoute = createLazyNamedRoute(
	() => import("./routes/project/report/ProjectReportRoute"),
	"ProjectReportRoute",
);
const ParticipantReport = createLazyNamedRoute(
	() => import("./routes/participant/ParticipantReport"),
	"ParticipantReport",
);
const ProjectUnsubscribe = createLazyNamedRoute(
	() => import("./routes/project/unsubscribe/ProjectUnsubscribe"),
	"ProjectUnsubscribe",
);
const DebugPage = createLazyRoute(() => import("./routes/Debug"));

export const mainRouter = createBrowserRouter([
	{
		children: [
			{
				element: <Navigate to="/login" />,
				path: "",
			},
			{
				element: (
					<AuthLayout>
						<LoginRoute />
					</AuthLayout>
				),
				path: "login",
			},
			{
				element: (
					<AuthLayout>
						<RegisterRoute />
					</AuthLayout>
				),
				path: "register",
			},
			{
				element: (
					<AuthLayout>
						<CheckYourEmailRoute />
					</AuthLayout>
				),
				path: "check-your-email",
			},
			{
				element: (
					<AuthLayout>
						<PasswordResetRoute />
					</AuthLayout>
				),
				path: "password-reset",
			},
			{
				element: (
					<AuthLayout>
						<RequestPasswordResetRoute />
					</AuthLayout>
				),
				path: "request-password-reset",
			},
			{
				element: (
					<AuthLayout>
						<VerifyEmailRoute />
					</AuthLayout>
				),
				path: "verify-email",
			},
			{
				children: [
					{
						element: <ProjectsHomeRoute />,
						index: true,
					},
					{
						children: [
							{
								children: [
									{
										children: [
											{
												element: <Navigate to="portal-editor" replace />,
												index: true,
											},
											{
												element: <ProjectSettingsRoute />,
												path: "overview",
											},
											{
												element: <ProjectPortalSettingsRoute />,
												path: "portal-editor",
											},
										],
										element: <ProjectOverviewLayout />,
										path: "",
									},
									{
										element: <ProjectChatRoute />,
										path: "chats/:chatId",
									},
									{
										element: <DebugPage />,
										path: "chats/:chatId/debug",
									},
									{
										children: [
											{
												element: <Navigate to="overview" replace />,
												index: true,
											},
											{
												element: <ProjectConversationOverviewRoute />,
												path: "overview",
											},
											{
												element: <ProjectConversationTranscript />,
												path: "transcript",
											},
											{
												element: <DebugPage />,
												path: "debug",
											},
										],
										element: <ProjectConversationLayout />,
										path: "conversation/:conversationId",
									},

									{
										children: [
											{
												element: <ProjectLibraryAspect />,
												path: "views/:viewId/aspects/:aspectId",
											},
											{
												element: <ProjectLibraryView />,
												path: "views/:viewId",
											},
											{
												element: <ProjectLibraryRoute />,
												index: true,
											},
										],
										element: <ProjectLibraryLayout />,
										path: "library",
									},
									{
										element: <ProjectReportRoute />,
										path: "report",
									},
									{
										element: <DebugPage />,
										path: "debug",
									},
								],
								element: <ProjectLayout />,
							},
						],
						path: ":projectId",
					},
				],
				element: (
					<Protected>
						<BaseLayout />
					</Protected>
				),
				path: "projects",
			},
			{
				element: <ErrorPage />,
				path: "*",
			},
		],
		element: <LanguageLayout />,
		errorElement: <ErrorPage />,
		path: "/:language?",
	},
]);

export const participantRouter = createBrowserRouter([
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
				element: <ParticipantConversationAudioRoute />,
				path: "conversation/:conversationId",
			},
			{
				element: <ParticipantConversationTextRoute />,
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
]);
