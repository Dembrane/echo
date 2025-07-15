import { Navigate, createBrowserRouter } from "react-router-dom";
import {
  createLazyRoute,
  createLazyNamedRoute,
} from "./components/common/LazyRoute";

// Layout components - keep as regular imports since they're used frequently
import { BaseLayout } from "./components/layout/BaseLayout";
import { ProjectLayout } from "./components/layout/ProjectLayout";
import { LanguageLayout } from "./components/layout/LanguageLayout";
import { ProjectConversationLayout } from "./components/layout/ProjectConversationLayout";
import { ProjectLibraryLayout } from "./components/layout/ProjectLibraryLayout";
import { AuthLayout } from "./components/layout/AuthLayout";
import { ProjectOverviewLayout } from "./components/layout/ProjectOverviewLayout";
import { ParticipantLayout } from "./components/layout/ParticipantLayout";
import { Protected } from "./components/common/Protected";
import { ErrorPage } from "./components/error/ErrorPage";

// Tab-based routes - import directly for now to debug
import {
  ProjectPortalSettingsRoute,
  ProjectSettingsRoute,
} from "./routes/project/ProjectRoutes";
import { ProjectConversationOverviewRoute } from "./routes/project/conversation/ProjectConversationOverview";
import { ProjectConversationTranscript } from "./routes/project/conversation/ProjectConversationTranscript";
import { ProjectConversationAnalysis } from "./routes/project/conversation/ProjectConversationAnalysis";
import { ParticipantPostConversation } from "./routes/participant/ParticipantPostConversation";
import {
  ParticipantConversationAudioRoute,
  ParticipantConversationTextRoute,
} from "./routes/participant/ParticipantConversation";
import { ParticipantStartRoute } from "./routes/participant/ParticipantStart";

// Lazy-loaded route components
const ProjectsHomeRoute = createLazyNamedRoute(
  () => import("./routes/project/ProjectsHome"),
  "ProjectsHomeRoute",
);

// Regular lazy-loaded routes
const ProjectResourceOverviewRoute = createLazyNamedRoute(
  () => import("./routes/project/resource/ProjectResourceOverview"),
  "ProjectResourceOverviewRoute",
);
const ProjectResourceAnalysisRoute = createLazyNamedRoute(
  () => import("./routes/project/resource/ProjectResourceAnalysis"),
  "ProjectResourceAnalysisRoute",
);

const ProjectLibraryRoute = createLazyNamedRoute(
  () => import("./routes/project/library/ProjectLibrary"),
  "ProjectLibraryRoute",
);
const ProjectLibraryInsight = createLazyNamedRoute(
  () => import("./routes/project/library/ProjectLibraryInsight"),
  "ProjectLibraryInsight",
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
    path: "/:language?",
    element: <LanguageLayout />,
    errorElement: <ErrorPage />,
    children: [
      {
        path: "",
        element: <Navigate to="/login" />,
      },
      {
        path: "login",
        element: (
          <AuthLayout>
            <LoginRoute />
          </AuthLayout>
        ),
      },
      {
        path: "register",
        element: (
          <AuthLayout>
            <RegisterRoute />
          </AuthLayout>
        ),
      },
      {
        path: "check-your-email",
        element: (
          <AuthLayout>
            <CheckYourEmailRoute />
          </AuthLayout>
        ),
      },
      {
        path: "password-reset",
        element: (
          <AuthLayout>
            <PasswordResetRoute />
          </AuthLayout>
        ),
      },
      {
        path: "request-password-reset",
        element: (
          <AuthLayout>
            <RequestPasswordResetRoute />
          </AuthLayout>
        ),
      },
      {
        path: "verify-email",
        element: (
          <AuthLayout>
            <VerifyEmailRoute />
          </AuthLayout>
        ),
      },
      {
        path: "projects",
        element: (
          <Protected>
            <BaseLayout />
          </Protected>
        ),

        children: [
          {
            index: true,
            element: <ProjectsHomeRoute />,
          },
          {
            path: ":projectId",
            children: [
              {
                element: <ProjectLayout />,
                children: [
                  {
                    path: "",
                    element: <ProjectOverviewLayout />,
                    children: [
                      {
                        index: true,
                        element: <Navigate to="portal-editor" replace />,
                      },
                      {
                        path: "overview",
                        element: <ProjectSettingsRoute />,
                      },
                      {
                        path: "portal-editor",
                        element: <ProjectPortalSettingsRoute />,
                      },
                      // {
                      //   path: "transcript-settings",
                      //   element: <ProjectTranscriptSettingsRoute />,
                      // },
                    ],
                  },
                  {
                    path: "chats/:chatId",
                    element: <ProjectChatRoute />,
                  },
                  {
                    path: "chats/:chatId/debug",
                    element: <DebugPage />,
                  },
                  {
                    path: "conversation/:conversationId",
                    element: <ProjectConversationLayout />,
                    children: [
                      {
                        index: true,
                        element: <Navigate to="overview" replace />,
                      },
                      {
                        path: "overview",
                        element: <ProjectConversationOverviewRoute />,
                      },
                      {
                        path: "transcript",
                        element: <ProjectConversationTranscript />,
                      },
                      {
                        path: "analysis",
                        element: <ProjectConversationAnalysis />,
                      },
                      {
                        path: "debug",
                        element: <DebugPage />,
                      },
                    ],
                  },

                  {
                    path: "library",
                    element: <ProjectLibraryLayout />,
                    children: [
                      {
                        path: "views/:viewId/aspects/:aspectId",
                        element: <ProjectLibraryAspect />,
                      },
                      {
                        path: "views/:viewId",
                        element: <ProjectLibraryView />,
                      },
                      {
                        path: "insights/:insightId",
                        element: <ProjectLibraryInsight />,
                      },
                      {
                        index: true,
                        element: <ProjectLibraryRoute />,
                      },
                    ],
                  },
                  {
                    path: "report",
                    element: <ProjectReportRoute />,
                  },
                  {
                    path: "debug",
                    element: <DebugPage />,
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        path: "*",
        element: <ErrorPage />,
      },
    ],
  },
]);

export const participantRouter = createBrowserRouter([
  {
    path: "/:language?/:projectId",
    element: <ParticipantLayout />,
    errorElement: <ErrorPage />,
    children: [
      {
        path: "",
        element: <Navigate to="start" />,
      },
      {
        path: "start",
        element: <ParticipantStartRoute />,
      },
      {
        path: "conversation/:conversationId",
        element: <ParticipantConversationAudioRoute />,
      },
      {
        path: "conversation/:conversationId/text",
        element: <ParticipantConversationTextRoute />,
      },
      {
        path: "conversation/:conversationId/finish",
        element: <ParticipantPostConversation />,
      },
      {
        path: "report",
        element: <ParticipantReport />,
      },
      {
        path: "unsubscribe",
        element: <ProjectUnsubscribe />,
      },
      {
        path: "*",
        element: <ErrorPage />,
      },
    ],
  },
]);
