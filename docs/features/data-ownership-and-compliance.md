---
title: Data ownership & compliance
description: Who owns the conversations in a workspace, the legal basis of a project and what participants are told, anonymisation, who at dembrane can reach your data, and requests about personal data.
audience: all
---

# Data ownership & compliance

Three settings carry most of the answers a privacy officer asks for: who owns the data in a
workspace, the legal basis of each project, and whether transcripts are anonymised. This
page also covers who at dembrane can reach your data and how personal data requests work.

dembrane is ISO 27001 certified.

## Who owns the data in a workspace

A workspace is one of two things:

- "For internal use". The work is your organisation's own.
- "For an external organisation". You run the work for a client. You name the "Owning
  organisation" and a "Data owner email". dembrane invites that person as a free observer,
  so the data owner can look along.

You choose this when you create the workspace. An admin of the workspace's organisation can
change it later under "Data ownership" in workspace settings. The choice also decides how
the workspace is billed. See [the partner program](./partner-program.md).

## Legal basis

Each project has a legal basis. It decides what a participant is told before they record.
You find it in the [portal editor](./portal-editor.md) under "Basic settings": "Determines
under which GDPR legal basis personal data is processed for this project."

| Legal basis | What the participant sees |
|---|---|
| "Client-managed" | A card titled "Data controller, usage and security." with the text "The organiser is responsible for how your data is used in this session. dembrane processes your conversation on their behalf." They continue with "I understand". There is no checkbox |
| "Consent" | The same card, a checkbox they must tick ("I consent to my conversation being recorded and processed.") and the link "Read the organiser's privacy policy". You must enter a "Privacy policy URL" before you can save this choice |
| "dembrane events" | "dembrane records and analyses this conversation based on our legitimate interest: to capture discussions accurately, deliver reliable insights, and develop our platform." Only accounts with a dembrane.com address can choose this |

- A project uses its own setting if it has one, and otherwise the workspace's default. The
  editor shows which applies: "Overridden for this project", "Workspace default", "Account
  default" or "No default set (client-managed applies)".
- The workspace default is in workspace settings, "General".
- Only workspace admins can change it: "Only workspace admins can change the legal basis."
- dembrane warns you on the card: "Only change this setting in consultation with the
  responsible person(s) for data protection within your organisation."

## Anonymisation

"Anonymize transcripts" (Beta) is a switch in the portal editor under "Advanced settings".
When it is on, personal data in new transcripts is replaced with placeholders such as
`<redacted_name>`, `<redacted_email>` and `<redacted_phone>`.

- It works in two passes. Fixed patterns come first: email addresses, IBANs, phone numbers,
  Dutch postcodes and numbers of 8 or 9 digits. Then a language model goes over the audio
  and the transcript and replaces personal data it finds.
- Names you listed as key terms are replaced too.
- Replies from Explore and outcomes from Verify are held to the same rule.
- The participant is told: "This transcript will be anonymized and your host will not be
  able to listen to your recording."
- In the dashboard the conversation is marked "Anonymized conversation". Playing the audio,
  downloading the audio and retranscribing are switched off for it. The editor says this
  "cannot be undone for already-processed conversations."

See [transcription](./transcription.md) for the rest of the pipeline.

## Where language models run

Transcription and dembrane's other language model features use Gemini models on Google
Vertex AI. That is the only model provider. The hosted service calls it through the EU data
residency endpoint of Vertex AI.

## Who at dembrane can reach your data

By default dembrane staff cannot read your projects. A workspace admin can let them in for
support, with a switch or by approving a request. Each visit ends after 24 hours and every
step is listed for you under "Access history". See
[staff support access](./staff-support-access.md).

## Agreements

The data processing agreement is its own document. It comes with your offer and you sign it
in the dashboard, next to the offer. An offer fixes the versions of the terms, the service
level agreement and the data processing agreement that were in force when it was sent. With
the offer, dembrane also asks whether you need your own data protection impact assessment.
See [offers & invoices](./offers-and-invoices.md).

## Requests about your own data

The dashboard has no button to delete your account or to download everything about you.
Both are requests to dembrane, and dembrane records each one it carries out.

- A copy of your data: dembrane staff export what is tied to you as one file. It holds your
  account, memberships, projects, conversations, chats, signatures, documents and activity.
  You get a download link that works for 7 days.
- Erasure: dembrane staff remove your account, your memberships, your private chats and the
  assistants you connected. Some things stay, without your name on them: chats you shared,
  projects you created, and activity records, which keep only an internal id. Signatures
  you placed on documents and conversations you took part in also stay.
- If you are the last admin of an organisation that is still in use, the erasure stops
  until dembrane staff confirm it explicitly.

To take the conversations of a project with you, see
[export & data portability](./export-and-data-portability.md).

## Related

- [The partner program](./partner-program.md): workspaces for an external organisation.
- [Staff support access](./staff-support-access.md): how you let dembrane staff in.
- [Portal editor](./portal-editor.md): where legal basis and anonymisation are set.
- [Transcription](./transcription.md): how audio becomes a transcript.
- [Offers & invoices](./offers-and-invoices.md): signing the data processing agreement.
- [Your privacy and data](../users/participant/your-privacy-and-data.md): the same questions from a participant's side.
