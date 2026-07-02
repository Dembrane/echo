---
title: Export & integrations
description: Pull transcripts, reports, and tabular data out of dembrane programmatically - transcript zips, per-conversation text, and CSV/Excel.
audience: developer-external
---

# Export & integrations

Your data is yours. dembrane gives you several ways to get conversations, transcripts, and
analysis back out - for archiving, for feeding another tool, or for building your own
integration. This page covers the programmatic export endpoints and the patterns around them.

For the host-facing, button-driven version of the same capability, see
[export & data portability](../../features/export-and-data-portability.md). This page is the
developer reference; if you'd rather be *pushed* events than pull them, see
[webhooks](./webhooks.md).

> [!NOTE]
> Export endpoints are part of the *authenticated* API. Send a
> [Directus token](./authentication.md) with the [workspace permission](../../features/roles-and-permissions.md)
> to export (`workspace:export`, an admin/owner capability). Exporting from the participant
> side is the [participant report](./participant-api.md) flow instead.

## Transcript zip (whole project)

Export every conversation in a project as a zip of per-conversation Markdown files:

```http
GET /api/projects/{pid}/transcripts
Authorization: Bearer <token>
```

Returns a zip archive - one Markdown file per conversation, each containing that
conversation's transcript. This is the simplest way to take a full point-in-time copy of a
project's spoken record.

```bash
curl -L https://YOUR-API-HOST:8000/api/projects/$PID/transcripts \
  -H "Authorization: Bearer $TOKEN" \
  -o project-transcripts.zip
```

## Per-conversation transcript (plain text)

For a single conversation, fetch the transcript as plain text:

```http
GET /api/conversations/{cid}/transcript
Authorization: Bearer <token>
```

Useful when you want to stream one conversation into another system as it finishes - pair it
with a `conversation.summarized` [webhook](./webhooks.md) to grab each transcript at the moment
it's ready, rather than polling.

## CSV / Excel

The host dashboard's [integrations](../../features/export-and-data-portability.md) screen
produces *CSV* and *Excel* exports of conversations and their metadata, alongside the
transcript zip. These are the tabular companions to the Markdown export - the right shape when
you're loading into a spreadsheet, a BI tool, or a data warehouse.

> [!TIP]
> Use the Markdown/transcript exports when you care about the *content* (the words), and the
> CSV/Excel exports when you care about the *structure* (which conversations exist, their
> tags, timestamps, and status). Many integrations pull both: the CSV for the index, the zip
> for the bodies.

## Reports

Reports are generated artifacts assembled from a project's conversations (a two-phase
fan-out-then-generate job - see the
[processing pipeline](../developer-internal/processing-pipeline.md)). A finished report can be
exported to PDF from the dashboard, and the `report.generated`
[webhook](./webhooks.md) tells your systems the moment one is ready to fetch. See
[reports](../../features/reports.md) for the host-facing view.

## Programmatic export patterns

A few patterns that hold up well:

- *Scheduled full snapshot.* On a cron, call `GET /api/projects/{pid}/transcripts` and store
  the zip in your own archive. Simple, complete, and easy to diff between runs.
- *Event-driven incremental pull.* Register a [webhook](./webhooks.md) for
  `conversation.summarized` (and `conversation.transcribed`), and on each delivery fetch that
  one conversation's transcript via `GET /api/conversations/{cid}/transcript`. Low latency, no
  polling, and you only fetch what changed.
- *Index + bodies.* Pull the CSV/Excel export for the conversation index and metadata, then
  fetch transcript bodies only for the rows you care about.

> [!IMPORTANT]
> Exports can contain personal data. The transcript correction pass redacts PII by default
> (unless `DISABLE_REDACTION` is set - see
> [configuration](./configuration-and-llm-providers.md#key-feature-toggles)), but you remain
> responsible for how you store and process exported data. Review
> [data ownership & compliance](../../features/data-ownership-and-compliance.md).

## Related

- [Export & data portability](../../features/export-and-data-portability.md) - the host-facing feature.
- [Webhooks](./webhooks.md) - be notified when there's something new to export.
- [Authentication](./authentication.md) - tokens for these endpoints.
- [Reports](../../features/reports.md) - what a generated report contains.
- [Data ownership & compliance](../../features/data-ownership-and-compliance.md).
