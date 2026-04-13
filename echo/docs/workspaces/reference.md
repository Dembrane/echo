# Dembrane Platform - App Overview & Screenshot Reference

A complete snapshot of the current Dembrane platform for designer reference.  
36 labelled screenshots covering both the host dashboard and the participant portal.

---

## App Feature Tree

```
Dembrane Platform
│
├── AUTH
│   ├── Login (email/password, optional 2FA PIN)
│   ├── Register (first name, last name, email, password)
│   ├── Verify Email
│   ├── Password Reset (request + reset)
│   └── Language picker (EN, NL, DE, FR, IT, ES, UA)
│
├── HOME (after login)
│   ├── Pinned Projects (max 3, quick access cards)
│   ├── Projects List (infinite scroll, search, owner filter for admins)
│   ├── Create Project button
│   └── Header
│       ├── Logo / Home link
│       ├── Announcements bar
│       └── User Menu
│           ├── Settings
│           ├── Documentation
│           ├── Feedback portal
│           ├── Report an issue
│           ├── Slack community
│           ├── Language picker
│           └── Logout
│
├── PROJECT (sidebar + main content layout)
│   │
│   ├── Sidebar (resizable, collapsible on mobile)
│   │   ├── Home breadcrumb
│   │   ├── Project name (links to portal editor)
│   │   ├── Ask button (opens new chat)
│   │   ├── Library link
│   │   ├── Report button
│   │   ├── Chats accordion (list of past chats with title, date, menu)
│   │   ├── Conversations accordion
│   │   │   ├── Search conversations
│   │   │   ├── Upload button
│   │   │   ├── Options/Filters (Sort, Tags, Verified, Reset)
│   │   │   └── Conversation list (name, duration, date, tags, verified badge)
│   │   └── "Powered by Dembrane" footer
│   │
│   ├── Project Overview
│   │   ├── QR code for participant portal link
│   │   ├── "Open for Participation?" toggle
│   │   ├── Ongoing conversations count
│   │   ├── Open guide / Copy link / Download QR buttons
│   │   │
│   │   ├── [Tab] Portal Editor
│   │   │   ├── Conversation flow settings (ask for name, email, tags)
│   │   │   ├── AI title & tag generation settings
│   │   │   ├── Verification settings & topics
│   │   │   ├── GetReply mode settings
│   │   │   ├── Tutorial slug selection
│   │   │   ├── Finish text customization
│   │   │   └── Transcript anonymization toggle
│   │   │
│   │   └── [Tab] Project Settings
│   │       ├── Name & context
│   │       ├── Upload section (add recordings)
│   │       ├── Export (download all transcripts)
│   │       ├── Host Guide link
│   │       ├── Webhooks (advanced, add/manage webhooks)
│   │       └── Actions (clone project, delete project)
│   │
│   ├── Conversation Detail
│   │   ├── [Tab] Overview
│   │   │   ├── Summary (AI-generated, copy/regenerate buttons)
│   │   │   ├── Outcomes (approved artifacts from verify flow)
│   │   │   │   └── Expandable accordion per artifact (title, approval date, full content)
│   │   │   ├── Edit: name (portal-entered), title (AI-generated + Generate button), tags
│   │   │   ├── Move to another project (BETA)
│   │   │   ├── Download audio
│   │   │   └── Delete conversation
│   │   │
│   │   └── [Tab] Transcript
│   │       ├── Full transcript with timestamps & speaker labels
│   │       ├── Copy transcript
│   │       └── Download transcript
│   │
│   ├── Ask / Chat
│   │   ├── New Chat - Mode Selection
│   │   │   ├── Agentic (BETA) - multi-step analysis with tool execution
│   │   │   ├── Specific Details - select conversations, find exact quotes
│   │   │   └── Overview (BETA) - themes & patterns across all conversations
│   │   │
│   │   └── Chat Interface
│   │       ├── Chat title + action buttons (copy, menu)
│   │       ├── System welcome message
│   │       ├── Context indicator (which conversations are loaded)
│   │       ├── User messages + AI responses (markdown, headings, bold, quotes)
│   │       ├── Conversation checkboxes in sidebar (select context for chat)
│   │       ├── Quick template buttons (Summarize, Compare & Contrast, Meeting Notes)
│   │       ├── Text input with "/" for template picker
│   │       ├── Message streaming with citations
│   │       ├── Save responses as templates
│   │       ├── Copy chat to markdown
│   │       └── Scroll to bottom button
│   │
│   ├── Library (access-gated)
│   │   ├── Create library (requires conversations)
│   │   ├── Views list (auto-generated analysis)
│   │   │   └── View Detail
│   │   │       ├── View summary (markdown)
│   │   │       └── Aspect cards with insights
│   │   │           └── Aspect Detail (deep-dive analysis)
│   │   └── Request Access button (if not enabled)
│   │
│   ├── Report
│   │   ├── Report list (multiple reports per project, language-specific)
│   │   ├── Update / generate report
│   │   ├── Published toggle
│   │   ├── Include portal link toggle
│   │   ├── Edit mode toggle
│   │   ├── Copy link / share
│   │   ├── Full report content (AI-generated Q&A/interview format)
│   │   ├── "Share your voice" CTA (links to participant portal)
│   │   ├── "X reading now" live indicator
│   │   └── Analytics (views count, timeline chart with milestones)
│   │
│   └── Host Guide (protected, separate full-page view)
│       ├── Drag-and-drop section reordering
│       ├── Live conversation tracking via QR code
│       ├── Add/remove sections
│       ├── Fullscreen & print modes
│       └── Real-time participant tracking
│
├── USER SETTINGS
│   ├── Account (profile info, email, delete account)
│   ├── Password management
│   ├── Two-factor authentication
│   ├── Appearance (font, font size)
│   ├── Whitelabel (custom logo upload)
│   ├── Legal basis selection
│   └── Audit logs viewer
│
└── PARTICIPANT PORTAL (separate app/router, public-facing via QR/link)
    │
    ├── Start / Onboarding (multi-slide carousel)
    │   ├── Slide 1: Consent & Privacy
    │   │   ├── Data controller info
    │   │   ├── How recordings are processed
    │   │   ├── Storage & deletion policy (EU servers, 30 day retention)
    │   │   └── Consent checkbox (required to proceed)
    │   │
    │   ├── Slide 2: Microphone Check
    │   │   ├── Microphone device selector
    │   │   ├── Live audio level meter
    │   │   └── Skip button
    │   │
    │   └── Slide 3: Ready to Begin
    │       ├── Session name input (required)
    │       ├── Tags selector (multi-select)
    │       └── "Next" button → initiates conversation
    │
    ├── Audio Conversation
    │   ├── Welcome message + pattern image
    │   ├── "Record" button (large, central)
    │   ├── Text mode toggle button (switch to text input)
    │   ├── Settings button (top-right)
    │   ├── Wake lock (screen stays on while recording)
    │   ├── S3 connectivity check (connection issue dialog if blocked)
    │   └── After 60+ seconds:
    │       ├── Refine options (explore / verify)
    │       └── Finish (skip to end)
    │
    ├── Text Conversation (alternative to audio)
    │   ├── Text area input ("Type your response here")
    │   ├── Submit button
    │   └── Microphone toggle (switch back to audio)
    │
    ├── Refine / Verify Flow
    │   ├── Refine Selection
    │   │   ├── "Make your contribution concrete" (verify option)
    │   │   └── "Get immediate reply" (explore option, if enabled)
    │   │
    │   ├── Verify Topic Selection
    │   │   └── Topic cards: Actions, Agreements, Disagreements, Gems, Moments, Truths, Custom
    │   │
    │   └── Verify Artifact Editor
    │       ├── AI-generated artifact (markdown preview)
    │       ├── Revise button (re-generate with verbal feedback, 30s cooldown)
    │       ├── Edit button (manual markdown editor)
    │       ├── Read Aloud button (audio playback)
    │       └── Approve button → saves artifact, returns to recording
    │
    ├── Finish Page
    │   ├── Thank you / completion message (customizable per project)
    │   ├── "Record another conversation" button
    │   └── Email notification signup (optional)
    │       ├── Email input + add button
    │       ├── Email list with remove
    │       ├── Privacy disclaimer
    │       └── Submit confirmation
    │
    ├── Public Report
    │   ├── Published report content (same as host report, read-only)
    │   ├── "X reading now" live indicator
    │   ├── "Contribute" portal link (if enabled)
    │   └── View tracking (anonymous)
    │
    └── Unsubscribe
        ├── Token-based verification
        ├── "Unsubscribe from Notifications" button
        └── Success/error messaging
```

