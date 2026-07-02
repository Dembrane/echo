---
title: Export & data portability
description: Getting your data out of dembrane - transcript downloads, CSV and Excel exports, report exports, and the API for everything else.
audience: all
---

# Export & data portability

Your conversations, transcripts, and findings are *yours*, and dembrane makes them easy to
take with you. Download a single transcript, export a whole project's transcripts as a zip,
pull structured data as CSV or Excel, export a [report](./reports.md) as a PDF, or fetch
everything over the API. At any point you can get your data out, in formats other tools
understand.

If you can read a conversation, you can export its transcript -
[most roles that read content](./roles-and-permissions.md) can export it. Whole-workspace
export is an admin capability; automated API export is for developers, covered in
[export & integrations](../users/developer-external/export-and-integrations.md).

## What you can export

*A single transcript.* From a [conversation's](./conversations-and-transcripts.md) detail
view, *copy* the text to your clipboard, *download a PDF*, or pull the plain text via the
API (`GET /api/conversations/{cid}/transcript`).

*A whole project's transcripts.* Export all of a project's transcripts at once as a *zip*,
each conversation its own Markdown file (`GET /api/projects/{pid}/transcripts`). The fastest
way to hand someone a complete, readable record.

*CSV / Excel.* From a project's *integrations / export* area, export structured data as CSV
or Excel - the right choice for analysing in a spreadsheet or feeding another tool.

*Reports.* A [report](./reports.md) you've built exports as a *PDF*: the assembled,
multi-section document, ready to share or print. Reports can also be scheduled and emailed.

## Where to find it

- *On a conversation* - copy and PDF download, in the detail view.
- *In the project's integrations / export tab* - the transcript zip, CSV/Excel, and the
  entry point to [webhooks](./webhooks-and-integrations.md).

> [!TIP]
> For a one-off handover, the *transcript zip* plus a *report PDF* usually covers it - the
> raw record plus the synthesis. For anything recurring, reach for the API.

## The API, for recurring exports

Everything above can be done by hand, but if you need it regularly, dembrane exposes the
same data over its API - pulling transcripts on a schedule into your own warehouse,
triggering exports from your tooling, or combining export with
[webhooks](./webhooks-and-integrations.md) so a finished report flows straight into your
systems. Endpoints, auth, and patterns are on
[export & integrations](../users/developer-external/export-and-integrations.md).

> [!NOTE]
> Export gives you the *output* and the API automates pulling it. If your goal is to *react*
> to events - a conversation finished, a report generated - rather than pull on demand, look
> at [webhooks & integrations](./webhooks-and-integrations.md) instead.

## Related

- [Reports](./reports.md) - building the documents you export as PDF.
- [Conversations & transcripts](./conversations-and-transcripts.md) - where per-conversation
  copy and download live.
- [Export & integrations (developer)](../users/developer-external/export-and-integrations.md)
  - the API endpoints and automation patterns.
- [Webhooks & integrations](./webhooks-and-integrations.md) - push events to your own systems
  instead of pulling.
