<wizard-report>
# PostHog post-wizard report

The wizard has completed a deep integration of PostHog analytics into the Echo/Dembrane frontend. PostHog (`posthog-js` + `@posthog/react`) was installed, initialized in `src/main.tsx`, and the app wrapped with `PostHogProvider`. User identification via `posthog.identify()` is called on login and registration. Session reset via `posthog.reset()` is called on logout. Nine business-critical events are now tracked across six files.

| Event | Description | File |
|---|---|---|
| `user_logged_in` | Host successfully logs in; calls `posthog.identify(email)` | `src/routes/auth/Login.tsx` |
| `user_login_failed` | Host login attempt fails (wrong password, invalid OTP, etc.) | `src/routes/auth/Login.tsx` |
| `user_registered` | Host submits the registration form; calls `posthog.identify(email)` | `src/routes/auth/Register.tsx` |
| `user_logged_out` | Host logs out; calls `posthog.reset()` | `src/components/auth/hooks/index.ts` |
| `project_created` | Host creates a new project from the projects home page | `src/routes/project/ProjectsHome.tsx` |
| `chat_mode_selected` | Host selects a chat mode (overview, deep_dive, agentic) | `src/routes/project/chat/ProjectChatRoute.tsx` |
| `chat_message_sent` | Host sends a message in the chat interface | `src/routes/project/chat/ProjectChatRoute.tsx` |
| `report_generated` | Host triggers report generation (immediate or scheduled) | `src/components/report/CreateReportForm.tsx` |
| `conversation_upload_started` | Host begins uploading conversation audio files | `src/components/dropzone/UploadConversationDropzone.tsx` |

## Next steps

We've built some insights and a dashboard for you to keep an eye on user behavior, based on the events we just instrumented:

- **Dashboard**: [Analytics basics](https://eu.posthog.com/project/160282/dashboard/625219)
- **Insight**: [User Login & Registration Funnel](https://eu.posthog.com/project/160282/insights/sfG1jkEN) — conversion from registration to first login
- **Insight**: [Daily Active Users (Logins)](https://eu.posthog.com/project/160282/insights/58s1MgzV) — daily unique users logging in
- **Insight**: [Project & Report Creation Trend](https://eu.posthog.com/project/160282/insights/h9dm8arV) — weekly project creation and report generation activity
- **Insight**: [Chat Engagement Funnel](https://eu.posthog.com/project/160282/insights/jMr58R6h) — funnel from chat mode selection to first message sent
- **Insight**: [Conversation Upload Trend](https://eu.posthog.com/project/160282/insights/ofstTlUa) — weekly conversation audio uploads

### Agent skill

We've left an agent skill folder in your project. You can use this context for further agent development when using Claude Code. This will help ensure the model provides the most up-to-date approaches for integrating PostHog.

</wizard-report>
