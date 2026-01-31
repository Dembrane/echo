# Echo Cypress Test Suite Documentation

## Overview

This document describes all automated end-to-end test flows implemented in the Echo Cypress test suite. Each test ensures proper functionality across the application's core features.

---

## Test Suites

### 01 - Login & Logout Flow
**File:** `01-login-logout.cy.js`

**Purpose:** Verifies basic authentication functionality.

**Steps:**
1. Navigate to the application
2. Enter credentials and login
3. Open the settings menu
4. Click logout button
5. Verify redirect to login page

---

### 02 - Multilingual Support Flow
**File:** `02-multilingual.cy.js`

**Purpose:** Verifies the application's language switching capability.

**Steps:**
1. Login to the application
2. Open settings menu
3. Change language to Spanish (es-ES)
4. Verify URL contains `/es-ES/`
5. Verify "Projects" header shows "Proyectos"
6. Verify logout button shows "Cerrar sesión"
7. Switch back to English (en-US)
8. Verify content reverts to English
9. Logout

---

### 03 - Create & Delete Project Flow
**File:** `03-create-delete-project.cy.js`

**Purpose:** Tests basic project creation and immediate deletion.

**Steps:**
1. Login to the application
2. Click "Create" button to create new project
3. Wait for automatic navigation to project overview
4. Capture project ID from URL
5. Verify project page loads with default name "New Project"
6. Navigate to Project Settings tab
7. Click "Delete Project" button
8. Confirm deletion in modal
9. Verify redirect to projects list
10. Verify project no longer appears in list
11. Logout

---

### 04 - Create, Edit & Delete Project Flow
**File:** `04-create-edit-delete-project.cy.js`

**Purpose:** Tests comprehensive project lifecycle including editing.

**Steps:**
1. Login and create new project
2. Update project name (with unique ID)
3. Open Portal Editor
4. Configure portal settings:
   - Select tutorial type (Basic)
   - Add custom tag
   - Update portal title and content
   - Change portal language to Italian
5. Navigate back to home
6. Verify updated project name in list
7. Re-enter project and verify:
   - Name displays correctly in breadcrumb
   - Portal settings persisted (tag, title, language)
8. Delete project
9. Logout

---

### 05 - QR Code Language Change
**File:** `05-qr-code-language.cy.js`

**Purpose:** Verifies QR code/portal link updates when language changes.

**Steps:**
1. Login and create new project
2. Click "Copy link" to capture initial portal URL
3. Verify URL contains `/en-US/` (default language)
4. Open Portal Editor
5. Change portal language to Italian (it)
6. Click "Copy link" again
7. Verify new URL contains `/it-IT/`
8. Confirm URLs are different
9. Delete project
10. Logout

---

### 06 - Announcements Feature
**File:** `06-announcements.cy.js`

**Purpose:** Tests the announcements sidebar functionality.

**Steps:**
1. Login to the application
2. Click the megaphone icon (Announcements button)
3. Verify announcements sidebar/drawer opens
4. Verify title shows "Announcements"
5. Verify content area exists
6. Click close button
7. Verify sidebar closes
8. Logout

---

### 07 - Upload Conversation Flow
**File:** `07-upload-conversation.cy.js`

**Purpose:** Tests uploading and processing audio files as conversations.

**Steps:**
1. Login and create new project
2. Click "Upload" button to open modal
3. Select audio file (`videoplayback.mp3`)
4. Click "Upload Files" button
5. Wait 15 seconds for processing
6. Close upload modal
7. Click on uploaded conversation in list
8. Verify conversation name matches filename
9. Wait 25 seconds for transcript processing
10. Click "Transcript" tab
11. Verify transcript contains at least 100 characters
12. Navigate to project overview
13. Delete project
14. Logout

---

### 08 - Participant Recording Flow
**File:** `08-participant-recording.cy.js`

**Purpose:** Tests the complete participant portal recording flow (cross-origin).

**Steps:**
1. Login and create new project
2. Construct portal URL with project ID
3. Navigate to participant portal (cross-origin via `cy.origin()`)
4. Accept privacy policy checkbox
5. Click "I understand" button
6. Skip microphone check
7. Enter session name ("Cypress Test Recording")
8. Click "Next"
9. Handle microphone access denied modal (if present)
10. Click Text Response icon
11. Type 150-character test response
12. Click "Submit"
13. Click "Finish"
14. Confirm finish in modal
15. Return to dashboard
16. Verify conversation appears with correct name
17. Verify transcript matches submitted text
18. Delete project
19. Logout

