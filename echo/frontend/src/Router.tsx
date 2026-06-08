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
import { ProjectLayout } from "./components/layout/ProjectLayout";
import { ProjectLibraryLayout } from "./components/layout/ProjectLibraryLayout";
import { ProjectOverviewLayout } from "./components/layout/ProjectOverviewLayout";
import { WorkspaceLayout } from "./components/layout/WorkspaceLayout";
import { ParticipantConversationAudioContent } from "./components/participant/ParticipantConversationAudioContent";
import { RefineSelection } from "./components/participant/refine/RefineSelection";
import { Verify } from "./components/participant/verify/Verify";
import { VerifyArtefact } from "./components/participant/verify/VerifyArtefact";
import { VerifySelection } from "./components/participant/verify/VerifySelection";
import { ProjectAccessGuard } from "./components/project/ProjectAccessGuard";
import {
	ParticipantConversationAudioRoute,
	ParticipantConversationTextRoute,
} from "./routes/participant/ParticipantConversation";
import { ParticipantPostConversation } from "./routes/participant/ParticipantPostConversation";
import { ParticipantStartRoute } from "./routes/participant/ParticipantStart";
import { ProjectConversationRoute } from "./routes/project/conversation/ProjectConversationRoute";
import { ProjectHomeRoute } from "./routes/project/ProjectHomeRoute";
// Tab-based routes - import directly for now to debug
import {
	ProjectAccessRoute,
	ProjectConversationsRoute,
	ProjectIntegrationsRoute,
	ProjectPortalSettingsRoute,
	ProjectSettingsRoute,
	ProjectUploadRoute,
} from "./routes/project/ProjectRoutes";
import { SidebarPreviewLayout } from "./routes/sidebar-preview/SidebarPreviewLayout";
import { SidebarPreviewRoute } from "./routes/sidebar-preview/SidebarPreviewRoute";

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

const NewChatRoute = createLazyNamedRoute(
	() => import("./routes/project/chat/NewChatRoute"),
	"NewChatRoute",
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
const UserSettingsRoute = createLazyNamedRoute(
	() => import("./routes/settings/UserSettingsRoute"),
	"UserSettingsRoute",
);
const HostGuidePage = createLazyNamedRoute(
	() => import("./routes/project/HostGuidePage"),
	"HostGuidePage",
);
const OnboardingRoute = createLazyNamedRoute(
	() => import("./routes/onboarding/OnboardingRoute"),
	"OnboardingRoute",
);
const WorkspaceSelectorRoute = createLazyNamedRoute(
	() => import("./routes/workspaces/WorkspaceSelectorRoute"),
	"WorkspaceSelectorRoute",
);
const RootRedirect = createLazyNamedRoute(
	() => import("./routes/workspaces/WorkspaceSelectorRoute"),
	"RootRedirect",
);
const CreateWorkspaceRoute = createLazyNamedRoute(
	() => import("./routes/workspaces/CreateWorkspaceRoute"),
	"CreateWorkspaceRoute",
);
const CreateProjectRoute = createLazyNamedRoute(
	() => import("./routes/project/CreateProjectRoute"),
	"CreateProjectRoute",
);
const WorkspaceSettingsRoute = createLazyNamedRoute(
	() => import("./routes/workspaces/WorkspaceSettingsRoute"),
	"WorkspaceSettingsRoute",
);
const AcceptInviteRoute = createLazyNamedRoute(
	() => import("./routes/invite/AcceptInviteRoute"),
	"AcceptInviteRoute",
);
const MyInvitesRoute = createLazyNamedRoute(
	() => import("./routes/invite/MyInvitesRoute"),
	"MyInvitesRoute",
);
const OrganisationRoute = createLazyNamedRoute(
	() => import("./routes/organisation/OrganisationRoute"),
	"OrganisationRoute",
);
const AdminSettingsRoute = createLazyNamedRoute(
	() => import("./routes/admin/AdminSettingsRoute"),
	"AdminSettingsRoute",
);
// Project route children — shared between /projects and /w/:workspaceId/projects
const projectRouteChildren = [
	{
		element: <Navigate to="../home" replace />,
		index: true,
	},
	{
		element: <CreateProjectRoute />,
		path: "new",
	},
	{
		children: [
			{
				children: [
					{
						element: <ProjectHomeRoute />,
						path: "home",
					},
					{
						children: [
							{
								element: <Navigate to="home" replace />,
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
							{
								// "Access & usage" tab (2026-04-24) — dedicated
								// surface for per-project usage, sharing, and the
								// list of who can actually see the project.
								element: <ProjectAccessRoute />,
								path: "access",
							},
							{
								// /sharing tab retired 2026-04-23 — bookmark redirect
								// now points at the new /access tab.
								element: <Navigate to="../access" replace />,
								path: "sharing",
							},
						],
						element: <ProjectOverviewLayout />,
						path: "",
					},
					{
						element: <NewChatRoute />,
						path: "chats/new",
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
								element: <ProjectConversationRoute />,
								index: true,
							},
							{
								element: <Navigate to=".." replace />,
								path: "overview",
							},
							{
								element: <Navigate to=".." replace />,
								path: "transcript",
							},
							{
								element: <DebugPage />,
								path: "debug",
							},
						],
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
						element: <ProjectConversationsRoute />,
						path: "conversations",
					},
					{
						element: <ProjectUploadRoute />,
						path: "upload",
					},
					{
						element: <Navigate to="../integrations" replace />,
						path: "export",
					},
					{
						element: <ProjectIntegrationsRoute />,
						path: "integrations",
					},
					{
						element: <DebugPage />,
						path: "debug",
					},
				],
				element: (
					<ProjectAccessGuard>
						<ProjectLayout />
					</ProjectAccessGuard>
				),
			},
		],
		path: ":projectId",
	},
];