---

## Screenshots Index

### AUTH FLOW

| File | Screen | Key Elements |
|------|--------|-------------|
| `01-login-page.png` | Login page (with credentials filled) | Email/password form, Login button, language picker, "Register as new user", "Forgot password?" link, Privacy Statements footer |

---

### HOME / PROJECTS LIST

| File | Screen | Key Elements |
|------|--------|-------------|
| `02-home-projects-list.png` | Home - Projects list (viewport) | "Home" heading, "Create" button, search bar, project cards with name/language/conversations/date/owner/pin |
| `02-home-projects-list-full.png` | Home - Projects list (full scroll) | Complete list of all projects |
| `03-home-user-menu-open.png` | Header user menu dropdown | Settings, Documentation, Feedback portal, Report an issue, Slack community, language picker, Logout |

---

### PROJECT OVERVIEW & SETTINGS

| File | Screen | Key Elements |
|------|--------|-------------|
| `04-project-overview.png` | Project overview (viewport) | Sidebar (Ask/Library/Report/Chats/Conversations), QR code, participation toggle, Project Settings tab (name, context, upload, export, webhooks, clone/delete) |
| `04-project-overview-full.png` | Project overview (full scroll) | All settings sections visible |
| `05-portal-editor.png` | Portal Editor tab (viewport) | Participant onboarding, conversation flow, verification, finish text settings |
| `05-portal-editor-full.png` | Portal Editor tab (full scroll) | All portal configuration options |

