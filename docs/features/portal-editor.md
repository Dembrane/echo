---
title: The portal editor
description: Every setting a host has for the participant portal, page by page. Welcome, Privacy, About, Explore, Verify and Finish, with a live preview of each.
audience: host
---

# The portal editor

The portal editor decides what participants see and how their words are handled. Open
"Portal editor" in the project sidebar. It has its own menu with one page for each part of
the portal, in the order participants meet them: "Welcome", "Privacy", "About", "Explore",
"Verify" and "Finish".

Each page shows its options as rows, one open at a time. A closed row shows its current
value in one line. "Next" and "Back" move through them, and clicking a row opens it. Options
that only matter when another one is on (the name box's label, the custom title prompt, the
custom reply prompt) appear only then. The open page and option are in the address, so a
link or a reload opens the same option.

Changes save automatically, a second after you stop typing. Observers can look but not
change anything.

Next to the options, a phone shows the participant screen the open option changes, with
your changes before they are saved, and outlines the part that changes. Pick another screen
of the page above the phone. On a phone, "Preview" opens it under the options. Explore
replies and Verify drafts in the preview are made-up examples, labelled as such.

The project's key terms are set in "Brief", next to its name, goal and context. The Verify
page shows them read-only.

The QR code and the link are not in the editor. They are on the project's "Overview", in
the "Take part" card. See [recording](./recording.md).

## "Welcome"

| Setting | What it does |
|---|---|
| "Language" | The language the portal opens in, the hint given to transcription, and the language of summaries. The list has English, Dutch, German, Spanish, French, Italian, Ukrainian and Czech. |
| "Page title" | The heading on the recording screen. |
| "Page content" | Under the title on the recording screen, after the cards. Takes formatted text. |
| "Tutorial cards" | Which cards participants go through before they start: none (the default, privacy card only), "Basic" or "Advanced". |

## "Privacy"

"Legal basis" sets which privacy card participants get (see below). "Anonymize
transcripts" (Beta) replaces personal information in new transcripts with placeholders. It
also switches off audio playback, audio download and retranscription for those
conversations. Read [transcription](./transcription.md) before you switch it on. While it is
open, the preview shows a made-up excerpt before and after.

## "About"

| Setting | What it does |
|---|---|
| "Ask for name?" | Adds a name field to the start screen. Participants see it as "Session name" and must fill it in. On for a new project. |
| "What the name box asks for" | The label above that field, for example "Table name or number". Shown while "Ask for name?" is on. |
| "Tags" | Labels a participant can pick on the start screen. You can also assign them later, filter the conversation list by them and group the monitor by them. Drag tags to reorder them. |
| "Auto-generate titles" (Beta) | Gives each conversation a short title about its topic after it is summarised. The title describes what was discussed, not who took part. The participant's own name is kept separately. With this on, a conversation also gets up to three of the project's existing tags. |
| "Custom title prompt" | Guides those titles. Shown while "Auto-generate titles" is on. |
| "Ask for email?" | Adds an email sign-up to the thank you page. |

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

## "Explore"

"Explore" (Beta) lets participants ask for a reply from a language model during their
conversation. Switch on "Enable Explore", then choose a "Mode": "One question",
"Brainstorm ideas" or "Custom". "Custom" adds a "Reply prompt" where you describe the kind
of reply you want. "Cross-pollination" lets Explore bring in what other groups in the
project said. It is on by default; switch it off to keep each reply to the participant's own
conversation.

## "Verify"

"Verify" (Beta) lets participants approve an outcome that makes their contribution
concrete. Switch on "Enable Verify", then:

- tick the "Verify topics" participants may use. At least one must stay selected.
- under "Your own topics", use "Add topic" for a topic of your own, with a label, a prompt
  and an emoji.
- switch on "Remind users to verify before finishing" to ask participants who have not
  verified yet to verify or skip when they finish.

"Key terms" shows the project's key terms, which the drafts spell by, with a link to Brief
where you change them.

Both features become available to a participant after 60 seconds of recording.

## "Finish"

| Setting | Where participants see it |
|---|---|
| "Thank you page content" | After they finish |
| "Report notifications" | One switch, "Enable report notifications". It appears only when "Ask for email?" is on. With it on, the thank you page tells participants that they will only get a message when you generate a report. |
| "dembrane event invitation" | A card at the end of the thank you page that invites participants to run their own event with dembrane. The switch "Show the invitation" is on by default. |

"Page content" and "Thank you page content" take formatted text. In the thank you text you
can write `{{CONVERSATION_ID}}` and `{{PROJECT_ID}}`. They are replaced with the real
values, for example inside a link to a follow-up survey.

On the free plan the invitation cannot be switched off. The switch reads "Switching it off
comes with a paid plan."

## Related

- [The participant portal](./portal-and-participant-experience.md): what each setting looks
  like to a participant.
- [Recording](./recording.md): the QR code, the link and the host guide.
- [Transcription](./transcription.md): language, key terms and anonymisation in detail.
- [Projects](./projects.md): the settings that are not in the portal editor.
- [Data ownership and compliance](./data-ownership-and-compliance.md): the background to
  the legal basis.
- [The portal editor for hosts](../users/host/portal-editor.md): a walk through the editor.
