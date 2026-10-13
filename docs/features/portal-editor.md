---
title: The portal editor
description: Every setting a host has for the participant portal. Language, name and email, legal basis, tutorial, tags, Explore and Verify, portal texts, key terms, anonymisation and titles.
audience: host
---

# The portal editor

The portal editor decides what participants see and how their words are handled. Open
"Portal editor" in the project sidebar. Changes save automatically. Observers can look but
not change anything.

"Show preview" opens a live preview of the real start page. Press "Refresh" in the preview
to see your latest changes.

The QR code and the link are not in the editor. They are on the project's "Overview", in
the "Take part" card. See [recording](./recording.md).

## "Basic settings"

| Setting | What it does |
|---|---|
| "Language" | The language the portal opens in, the hint given to transcription, and the language of summaries. The list has English, Dutch, German, Spanish, French, Italian, Ukrainian and Czech. |
| "Ask for name?" | Adds a name field to the start screen. Participants see it as "Session name" and must fill it in. On for a new project. |
| "Ask for email?" | Adds an email sign-up to the thank you page. |
| "Legal basis" | Which privacy card participants get. See below. |
| "Select tutorial" | Which cards participants go through before they start: none (the default, privacy card only), "Basic" or "Advanced". |
| "Tags" | Labels a participant can pick on the start screen. You can also assign them later, filter the conversation list by them and group the monitor by them. Drag tags to reorder them. |

Deleting a tag also removes it from the conversations that have it.

## Legal basis

"Legal basis" sets the GDPR legal basis under which personal data is processed for the
project. It changes the privacy card participants see before they record.

| Option | What it means |
|---|---|
| "Client-managed" | Your organisation is responsible for how the data is used, and dembrane processes it on your behalf. The privacy card says so and has one button. This applies when nothing else is set. |
| "Consent" | Participants must tick "I consent to my conversation being recorded and processed." before they can continue, and they get a link to your privacy policy. You must fill in "Privacy policy URL", or the option cannot be saved. |
| "dembrane events" | dembrane itself records and analyses the conversation, on the basis of its legitimate interest. It is only offered to accounts with a dembrane.com email address. |

How it is set:

- Only workspace admins and owners can change it.
- A workspace has a default, in the workspace settings. A project follows that default
  until you choose "Override for this project". "Remove override" goes back to the default.
- A badge shows where the current value comes from: "Overridden for this project",
  "Workspace default", "Account default" or "No default set (client-managed applies)".

> [!IMPORTANT]
> Only change this setting in consultation with the person responsible for data protection
> in your organisation. The editor shows the same warning.

## "Participant features"

"Explore" (Beta) lets participants ask for a reply from a language model during their
conversation. Switch on "Enable Explore", then choose a "Mode": "Default", "Brainstorm
ideas" or "Custom". "Custom" adds a "Reply prompt" where you describe the kind of reply you
want.

"Verify" (Beta) lets participants approve an outcome that makes their contribution
concrete. Switch on "Enable Verify", then:

- tick the "Verify topics" participants may use. There are six built-in topics, such as
  "What we actually agreed on" and "Hidden gems". At least one must stay selected.
- use "Add topic" for a topic of your own, with a label, a prompt and an emoji.
- switch on "Remind users to verify before finishing" to ask participants who have not
  verified yet to verify or skip when they finish.

Both features become available to a participant after 60 seconds of recording.

"Report notifications" has one switch, "Enable report notifications". It appears only when
"Ask for email?" is on. With it on, the thank you page tells participants that they will
only get a message when you generate a report.

## "Portal content"

| Setting | Where participants see it |
|---|---|
| "Page title" | The heading on the recording screen |
| "Page content" | Under the title on the recording screen, after the cards |
| "Thank you page content" | After they finish |
| "dembrane event invitation" | A card at the end of the thank you page that invites participants to run their own event with dembrane. The switch "Show the invitation" is on by default. |

"Page content" and "Thank you page content" take formatted text. In the thank you text you
can write `{{CONVERSATION_ID}}` and `{{PROJECT_ID}}`. They are replaced with the real
values, for example inside a link to a follow-up survey.

On the free plan the invitation cannot be switched off. The switch reads "Switching it off
comes with a paid plan."

## "Advanced settings"

- "Key terms": the names and words transcription should spell right. See
  [transcription](./transcription.md).
- "Anonymize transcripts" (Beta): replaces personal information in new transcripts with
  placeholders. It also switches off audio playback, audio download and retranscription for
  those conversations. Read [transcription](./transcription.md) before you switch it on.
- "Auto-generate titles" (Beta): gives each conversation a short title about its topic
  after it is summarised. The title describes what was discussed, not who took part. The
  participant's own name is kept separately. A "Custom title prompt" lets you guide the
  titles. With this on, a conversation also gets up to three of the project's existing tags.

## Related

- [The participant portal](./portal-and-participant-experience.md): what each setting looks
  like to a participant.
- [Recording](./recording.md): the QR code, the link and the host guide.
- [Transcription](./transcription.md): language, key terms and anonymisation in detail.
- [Projects](./projects.md): the settings that are not in the portal editor.
- [Data ownership and compliance](./data-ownership-and-compliance.md): the background to
  the legal basis.
- [The portal editor for hosts](../users/host/portal-editor.md): a walk through the editor.
