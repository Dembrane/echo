---
title: Transcripts & conversations
description: Find, read and tidy what you collected. Statuses, search and filters, the conversation page, editing, tags, retranscribing, moving, deleting and downloading.
audience: host
---

# Transcripts & conversations

Every recording and every upload becomes a conversation with a transcript and a summary. You
find them in two places: the short list on the project's "Overview", and the full list under
"Conversations" in the project sidebar.

## When the text appears

The portal sends audio in pieces of 30 seconds, and dembrane transcribes each piece as it
arrives. While that work runs, "Conversations" in the sidebar shows a progress ring with the
number of conversations recording or the number of parts still to transcribe. When it ends
you see "Transcription done", or "Transcription failed" when a conversation could not be
transcribed.

The summary is written when the conversation is finished: when the participant presses
"Finish", or when no new audio has arrived for five minutes. If audio arrives after that, the
conversation opens again and is summarised again.

## What the statuses mean

On "Overview", each conversation has one status.

| Status | Meaning |
|---|---|
| "Live" | A portal conversation that is not finished and sent something in the last 30 seconds. |
| "Transcription error" | At least one piece of audio could not be transcribed. |
| "Empty" | No audio has arrived. Normal in the first half minute of a recording. |
| "Transcribing" | Audio has arrived and dembrane is still working on it. |
| "Verified" | The participant approved at least one outcome. |
| "Done" | Ready to read. |

On the "Conversations" page a row can carry several badges at once.

| Badge | Meaning |
|---|---|
| "Ongoing" | The same as "Live" above. |
| "Upload" | You uploaded this file in the dashboard. |
| "Text" | Everything in it was typed. |
| A time, such as 12:40 | The length of the audio. |
| "Transcription error" | At least one piece failed. Open the conversation to see which. |
| A seal | It has approved outcomes. |
| A detective | It is anonymised. |

On the conversation's own page you can also meet "Empty" (the conversation is finished and
has no text) and "Locked" (the free plan's hour is used). Both are explained in
[troubleshooting transcripts and summaries](./troubleshooting-transcripts-and-summaries.md).

## Find a conversation

On the "Conversations" page:

- "Search" looks in the title, the participant's name and email, and the summary. It does not
  look inside transcripts.
- "Sort" orders by date, name or length.
- "Tags" and the "Verified" switch narrow the list. "Reset filters" clears them.

To search inside transcripts, use "Search" in the sidebar, or press Ctrl K (⌘K on a Mac). It
searches project names, conversations, transcript text and chats in everything you can open.

A conversation is listed under its generated title when it has one, otherwise under the name
the participant entered, otherwise as "Untitled conversation".

## Read a conversation

Open one to see, from top to bottom:

- The title, the participant's name, the start date and time, and the tags.
- "Summary": written by a language model. Copy it, or press "Regenerate summary" for a new
  one. That replaces the current summary.
- "Outcomes": what the participant approved, when your portal uses Verify.
- "Transcript": one block for each piece of audio, with its clock time. "Show audio player"
  puts a player under each block, so you can check a passage against the recording.
- At the bottom: "Move to another project", "Download audio" and "Delete conversation".

A summary is a place to start. When a point matters, read the transcript.

## Edit a conversation

Press "Manage" on a row to open "Edit conversation". You can change the "Name", the "Title",
the "Tags" and the "Summary". Changes save by themselves.

You cannot edit the text of a transcript. To get a better transcript, add key terms and
retranscribe.

### Tags

Create tags in the [portal editor](./portal-editor.md) first, then assign them here. A
conversation gets tags in three ways: the participant picks them on the start screen, you
assign them in "Edit conversation", or dembrane assigns up to three when "Auto-generate
titles" is on.

### Retranscribe

The circular arrow next to the "Transcript" heading, "Retranscribe conversation" (Beta),
makes a new conversation from the same audio with a fresh transcript. The original stays as
it is. Add your key terms first. The steps are in
[troubleshooting transcripts and summaries](./troubleshooting-transcripts-and-summaries.md).

## Ask about a selection

"Select conversations" puts a tick box on each row. Tick the ones you want and press "Ask
about these" to start a chat about them. That is the only thing you can do with a selection:
moving and deleting go one conversation at a time. See [chat and Ask](./chat-and-ask.md).

## Move or delete

- "Move to another project" sends one conversation to another project you can edit. Its tags,
  chats and outcomes stay with it. A conversation cannot move into or out of a workspace you
  run for an external client.
- "Delete conversation" cannot be undone. Admins and members can delete. The conversation
  leaves every list.

> [!NOTE]
> Deleting does not give hours back. A deleted conversation still counts toward the free
> plan's hour, and stays in the project's usage under "Deleted".

## Download

| What | Where | You get |
|---|---|---|
| One transcript | "Download transcript" on the conversation page | A Markdown file |
| All transcripts of a project | "Manage", "Export", "Download all transcripts" | A zip with one Markdown file for each conversation that has text |
| The audio of one conversation | "Download audio" | One MP3. Not for anonymised, typed or locked conversations |

There is no spreadsheet export. More in
[export and data portability](../../features/export-and-data-portability.md).

## Anonymised and locked conversations

- An anonymised conversation has personal details replaced in the transcript. You cannot play
  or download its audio, and you cannot retranscribe it.
- A locked conversation was finished after a free workspace used its hour of audio. Its
  transcript and summary are hidden until the workspace is on a paid plan. See
  [tiers, billing and usage](./tiers-billing-and-usage.md).

## After a session

1. Skim the list and delete the test recordings.
2. Open anything marked "Transcription error" or "Empty".
3. Retranscribe what reads badly, after adding key terms.
4. Tag the conversations the way you want to compare them later.
5. Go on to [Ask](./chat-and-ask.md) or a [report](./reports.md).

## Related

- [Troubleshooting transcripts and summaries](./troubleshooting-transcripts-and-summaries.md): wrong, missing or locked text.
- [Collecting conversations](./collecting-conversations.md): how conversations come in.
- [Setting up the portal](./portal-editor.md): key terms, tags, anonymisation and titles.
- [Conversations & transcripts](../../features/conversations-and-transcripts.md): the feature reference.
- [Transcription](../../features/transcription.md): how audio becomes text.
- [Export and data portability](../../features/export-and-data-portability.md): every way to take data out.
