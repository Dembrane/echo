---
title: dembrane Go (the mobile app)
description: The native iOS recorder for facilitators - local-first chunked recording, background capture, conversations, chat, and portal settings on the go.
audience: host
---

# dembrane Go (the mobile app)

dembrane Go is the native iOS app for the person in the room - walking a venue, moving between
tables, recording conversation after conversation on a phone. It records *locally first*, keeps
going in the background, and uploads to the same project you'd see on the
[dashboard](./projects.md). On background-recording resilience it's actually *ahead* of the web.

You sign in with your email and password (two-factor supported), into the same workspaces and
projects as the web. What you can do still follows your
[workspace role](./roles-and-permissions.md), and recording counts towards your
[metered hours](./tiers-and-billing.md).

## What it does

*Records, robustly.* Audio is captured to the device and uploaded as it goes, so a recording
survives a crash or the app being killed - the audio is already on disk. It keeps recording in
the background while you do other things, a Live Activity / Dynamic Island indicator shows a
recording in progress without the app open, and a live waveform plus mic selector let you
confirm audio and pick the input (e.g. an external mic). You can also import an existing audio
file instead of recording live.

*Read and manage conversations.* Open one to read its
[transcript and summary](./conversations-and-transcripts.md), generate a title, manage tags,
edit, move, delete, and re-transcribe - the day-to-day actions, on mobile.

*Ask questions.* [Ask across your conversations](./chat-and-ask.md) from the phone, with
templates, history, sources, and a picker for which conversations a question draws on. Plus
fast on-device search to find one without scrolling.

*Edit portal essentials.* Adjust the project's title, description and key terms in
[the portal](./portal-editor.md), and share the *QR code* off your screen so a participant can
scan straight away.

*Account.* Switch the active project, sign out, and start account deletion (which completes in
the browser).

## When to use Go vs the web

| Reach for dembrane Go when… | Reach for the web when… |
|---|---|
| You're recording in person and on the move | You're sitting down to analyse |
| Connectivity is shaky and you can't lose audio | You need the full analysis surface |
| You want hands-free background capture | You're building reports or a custom library |
| You want to share a QR code off your screen | You're setting up a project or managing people |

## What's web-only

Go is a focused recorder-and-reader, not the whole dashboard. These live on the web:

- [Library & analysis](./library-and-analysis.md) - extracted topics, aspects and quotes.
- [Reports](./reports.md) - the multi-section report builder.
- The full participant [verification](./portal-editor.md) configuration (Go does the host-side
  essentials).
- Project creation, and all workspace / organisation / team management.
- Billing detail, webhooks, export, and the host guide PDF.

> [!TIP]
> A common pattern: collect on dembrane Go in the room, then switch to the
> [dashboard](./projects.md) afterwards to build the [library](./library-and-analysis.md) and
> [report](./reports.md). They share the same data - what you recorded on the phone is already
> in the project on the web, nothing to sync.

## Related

- [Recording](./recording.md) - the capture mechanics dembrane Go shares with the web.
- [Conversations & transcripts](./conversations-and-transcripts.md) - what you read and manage
  in the app.
- [Chat & Ask](./chat-and-ask.md) - asking questions of your conversations from the phone.
- [The portal editor](./portal-editor.md) - the portal settings you can edit on the go.
