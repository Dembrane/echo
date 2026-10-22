---
title: Export & data portability
description: Every way to get your data out of dembrane. Transcripts as Markdown, audio as MP3, and webhooks or MCP for other systems. There is no CSV, Excel or PDF transcript export.
audience: all
---

# Export & data portability

Transcripts leave dembrane as Markdown files and audio as MP3. Anyone who can read a
project's conversations can download them.

## What you can download

| What | Where | What you get |
|---|---|---|
| All transcripts of a project | "Manage", then "Export", then "Download all transcripts" | A zip file named after the project, with one Markdown file per conversation |
| One transcript | The conversation page, "Download transcript". You can give it a "Custom filename" | One Markdown file |
| One transcript or summary as text | The copy icon on the transcript, or "Copy summary" | Text on your clipboard |
| The audio of one conversation | "Download audio" on the conversation page or its row | One MP3 file of the whole conversation |
| The QR code | "Download QR code" on the project's "Overview" | A PNG file |
| The host guide | "Download event printouts" | Your browser's print dialog, where you can save as PDF |

Good to know:

- The zip leaves out conversations that have no transcript text.
- Each file in the zip is named with the date and time, the participant's name and the
  start of the conversation's ID, so the files sort by time.
- "Download audio" is not available for anonymised or text-only conversations.

## What does not exist

- No CSV or Excel export of conversations.
- No PDF download of a transcript.
- No button to download everything tied to your own account. For that, or to have personal
  data erased, ask dembrane.

Reports have their own ways of sharing. See [reports](./reports.md).

## Sending data to another system

- [Webhooks](./webhooks-and-integrations.md), "Automation" in the product, send a message
  to your own system when something happens in a project. The message for a summarised
  conversation carries the transcript and the summary.
- [MCP](./mcp-and-bring-your-own-llm.md) lets an assistant such as Claude or ChatGPT read
  the conversations and transcripts you can see.

Developers find the technical side on
[export and integrations](../users/developer-external/export-and-integrations.md).

## Related

- [Conversations and transcripts](./conversations-and-transcripts.md): where the download
  buttons are.
- [Reports](./reports.md): sharing and printing a report.
- [Webhooks and integrations](./webhooks-and-integrations.md) and
  [MCP](./mcp-and-bring-your-own-llm.md): data to other systems.
- [Data ownership and compliance](./data-ownership-and-compliance.md): who owns the data
  and where it is kept.
