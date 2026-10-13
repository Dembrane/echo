---
title: Conversations & transcripts
description: Find, read, summarise, edit, move, download and delete the conversations in a project, and what each status and badge means.
audience: host
---

# Conversations & transcripts

A conversation is one recording, one uploaded audio file, or one set of typed answers from
the portal. Open "Conversations" in the project sidebar to see them all. Open one to read
its summary and transcript.

Anyone who can open the project can read its conversations. Editing needs the role owner,
admin, member or external. Deleting needs owner, admin or member. See
[roles and permissions](./roles-and-permissions.md).

## The list

| Control | What it does |
|---|---|
| "Search" | Matches every word you type against the participant name, participant email, title and summary. It does not search transcript text. |
| "Sort" | "Newest first", "Oldest first", "Name A-Z", "Name Z-A", "Longest first", "Shortest first" |
| "Tags" and "Verified" | Filter by tag, or show only conversations with an approved outcome. "Reset filters" clears them. |
| "Select conversations" | Tick conversations, then "Ask about these" starts a chat on them. That is the only action on a selection. |
| "Upload" | Add audio files. See [recording](./recording.md). |

To search transcript text across all your projects, use "Search" in the sidebar.

A conversation's title is the generated title if there is one, else the participant's
name, else "Untitled conversation".

## Badges and statuses

On the "Conversations" page a row can carry several badges:

| Badge | Meaning |
|---|---|
| "Ongoing" | A portal conversation that is not finished and got audio or text in the last 30 seconds |
| "Upload" | It came from an upload in the dashboard |
| "Text" | Every piece was typed |
| A duration | The length of the audio, once it is known |
| "Transcription error" | At least one piece could not be transcribed |
| Seal icon | It has at least one approved outcome |
| Detective icon | It is anonymised |

The "Conversations" list on the project's "Overview" shows one status per row instead:
"Live", "Transcription error", "Empty", "Transcribing", "Verified" or "Done". "Live" is the
same as "Ongoing". "Empty" means no piece has arrived at all.

On a conversation page, "Locked" means the free plan's one hour is used and the transcript
and summary are hidden. See [recording](./recording.md).

## A conversation page

- The header shows the title, the participant's name, the start date and time, and tags.
- "Summary" is written automatically when the conversation is finished, in the project
  language. Copy it, or choose "Regenerate summary" to replace it.
- "Outcomes" lists what the participant approved with Verify. Drafts they never approved are
  not shown.
- "Transcript" shows one block per piece with its clock time. The icons above it are
  "Download transcript", copy and retranscribe. "Show audio player" adds a player under each
  piece.
- At the bottom: "Move to another project", "Download audio" and "Delete conversation".

A transcript downloads as a Markdown file. There is no PDF download.

## Edit a conversation

"Manage" on a row opens "Edit conversation". You can change "Name", "Title", "Tags" and
"Summary". Changes save automatically. To add a tag that does not exist yet, create it
first in the [portal editor](./portal-editor.md).

The transcript text itself cannot be edited. The way to change it is to
[retranscribe](./transcription.md).

If participants left an email address on the thank you page, it is in "Edit conversation"
under "Participant email", behind "Show".

## Summaries and titles

- A summary is made from the transcript, the project name and context, the key terms, the
  portal's title and content, and any approved outcomes.
- With "Auto-generate titles" on in the portal editor, each conversation also gets a short
  title about its topic, and up to three of the project's existing tags.
- Regenerating the summary replaces it. With "Auto-generate titles" on, it also regenerates
  the title.
- A conversation with no transcript text gets the summary "[No transcript available]".

## Move and delete

- "Move to another project" moves one conversation at a time. You need to be able to edit
  the target project, and it must share the same billing and data ownership. Tags, chats
  and outcomes stay attached.
- "Delete conversation" cannot be undone. The conversation leaves every list. Its hours
  stay in the project's usage, under "Deleted".

There are no bulk actions for moving, deleting or retranscribing conversations.

## Download the audio

"Download audio" gives one MP3 file of the whole conversation. It is not available for
anonymised, text-only or locked conversations.

## Counts and usage

The "Usage" tab under "Manage" shows "Usage this cycle" with "Audio" and "Conversations",
and a breakdown per conversation.

## Related

- [Transcription](./transcription.md): key terms, anonymisation, retranscribing and failed
  pieces.
- [Recording](./recording.md): how conversations get in, upload included.
- [Chat and Ask](./chat-and-ask.md): ask questions about the conversations you select.
- [Reports](./reports.md): a written article made from the project's conversations.
- [Export and data portability](./export-and-data-portability.md): every way to get data
  out.
- [Transcripts and conversations](../users/host/transcripts-and-conversations.md): the host
  guide for this page.