---

### CONVERSATION DETAIL

| File | Screen | Key Elements |
|------|--------|-------------|
| `06-conversation-detail.png` | Conversation overview tab (viewport) | Name + duration header, Overview/Transcript tabs, AI summary, Outcomes section, edit fields |
| `06-conversation-detail-full.png` | Conversation overview tab (full scroll) | Includes move-to-project, download audio, delete actions |
| `07-conversation-transcript.png` | Conversation transcript tab | Full transcript with timestamps and speaker labels |
| `21-conversation-with-artifacts.png` | Conversation with verified artifacts (collapsed) | 2 approved outcomes: "Breakthrough moments" and "What we think should happen" with approval dates |
| `22-conversation-artifacts-expanded.png` | Verified artifact expanded (viewport) | Full artifact content visible in accordion - rich markdown with headings, bold, structured argument |
| `22-conversation-artifacts-expanded-full.png` | Verified artifact expanded (full scroll) | Complete artifact text + edit conversation section below |

---

### SIDEBAR DEEP FEATURES

| File | Screen | Key Elements |
|------|--------|-------------|
| `18-sidebar-chats-expanded.png` | Sidebar with Chats accordion expanded | Chat list with titles, dates, per-chat action menus; Conversations accordion below with conversation checkboxes (for chat context selection) |
| `23-sidebar-conversation-filters.png` | Sidebar conversation filter options | Sort button, Tags filter, Verified filter, Reset to default - filter bar below search |

---

### ASK / CHAT

| File | Screen | Key Elements |
|------|--------|-------------|
| `11-ask-new-chat.png` | New chat mode selection | "What would you like to explore?" + 3 mode cards: Agentic (BETA), Specific Details, Overview (BETA) with example prompts |
| `19-chat-interface.png` | Active chat interface (viewport) | Chat title, system welcome, context indicator, user message, AI response (markdown with headings/sections), quick templates (Summarize, Compare & Contrast, Meeting Notes), text input |
| `19-chat-interface-full.png` | Active chat interface (full scroll) | Complete chat thread showing full AI analysis response with citations, section headings, follow-up Q&A |

---

### LIBRARY

