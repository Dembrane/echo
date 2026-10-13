---
title: Setting up the portal
description: Every setting of the portal editor in the order you see it. Language, name and email, legal basis, tutorial, tags, Explore, Verify, the texts participants read, key terms, anonymisation and titles.
audience: host
---

# Setting up the portal

The portal editor decides what participants see and what happens to their recording. Open
"Portal editor" in the project sidebar. Your changes save by themselves. For a first session,
three things are worth five minutes: the "Language", the "Page title" with its "Page content",
and the "Key terms".

"Show preview" opens a "Live preview" of the real start page next to the settings. Press
"Refresh" in the preview to see your latest changes. The QR code and the link are not here.
They are on the project's "Overview", in the "Take part" card.

With the "Observer" role you can read the settings and not change them.

## "Basic settings"

### "Language"

Choose from English, Dutch, German, Spanish, French, Italian, Ukrainian and Czech.

- It is the language the portal opens in, and the language of summaries and generated titles.
- The language is part of the share link and of the QR code. If you change it, share the link
  again: a code you printed earlier still opens the portal in the old language.
- For transcription it is a hint. dembrane writes down what is spoken, also when people
  switch language, and uses the hint when the audio leaves room for doubt.
- A Ukrainian or Czech portal shows the tutorial and privacy cards in English.

### "Ask for name?" and "Ask for email?"

"Ask for name?" is on in a new project. A participant then has to fill in "Session name"
before recording. Tell people what to enter: a table number or a group name works as well as
a person's name. With the name off and no tags, the portal has nothing to ask and starts the
conversation right after the cards.

With "Ask for email?" on, the thank you page asks "Do you want to stay in the loop?" and
people can leave one or more addresses. You see them in "Edit conversation" under
"Participant email", behind "Show".

### "Legal basis"

This sets the legal basis under the GDPR for the personal data in this project, and with it
the privacy card.

| Value | What participants see |
|---|---|
| "Client-managed" | A card that says the organiser is responsible for how the data is used, with the button "I understand". |
| "Consent" | The same card, with a tick box "I consent to my conversation being recorded and processed." and a link to your privacy policy. Nobody can continue without ticking it. |

A project uses the workspace's default unless a workspace admin presses "Override for this
project". With no default anywhere, "Client-managed" applies. "Consent" needs a "Privacy
policy URL". Only workspace admins can change the legal basis, and the editor adds a warning
worth following: "Only change this setting in consultation with the responsible person(s) for
data protection within your organisation." More in
[data ownership and compliance](../../features/data-ownership-and-compliance.md).

### "Select tutorial"

| Option | Participants see |
|---|---|
| No tutorial (the default) | The privacy card only. |
| "Basic (essential tutorial slides)" | Six short cards about dembrane and how to take part, then the privacy card. |
| "Advanced (tips and best practices)" | The basic cards and the privacy card, then three tips: "Reduce background noise", "Strong internet connection" and "Don't lock your device!". |

For a room of first-time users, "Advanced" says what you would otherwise have to say
yourself.

### "Tags"

Type a tag and press "Add tag". Separate several with commas to add them in one go. Drag tags
to put them in order. Participants pick from them on the start screen, and you can filter the
conversation list and group the Monitor by tag. A tag for each table or each session is a
good start.

Deleting a tag removes it from the conversations that carry it.

## "Participant features"

### "Explore" (Beta)

Switch on "Enable Explore" and participants get a button labelled "ECHO" while they record.
After 60 seconds of recording they can ask dembrane for a written reply that helps them go
deeper. A language model writes it from what they said so far, your project context and
summaries of the project's other conversations. Recording continues in the meantime. After a
reply, Explore is unavailable for 2 minutes.

"Mode" sets the kind of reply: "Default", "Brainstorm ideas" or "Custom". "Custom" adds a
"Reply prompt" in which you describe the reply you want.

### "Verify" (Beta)

Switch on "Enable Verify" and participants can turn what they said into a short written
outcome, revise it and approve it. It sits behind the same "ECHO" button.

- "Verify topics": tick the topics participants can choose from. At least one stays ticked.
  The built-in topics are "What we actually agreed on", "Hidden gems", "Painful truths",
  "Breakthrough moments", "What we think should happen" and "Moments we agreed to disagree".
- "Add topic" makes a topic of your own, with a label and a prompt for the language model.
- "Remind users to verify before finishing" asks people who have not verified yet to verify
  or skip when they press "Finish".

You see approved outcomes only. They are on the conversation's page under "Outcomes", and
dembrane uses them when it writes the summary. The participant's side is in
[refining and verifying](../participant/refining-and-verifying.md).

### "Report notifications"

"Enable report notifications" appears when "Ask for email?" is on. With it on, the thank you
page tells participants they only get a message when you make a report, and that they can opt
out. The email itself goes out when you publish a report. See [reports](./reports.md).

## "Portal content"

| Setting | Where participants see it |
|---|---|
| "Page title" | At the top of the recording screen. |
| "Page content" | Under the title, for as long as they record. You can format the text. |
| "Thank you page content" | After "Finish". Left empty, the page says "Thank you for participating!". |
| "dembrane event invitation" | A card at the end of the thank you page that invites participants to run their own event with dembrane. |

Put your question in "Page content". It stays on the screen while people talk, and dembrane
reads the title and the content when it writes summaries.

In the thank you text, `{{CONVERSATION_ID}}` and `{{PROJECT_ID}}` are replaced by the real
values. That helps when you link to a follow-up form.

"Show the invitation" is on by default. On the free plan you cannot switch it off: "Switching
it off comes with a paid plan."

## "Advanced settings"

### "Key terms"

The names, places, organisations and jargon you expect to hear. Press Enter after each term.
Key terms tell transcription how to spell words it does not know, and they also reach
summaries and Explore replies. Fill them in before the session: they apply to audio
transcribed from then on.

### "Anonymize transcripts" (Beta)

With "Enable transcript anonymization" on, new transcripts have personal information (names,
emails, phone numbers, addresses) replaced with placeholders such as `<redacted_name>`.

- For an anonymised conversation you cannot play the audio, download the audio or
  retranscribe.
- Participants are told on the recording screen that the transcript is anonymised and that
  the host cannot listen to the recording.
- Names you listed as key terms are replaced too.
- It cannot be undone for conversations that were already processed. Switch it on before the
  session starts.

### "Auto-generate titles" (Beta)

Gives each conversation a short title about its topic once the summary is written. The name
the participant entered is kept separately. With the switch on, dembrane also gives the
conversation up to three of the project's existing tags. "Custom title prompt" lets you steer
how titles are written.

## A good first setup

1. Set the "Language" to the one people will speak.
2. Write a "Page title" and put your question in "Page content".
3. Add your "Key terms".
4. Leave "Ask for name?" on and tell people what to enter.
5. Add a tag for each table or session if you want to compare them later.
6. Open the preview, read it as a participant would, then share the code from "Overview".

## Related

- [Collecting conversations](./collecting-conversations.md): sharing the portal and briefing participants.
- [Creating a project](./creating-a-project.md): the settings a new project starts with.
- [Transcripts & conversations](./transcripts-and-conversations.md): tags, titles and outcomes in the dashboard.
- [The portal editor](../../features/portal-editor.md): the feature reference.
- [The participant portal](../../features/portal-and-participant-experience.md): what participants go through.
- [Data ownership and compliance](../../features/data-ownership-and-compliance.md): legal basis and anonymisation.
