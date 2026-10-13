---
title: Export & integrations
description: The ways to move data out of dembrane. Webhooks for a push, MCP for an agent, and the export routes a signed-in person can call.
audience: developer-external
---

# Export & integrations

Choose by who does the work.

| You want | Use | Credential |
|---|---|---|
| dembrane to tell your system when something is ready | [Webhooks](./webhooks.md) | None. You verify a signature. |
| An assistant or agent to read conversations and transcripts | [MCP](./mcp-and-byo-llm.md) | An OAuth token the person approves. |
| A person to download a project's transcripts | "Download all transcripts" on the project's Export page | Their sign-in. |
| Your own recorder to put conversations in | [The participant API](./participant-api.md) | The participant token. |

For an unattended integration, use webhooks or MCP. The routes below need a person's session, and dembrane has no API keys. See [authentication](./authentication.md).

## The pattern that covers most cases

Subscribe a webhook to `conversation.summarized`. Each delivery already carries the conversation's transcript, its summary, its tags and the participant's name, so you make no second call. Add `report.generated` if you also want to know when a report is ready.

## Export routes for a signed-in person

| What | Route | Returns |
|---|---|---|
| All transcripts of a project | `GET /api/projects/:project_id/transcripts` | A zip named `<project name>_transcripts.zip`, with one markdown file per conversation that has transcript text. |
| One conversation's transcript | `GET /api/conversations/:conversation_id/transcript` | The transcript as a JSON value. |
| Emails left in a conversation | `GET /api/conversations/:conversation_id/emails` | `emails_csv` and `count`. |
| A conversation's audio | `GET /api/conversations/:conversation_id/content` | The merged audio. |
| One chunk's audio | `GET /api/conversations/:conversation_id/chunks/:chunk_id/content` | That chunk's audio. |
| Your own activity log | `GET /api/user-settings/audit-logs` | Your activity. The dashboard saves it as CSV or JSON. |

- The transcript routes need the right to read conversations in the project.
- In the zip, a file name starts with a timestamp and includes the participant's name and the first 8 characters of the conversation id.
- The zip route answers `404` with the code `project.no_conversations` when the project has no conversations, and `project.no_transcripts` when none has transcript text.

## The same data for an agent

The MCP tools read projects, conversations and transcripts with an OAuth token, and each tool is also a plain REST call under `/api/v2/agent`. With the `write` scope an agent can change project settings. See [MCP](./mcp-and-byo-llm.md).

## What you receive

An export contains what participants said. You are responsible for what you do with the data after it leaves dembrane. See [data ownership & compliance](../../features/data-ownership-and-compliance.md).

## Related

- [Webhooks](./webhooks.md)
- [MCP & bring-your-own-LLM](./mcp-and-byo-llm.md)
- [Authentication](./authentication.md)
- [Export & data portability (feature)](../../features/export-and-data-portability.md)
- [Data ownership & compliance](../../features/data-ownership-and-compliance.md)