| File | Screen | Key Elements |
|------|--------|-------------|
| `08-library.png` | Library page | "Request Access" button, "Create Library" disabled, "Your Views" with "Recurring Themes" template, access-gated alert |

---

### REPORT

| File | Screen | Key Elements |
|------|--------|-------------|
| `09-report.png` | Report page (viewport) | Report selector (3 reports), Published/portal link/edit mode toggles, AI-generated Q&A report content, "1 reading now" indicator |
| `09-report-full.png` | Report page (full scroll) | Complete report text + Analytics section (timeline chart, views count, milestones) |

---

### HOST GUIDE

| File | Screen | Key Elements |
|------|--------|-------------|
| `20-host-guide.png` | Host guide (viewport) | Full-page session management view with QR code, live participant tracking |
| `20-host-guide-full.png` | Host guide (full scroll) | Complete host guide with all sections |

---

### USER SETTINGS

| File | Screen | Key Elements |
|------|--------|-------------|
| `10-settings.png` | User settings (viewport) | Account-level settings |
| `10-settings-full.png` | User settings (full scroll) | Account info, password, 2FA, appearance (font/size), whitelabel logo, legal basis, audit logs |

---

### PARTICIPANT PORTAL

| File | Screen | Key Elements |
|------|--------|-------------|
| `12-participant-start.png` | Consent & privacy slide | Data controller info, storage/deletion policy, consent checkbox (unchecked), "I understand" button disabled |
| `12-participant-start-consent-checked.png` | Consent slide (checked) | Same as above with checkbox checked, "I understand" button now enabled |
| `13-participant-tutorial.png` | Microphone check slide | Microphone device selector, live audio level meter, "Skip" button, requesting mic access alert |
| `14-participant-ready.png` | "Ready to Begin?" slide | Session name input (required), tags multi-select, "Next" button |
| `15-participant-conversation-audio.png` | Audio conversation screen | Welcome heading + pattern image, "Record" button, text mode toggle, connection issue dialog (S3 check) |
| `15-participant-conversation-audio-clean.png` | Audio conversation screen (clean) | Same as above with connection dialog dismissed |
| `16-participant-conversation-text.png` | Text conversation screen | Text area ("Type your response here"), Submit button, microphone toggle to switch back to audio |
| `17-participant-report.png` | Participant-facing report (viewport) | Public report view - same content as host report, read-only, "Contribute" link |
| `17-participant-report-full.png` | Participant-facing report (full scroll) | Complete public report content |

---

## User Flow Diagrams

### Host Flow (authenticated)
```
Login
  └─> Home (Projects List)
        ├─> Create Project
        ├─> Settings (user account)
        └─> Select Project
              ├─> Project Overview
              │     ├─> Portal Editor tab (configure participant experience)
              │     └─> Project Settings tab (name, upload, export, webhooks, delete)
              ├─> Conversation Detail
              │     ├─> Overview (summary, artifacts, edit, move, delete)
              │     └─> Transcript (view, copy, download)
              ├─> Ask / Chat
              │     ├─> New Chat (pick mode: Agentic / Details / Overview)
              │     └─> Chat Interface (query conversations, get AI analysis)
              ├─> Library (create views, explore aspects)
              ├─> Report (generate, publish, share, analytics)
              └─> Host Guide (live session management with QR)
```

### Participant Flow (public, via QR code or link)
```
Scan QR / Open Link
  └─> Start / Onboarding
        ├─> Consent & Privacy (checkbox required)
        ├─> Microphone Check (skippable)
        └─> Ready to Begin (name + tags)
              └─> Conversation
                    ├─> Audio Mode (record button, wake lock)
                    │     └─> After 60s+:
                    │           ├─> Refine → Verify Flow
                    │           │     ├─> Pick topic (actions/agreements/gems/etc.)
                    │           │     ├─> AI generates artifact
                    │           │     └─> Revise / Edit / Approve
                    │           └─> Finish
                    └─> Text Mode (type + submit)
                          └─> Finish
                                ├─> Thank you message
                                ├─> "Record another" button
                                └─> Email signup (optional)

Public Report (separate URL, read-only)
Unsubscribe (email opt-out via token link)
```