export const mainRouter = createBrowserRouter([
	{
		children: [
			{
				// Root entry: RootRedirect sends single-org users to their org
				// overview, everyone else to the /o home list.
				element: (
					<Protected>
						<RootRedirect />
					</Protected>
				),
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
				// Onboarding - one-time setup after first login
				element: (
					<Protected>
						<OnboardingRoute />
					</Protected>
				),
				path: "onboarding",
			},
			{
				// Accept invite — public (email link target). Handles logged-out,
				// logged-in-wrong-email, and logged-in-matching-email states.
				element: <AcceptInviteRoute />,
				path: "invite/accept",
			},
			{
				// My pending invites (authenticated list view with accept/decline)
				element: (
					<Protected>
						<MyInvitesRoute />
					</Protected>
				),
				path: "invites",
			},
			{
				// Request-workspace wizard. Bare /w is retired (home moved to /o)
				// and falls through to the 404; /w/:workspaceId/* is defined below.
				children: [
					{
						element: <CreateWorkspaceRoute />,
						index: true,
					},
				],
				element: (
					<Protected>
						<BaseLayout />
					</Protected>
				),
				path: "w/new",
			},
			{
				// Bare /o is the home list (organisations); /o/:organisationId is a
				// single org's admin surface.
				children: [
					{
						element: <WorkspaceSelectorRoute />,
						index: true,
					},
					{
						// Splat so tab state lives in the path
						// (/o/:organisationId/:tab) — matches the project-tab pattern.
						// The component parses the trailing segment itself.
						element: <OrganisationRoute />,
						path: ":organisationId/*",
					},
				],
				element: (
					<Protected>
						<BaseLayout />
					</Protected>
				),
				path: "o",
			},
			{
				// Workspace-scoped projects: /w/:workspaceId/projects/...
				// SINGLE canonical shape — legacy /projects/:projectId is gone.
				children: [
					{
						element: <Navigate to="home" replace />,
						index: true,
					},
					{
						children: [
							{
								element: <ProjectsHomeRoute />,
								path: "home",
							},
							{
								element: <HostGuidePage />,
								path: "projects/:projectId/host-guide",
							},
							{
								// Splat so the tab lives in the path
								// (/w/:workspaceId/settings/:tab). The component parses
								// the trailing segment.
								element: <WorkspaceSettingsRoute />,
								path: "settings/*",
							},
							{
								children: projectRouteChildren,
								path: "projects",
							},
						],
						element: <BaseLayout />,
					},
				],
				element: (
					<Protected>
						<WorkspaceLayout />
					</Protected>
				),
				path: "w/:workspaceId",
			},
			{
				children: [
					{
						element: <UserSettingsRoute />,
						index: true,
					},
					{
						element: <UserSettingsRoute />,
						path: ":section",
					},
				],
				element: (
					<Protected>
						<BaseLayout />
					</Protected>
				),
				path: "settings",
			},
			{
				// Staff-only — billing rollup, at-risk watch, partners, upgrades.
				// Client-side guard lives inside AdminSettingsRoute (reads
				// meV2.is_staff); backend /v2/admin/* also gates on is_admin.
				children: [
					{ element: <Navigate to="usage-and-billing" replace />, index: true },
					{ element: <AdminSettingsRoute />, path: ":tab" },
				],
				element: (
					<Protected>
						<BaseLayout />
					</Protected>
				),
				path: "admin",
			},
			{
				// Sidebar preview — feature/sidebar work-in-progress. No auth gate
				// so the design can be poked at without sign-in friction. Remove
				// or fold into real layouts once the sidebar replaces production
				// chrome.
				children: [
					{ element: <SidebarPreviewRoute />, index: true },
					{ element: <SidebarPreviewRoute />, path: "settings/:section" },
					{ element: <SidebarPreviewRoute />, path: "o/:orgId" },
					{
						element: <SidebarPreviewRoute />,
						path: "o/:orgId/settings/:section",
					},
					{
						element: <SidebarPreviewRoute />,
						path: "w/:workspaceId/home",
					},
					{
						element: <SidebarPreviewRoute />,
						path: "w/:workspaceId/projects",
					},
					{
						element: <SidebarPreviewRoute />,
						path: "w/:workspaceId/settings/:section",
					},
					{
						element: <SidebarPreviewRoute />,
						path: "w/:workspaceId/projects/:projectId/home",
					},
					{
						element: <SidebarPreviewRoute />,
						path: "w/:workspaceId/projects/:projectId/conversations",
					},
					{
						element: <SidebarPreviewRoute />,
						path: "w/:workspaceId/projects/:projectId/settings/:section",
					},
				],
				element: <SidebarPreviewLayout />,
				path: "sidebar-preview",
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
