# Cypress Test Flows Explanation

This document explains what each of the 35 Cypress End-to-End (E2E) test flows in the `e2e/suites` folder does.

### 01-login-logout.cy.js
Tests the authentication flow, ensuring users can successfully log in with valid credentials and log out of the application securely.

### 02-multilingual.cy.js
Validates the multilingual support flow, checking that the application's interface language can be changed and translates correctly across different views.

### 03-create-delete-project.cy.js
Checks the basic project lifecycle flow: creating a new project from scratch and then deleting it, ensuring both operations complete without errors.

### 04-create-edit-delete-project.cy.js
A comprehensive project lifecycle flow that expands on the previous test by also inserting an edit phase. It tests creating, updating the details of, and finally deleting a project.

### 05-qr-code-language.cy.js
Tests the QR code language change functionality, ensuring that scanning a QR code or accessing a link with a localized QR parameter properly defaults the application language.

### 06-announcements.cy.js
Tests the Announcements feature, ensuring that administrative announcements are properly created, displayed to users, and appropriately handled.

### 07-upload-conversation.cy.js
Tests the flow of uploading a pre-recorded conversation (audio/video), verifying the upload process, storage, and initial processing states.

### 08-participant-recording.cy.js
Tests the flow where a participant actively records a conversation through the platform directly, checking audio/video permissions and successful recording completion.

### 09-create-report.cy.js
Tests the creation of a new report from discussions/conversations, verifying that the necessary analytical data is correctly generated and gathered.

### 10-publish-report.cy.js
Verifies the process of taking a drafted or generated report and publishing it, making it available and visible to the appropriate stakeholders.

### 11-edit-report.cy.js
Tests the edit report flow, ensuring users can modify an existing report's content, layout, or included insights and save the changes successfully.

### 12-chat-ask-feature.cy.js
Tests the core "Ask Feature" (chat functionality) allowing users to query conversations with specific context, verifying the AI/chatbot accurately returns relevant information.

### 13-chat-ask-no-context.cy.js
Tests the Ask Feature when no specific context is selected, ensuring the system handles global queries across all available project data gracefully.

### 14-participant-audio-flow.cy.js
A detailed flow focusing solely on participant audio recording, including microphone checks, audio quality, and seamless upload back to the server.

### 15-change-conversation-name.cy.js
Tests the conversational management feature of renaming an existing conversation, ensuring the new name is persisted and reflected in the UI.

### 16-project-tags-conversation-flow.cy.js
Validates the tagging system within projects and conversations, verifying that tags can be applied, displayed, and help categorize data effectively.

### 17-make-it-concrete-flow.cy.js
Tests the "Make it Concrete" AI/insight feature, ensuring the software can take general conversational points and extract or transform them into concrete, actionable items.

### 18-go-deeper-flow.cy.js
Tests the "Go Deeper" checking flow, evaluating the system's ability to prompt or explore deeper analytical insights from a given conversation context.

### 19-project-clone.cy.js
Tests the project duplication tool, ensuring that cloning a project accurately copies its settings, parameters, and structural data without conflict.

### 20-download-transcription.cy.js
Verifies that users can successfully request, generate, and download the full text transcription of a recorded or uploaded conversation.

### 21-generate-and-regenerate-summary.cy.js
Tests the AI summary generation flow. It checks initial summary creation and validates that clicking "regenerate" provides a fresh summary for the conversation.

### 22-rename-chat.cy.js
Tests the chat management feature of renaming specific chat threads or sessions, ensuring the change persists natively.

### 23-delete-chat.cy.js
Tests the deletion of a specific chat session or threaded query, making sure it is permanently removed from the user's interface and history.

### 24-dynamic-suggestions.cy.js
Checks the Dynamic Suggestions feature within the Ask/Chat flow, verifying that contextual AI prompts are generated based on the specific conversation content.

### 25-delete-conversation.cy.js
Tests removing an entire conversation from a project, verifying side-effects like transcription and media removal from the user's view.

### 26-download-conversation.cy.js
Verifies the flow for downloading the original audio or video media file associated with a particular conversation.

### 27-retranscribe-conversation.cy.js
Tests the functionality allowing a user to force a re-transcription of an existing conversation (e.g., if the original transcription failed or a different language was selected).

### 28-move-conversation-between-projects.cy.js
Verifies that a conversation can be successfully migrated from one project space to another without losing its associated metadata, transcription, or media.

### 29-search-with-tags.cy.js
Checks the project search functionality heavily relying on tags, making sure that filtering projects or conversations by tags yields accurate results.

### 30-report-lifecycle.cy.js
An end-to-end evaluation covering a report's entire lifecycle: creation, editing, publishing, and eventual deletion or archiving.

### 31-print-report.cy.js
Tests the print flow for reports, ensuring the specialized print-friendly CSS and layout correctly render when a user attempts to print or export a report to PDF.

### 32-portal-participation-availability.cy.js
Tests the Participant Portal, explicitly verifying that availability constraints and schedules are correctly enforced when participants try to join.

### 33-test-participant-portal-changes.cy.js
Tests modifications (settings, UI, or thematic changes) made to the Participant Portal from the admin side and ensures they are correctly reflected for participants.

### 34-search-project-feature.cy.js
Validates the general Project Search feature, making sure string matching, partial queries, and UI search bars appropriately filter the project lists.

### 35-register-flow.cy.js
Tests the complete new user onboarding and registration flow, starting from the sign-up form through to email verification and account completion.
