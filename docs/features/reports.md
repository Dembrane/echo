---
title: Reports
description: A report is one written article made from the conversations in a project. You can guide it, edit it, schedule it once, publish it on a public page and print it to PDF.
audience: host
---

# Reports

A report is a written article made from the conversations in a project. Open "Report" in the
project sidebar, press "Generate now", and come back when it is ready. You can then edit the
text, publish it on a public page and print it to PDF.

## Generate a report

1. Open "Report" in the sidebar, or "Report" under "Jump to" on the project "Overview".
2. Press "Generate now". For a later report, press "Create report".
3. Choose a "Language": Dutch, English, German, French, Italian, Spanish, Ukrainian or Czech.
4. Optional: under "Guide the report", select up to 2 focus areas.

The focus areas are "Focus on the process", "Focus on outcomes", "Identify key themes",
"Extract recommendations", "Summarize sentiment", "Agreements & disagreements" and "Or write
your own".

That is all there is to choose. You cannot pick conversations, a template, a type or a
length. The form tells you "{n} conversations will be included in your report".

While it works, the page says "Generating your report..." and "You can navigate away and
come back later. Your report will continue generating in the background." "Cancel" stops it.
When it is done, the person who started it gets the Inbox notification "Your report is
ready". No email goes to the host.

Good to know:

- A project generates one report at a time: "Report already generating".
- You need at least one conversation with content. Otherwise the buttons say "Add
  conversations to your project first".
- Every generation is a new report in the "Reports" list. Nothing is regenerated in place.
- "Create report" shows the hint "New conversations added since this report" when a newer
  conversation exists.

## What a report contains

One article in the language you chose, written as questions and answers: an introduction,
between 2 and 15 question and answer pairs, and a conclusion.

A report uses every conversation that has content. A conversation without a summary is
summarised first.

> [!IMPORTANT]
> A report has a fixed reading budget. It takes conversations in order of their latest
> update, newest first. It adds their summaries until the budget is full, then full
> transcripts while they still fit. In a large project the report is therefore written from
> summaries, and the conversations updated longest ago are left out. The report does not
> say which ones.

A language model writes the report. Read it against the conversations before you share it.

## Edit and manage

- "Edit mode" lets you change the text. It saves while you type.
- The "Reports" list marks each report: "Published", "Scheduled", "Generating", "Latest",
  "Guided" or "Archived". "Latest" is the newest finished report. "Guided" marks an older
  report that was made with "Guide the report" filled in.
- "Copy report content" copies the text.
- "Delete report" removes it. This cannot be undone.

## Schedule a report (Beta)

Press "Schedule" and choose a "Date" and a "Time". A schedule runs once. There is no
recurring schedule.

- The time must be at least 10 minutes ahead. "The report may start up to 5 minutes after
  the chosen time."
- You can schedule before any conversation exists: "No conversations yet. You can schedule a
  report now and conversations will be included once they are added."
- A scheduled report shows "Report scheduled" with "Generate now", "Reschedule" and "Cancel
  schedule". You cannot reschedule within 10 minutes of the scheduled time.
- When the report is ready, read it, and switch "Public page" on if you want to share it.

## Publish and share

Press "Share" and switch "Public page" on: "Anyone with the link can read it. No login, and
no transcripts." Switching it off takes the report back.

- A project has one published report at a time. Publishing a report unpublishes the one
  before it.
- The link belongs to the project, not to one report. The same link always shows the report
  that is published now.
- While the page is public, "Share" offers a QR code, "Copy link", "Open link", "Download QR
  code" and "Download as PDF".
- "Download as PDF" opens the public page with your browser's print window. Save as PDF from
  there. dembrane does not make a PDF file itself.
- "Include portal link" adds an invitation at the end of the report: "The report ends with
  an invitation to add your voice."

The public page needs no sign-in and no paid plan. With nothing published it says "This
report is not yet available." It can show "{n} reading now", which counts the last 10
minutes.

## The email to participants

Participants can leave an email address at the end of their recording. When you publish,
they get an email.

1. In the [portal editor](./portal-editor.md), switch on "Ask for email?". The participant's
   finish screen then asks "Do you want to stay in the loop?".
2. Publish a report. Before anything is sent, you confirm: "An email notification will be
   sent to {n} participants. Do you want to proceed?" This is the one place where you see
   the number.
3. Each participant gets an email with the subject "A report featuring your input is ready"
   and a "View report" button, in the report's language. Every email has an unsubscribe
   link.

Emails go out when a report changes from not published to published. Editing a published
report sends nothing.

The portal editor also has "Enable report notifications", offered only when "Ask for
email?" is on. With it on, the finish screen adds this line: "We will only send you a
message if your host generates a report, we never share your details with anyone. You can
opt out at any time."

## Analytics

In the dashboard, under the report, "Analytics" shows "This report was opened by {n} people"
and a chart of "Conversations" and "Views" per day, with the markers "Project created",
"Report created" and "Report updated". A view counts once per browser, per report, per 24
hours.

## Who can do what

| Action | Admin | Member | External | Observer |
|---|---|---|---|---|
| Read reports | Yes | Yes | Yes | Yes |
| Generate or schedule a report | Yes | Yes | Yes | No |
| Edit the text, switch "Include portal link", unpublish | Yes | Yes | Yes | No |
| Publish, cancel a schedule | Yes | Yes | No | No |
| Delete a report | Yes | No | No | No |

The billing role has no access to projects. See
[roles & permissions](./roles-and-permissions.md).

Reports need no paid plan. On the Free plan a workspace has one report: "Your free plan
includes one report. Upgrade to create more." See [tiers & billing](./tiers-and-billing.md).

A finished report can also trigger a webhook, "Report generated". Webhooks are set up under
"Automation" (Beta) by a workspace admin and need the Changemaker plan or higher. See
[webhooks & integrations](./webhooks-and-integrations.md).

## Related

- [Chat & Ask](./chat-and-ask.md): ask your own questions before you write.
- [Present](./present.md): show results to a room on a screen.
- [The portal editor](./portal-editor.md): where "Ask for email?" lives.
- [Export & data portability](./export-and-data-portability.md): get the transcripts out.
- [Your report](../users/participant/your-report.md): what a participant sees.
- [Reports for hosts](../users/host/reports.md): the walkthrough.
