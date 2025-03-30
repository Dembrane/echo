import { Navigate, createBrowserRouter } from "react-router-dom";
import { BaseLayout } from "./components/layout/BaseLayout";
import { ProjectsHomeRoute } from "./routes/project/ProjectsHome";
import {
  ProjectPortalSettingsRoute,
  ProjectSettingsRoute,
} from "./routes/project/ProjectRoutes";
import { ProjectLayout } from "./components/layout/ProjectLayout";
import { ProjectResourceLayout } from "./components/layout/ProjectResourceLayout";
import { ProjectResourceOverviewRoute } from "./routes/project/resource/ProjectResourceOverview";
import { ProjectResourceAnalysisRoute } from "./routes/project/resource/ProjectResourceAnalysis";
import { LanguageLayout } from "./components/layout/LanguageLayout";
import {
  ParticipantConversationAudioRoute,
  ParticipantConversationTextRoute,
} from "./routes/participant/ParticipantConversation";
import { ProjectConversationLayout } from "./components/layout/ProjectConversationLayout";
import { ProjectConversationOverviewRoute } from "./routes/project/conversation/ProjectConversationOverview";
import { ProjectConversationTranscript } from "./routes/project/conversation/ProjectConversationTranscript";
import { ProjectConversationAnalysis } from "./routes/project/conversation/ProjectConversationAnalysis";
import { ProjectLibraryRoute } from "./routes/project/library/ProjectLibrary";
import { ProjectLibraryInsight } from "./routes/project/library/ProjectLibraryInsight";
import { ParticipantPostConversation } from "./routes/participant/ParticipantPostConversation";
import { ProjectLibraryLayout } from "./components/layout/ProjectLibraryLayout";
import { ProjectLibraryView } from "./routes/project/library/ProjectLibraryView";
import { ProjectLibraryAspect } from "./routes/project/library/ProjectLibraryAspect";
import { LoginRoute } from "./routes/auth/Login";
import { RegisterRoute } from "./routes/auth/Register";
import { Protected } from "./components/common/Protected";
import { AuthLayout } from "./components/layout/AuthLayout";
import { CheckYourEmailRoute } from "./routes/auth/CheckYourEmail";
import { VerifyEmailRoute } from "./routes/auth/VerifyEmail";
import { PasswordResetRoute } from "./routes/auth/PasswordReset";
import { RequestPasswordResetRoute } from "./routes/auth/RequestPasswordReset";
import { ProjectChatRoute } from "./routes/project/chat/ProjectChatRoute";
import { ProjectOverviewLayout } from "./components/layout/ProjectOverviewLayout";
import { ParticipantLayout } from "./components/layout/ParticipantLayout";
import { ParticipantStartRoute } from "./routes/participant/ParticipantStart";
import { ProjectReportRoute } from "./routes/project/report/ProjectReportRoute";
import { ErrorPage } from "./components/error/ErrorPage";
import { ParticipantReport } from "./routes/participant/ParticipantReport";
import { ProjectUnsubscribe } from "./routes/project/unsubscribe/ProjectUnsubscribe";

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
                        path: "overview",
                        element: <ProjectSettingsRoute />,
                      },
                      {
                        index: true,
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
                    path: "resources/:resourceId",
                    element: <ProjectResourceLayout />,
                    children: [
                      {
                        index: true,
                        path: "overview",
                        element: <ProjectResourceOverviewRoute />,
                      },
                      {
                        path: "chat",
                        element: <ProjectResourceAnalysisRoute />,
                      },
                    ],
                  },
                  {
                    path: "conversation/:conversationId",
                    element: <ProjectConversationLayout />,
                    children: [
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
                ],
              },
            ],
          },
        ],
      },
      {
        path: "unsubscribe",
        element: <ProjectUnsubscribe/>,
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
      // {
      //   path: "spike/conversation/:conversationId",
      //   element: <SpikeParticipantConversationAudioRoute />,
      // },
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
        path: "*",
        element: <ErrorPage />,
      },
    ],
  },
]);