---

### 09 - Create Report Flow
**File:** `09-create-report.cy.js`

**Purpose:** Tests AI report generation from conversations.

**Steps:**
1. Login and create new project
2. Upload audio file (same as Suite 07)
3. Wait for processing
4. Click "Report" button
5. Click "Create Report" in modal
6. Wait 20 seconds for AI processing
7. Click "Report" button again
8. Verify report elements:
   - Dembrane logo visible
   - "Dembrane" heading
   - "Report" text
9. Navigate to project overview
10. Delete project
11. Logout

---

### 10 - Publish Report Flow
**File:** `10-publish-report.cy.js`

**Purpose:** Tests publishing reports for public access.

**Steps:**
1. Login and create new project
2. Upload audio file
3. Create report (same as Suite 09)
4. Open report view
5. Toggle "Publish" switch ON
6. Construct public URL from project ID
7. Visit public URL (cross-origin)
8. Verify public page shows:
   - Dembrane logo
   - "Dembrane" heading
   - "Report" text
9. Return to dashboard
10. Delete project
11. Logout

---

### 11 - Edit Report Flow
**File:** `11-edit-report.cy.js`

**Purpose:** Tests in-place report editing functionality.

**Steps:**
1. Login and create new project
2. Upload audio file
3. Create report
4. Open report view
5. Toggle "Editing mode" ON
6. Clear existing content in MDX editor
7. Type new content:
   - Heading: "Automated Edit Verification"
   - Paragraph: "This is a test edit from Cypress."
8. Toggle "Editing mode" OFF
9. Verify new content persists:
   - H1 heading visible
   - Paragraph text visible
10. Navigate to project
11. Delete project
12. Logout

---

### 12 - Ask Feature (With Context)
**File:** `12-ask-feature.cy.js`

**Purpose:** Tests the AI Ask feature with conversation context selected.

**Steps:**
1. Login and create new project
2. Upload audio file
3. Wait for processing
4. Click "Ask" button
5. Select uploaded conversation as context (checkbox)
6. Type query "hello"
7. Submit and wait for AI response
8. Verify response appears
9. Navigate to project overview
10. Delete project
11. Logout

---

### 13 - Ask Feature (No Context)
**File:** `13-ask-no-context.cy.js`

**Purpose:** Tests the AI Ask feature without manually selecting context.

**Steps:**
1. Login and create new project
2. Upload audio file
3. Wait for processing
4. Click "Ask" button
5. Type query "hello" (without selecting conversations)
6. Submit and wait for AI response
7. Verify response appears
8. Navigate to project overview
9. Delete project
10. Logout

---

## Running Tests

### Single Test
```powershell
npx cypress run --spec "e2e/suites/01-login-logout.cy.js" --env version=staging --browser chrome
```

### All Tests with HTML Report
```powershell
.\run-viewport-tests.ps1   # Mobile, Tablet, Desktop viewports
.\run-browser-tests.ps1    # Chrome, Firefox, Edge, WebKit browsers
```

### Safari (WebKit Experimental)
```powershell
npx cypress run --spec "e2e/suites/01-login-logout.cy.js" --env version=staging --browser webkit
```

Notes:
- WebKit support in Cypress is experimental.
- `cy.origin()` is not supported in WebKit; cross-origin flows will fail.
- On Linux, install WebKit system dependencies with `npx playwright install-deps webkit`.

### Reports
HTML reports are generated at: `cypress/reports/test-report.html`

---

## Helper Functions

| Module | Functions |
|--------|-----------|
| `login` | `loginToApp()`, `logout()` |
| `settings` | `openSettingsMenu()`, `changeLanguage()`, `verifyLanguage()` |
| `project` | `createProject()`, `deleteProject()`, `updateProjectName()`, `navigateToHome()` |
| `portal` | `openPortalEditor()`, `selectTutorial()`, `addTag()`, `updatePortalContent()`, `changePortalLanguage()` |
| `conversation` | `openUploadModal()`, `uploadAudioFile()`, `selectConversation()`, `clickTranscriptTab()` |
| `chat` | `askWithContext()`, `askWithoutContext()` |

---


