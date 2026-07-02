---
title: The data model
description: The Directus collections behind dembrane and how org, workspace, project, conversation and the rest relate to one another.
audience: developer-internal
---

# The data model

dembrane's system of record is *Directus* on PostgreSQL - 49 collections. The schema is
versioned in `echo/directus/sync/snapshot/` (collections, fields, relations as JSON), managed
with `directus-sync`. This page maps the collections you'll work with day to day and how they
hang together. For how data is *created and processed* see
[the processing pipeline](./processing-pipeline.md); for how access to it is decided see
[roles & policies in code](./roles-and-policies.md).

> [!NOTE]
> The snapshot under `echo/directus/sync/snapshot/collections/` is the source of truth for
> the schema. When you add or change a collection, update the snapshot and follow
> [database migrations](./deployment-and-releases.md) - pushing schema to prod has sharp
> edges (the `is_indexed` pitfall, drop-index ordering).

## The spine: org → workspace → project → conversation

The core hierarchy, top to bottom:

```
org
 └─ workspace                 (an org has many workspaces)
     └─ project               (a workspace has many projects)
         └─ conversation      (a project collects many conversations)
             └─ conversation_chunk   (a recording arrives as chunks)
```

Each level carries its own membership and settings, and access is computed by walking this
spine plus the inheritance rules (see below and [roles & policies](./roles-and-policies.md)).

### Organisation

- `org` - the top-level tenant. Carries `is_partner` (a [partner](../../features/partner-program.md) hosts external-client workspaces) and the org's branding/billing defaults.
- `org_membership` - who belongs to an org and at what role (`member` / `admin` / `billing` / `owner`). Org membership is *independent* of workspace membership (ADR 0004): you can be an org member with no workspaces, or be in a workspace as `external`/`observer` with no org membership.
- `org_invite` - pending org-level invitations.

### Workspace

- `workspace` - the unit most hosts live in. Holds `visibility` (`open_to_organisation` / `invite_only` / `private`), `usage_context` (`external` marks an external-client workspace), `data_owner_email` / `data_owner_org_name`, whitelabel logo, and tier/billing pointers.
- `workspace_membership` - direct membership rows with a stored `role` (`owner` / `admin` / `member` / `billing` / `external` / `observer`). `external` is a stored role, not a boolean (ADR 0003). Effective membership also folds in org-admin/member inheritance - see `inheritance.py`.
- `workspace_invite` - pending workspace invitations (email + role + hash URL, 7-day expiry); also used for invite-by-link.
- `workspace_request` - free-tier upgrade requests (kinds `new_workspace` and `tier_upgrade`); the staff approve/deny flow reads these. See [upgrade requests](../staff/upgrade-requests.md).

### Project

- `project` - name, language, visibility, the conversation toggle, participant-name settings, and the *portal editor* fields, including `default_conversation_transcript_prompt` (the "key terms" that improve transcription). See [the portal editor](../../features/portal-editor.md).
- `project_membership` - per-project sharing for private projects (Innovator+), with project-level roles `viewer` / `editor`.
- `project_tag` - tags defined on a project; the join `conversation_project_tag` attaches them to conversations.
- `project_webhook` - webhook subscriptions (Changemaker+). See [webhooks](../developer-external/webhooks.md).

### Conversation

- `conversation` - a single contribution: an audio recording or a piece of text. Carries the processing flags (`is_finished`, `is_all_chunks_transcribed`, `summary`), source, and over-cap stamping.
- `conversation_chunk` - the unit of recording and transcription. Audio arrives in chunks (≈30 s); each is uploaded to S3 and transcribed independently.
- `conversation_segment` + `conversation_segment_conversation_chunk` - diarised/structured segments and their link to the chunks they came from.
- `conversation_reply` - replies in the "Get Reply" audio-replay flow.
- `conversation_artifact` - verified artifacts extracted during the participant verification flow.
- `conversation_link` - links between conversations.

## Chat

- `project_chat` - a chat session scoped to a project (and a selection of conversations as context).
- `project_chat_message` - the messages in a session.
- `project_chat_conversation` / `project_chat_message_conversation` - joins recording which conversations are in a chat's context and which were cited by a given message (the "sources").

Standard versus agentic chat is covered in [chat & the agent service](./chat-and-agent.md).

## Reports

- `project_report` - a generated multi-section report.
- `project_report_metric` - metrics attached to a report.
- `project_report_notification_participants` - who gets emailed when a scheduled report is generated.

Reports are produced in two phases (fan-out summaries → generate). See
[the processing pipeline](./processing-pipeline.md).

## Agentic runs

- `project_agentic_run` - a run of the agent service against a project's data.
- `project_agentic_run_event` - the event stream for a run (tool calls, progress, results), the durable record behind the live SSE feed.

## Library & analysis

- `view` - a custom analysis view over a project's conversations.
- `aspect` + `aspect_segment` - AI-extracted aspects/topics and the segments that support them.
- `insight` - extracted insights.
- `project_analysis_run` - a run of the library/analysis generation.

These power the [library & analysis](../../features/library-and-analysis.md) surface (Changemaker+).

## Billing, tiers and seats

- `billing_account` - the billing unit. Can be *org-scoped* (pooled across the org's workspaces) or *workspace-scoped* (external-client). Drives tier, Mollie subscription, discounts and managed/offline invoicing. See `billing_account.py` and [tiers & billing](../../features/tiers-and-billing.md).
- `referral_ledger` - partner kickback/discount deals (kickback %, discount %, EUR cap, expiry).

Seats are computed, not stored as a count: `seat_capacity.py` derives the effective seat
state from membership rows. See [roles & policies in code](./roles-and-policies.md).

## People, trainings and verification

- `app_user` - the application-side user record (alongside Directus's own `directus_users`).
- `training` + `training_license` - compliance trainings (online / in_person / flex) and the 1-year licences they grant. See [trainings & licences](../staff/trainings-and-licences.md).
- `verification_topic` (+ `verification_topic_translations`) - the topics a participant verifies against in the portal verification flow.
- `prompt_template` - reusable chat/analysis prompt templates (built-in + user templates).

## Cross-cutting

- `processing_status` - per-conversation processing state used to render progress and drive catch-up/reconcile jobs. See `processing_status_utils.py` and [background jobs](./background-jobs-and-scheduler.md).
- `notification` - in-app notifications (the email-digest batching reads from here).
- `announcement` (+ `_translations`, `_activity`) - product announcements shown in-app.
- `access_request` - requests to join a workspace (the org-admin discovery flow).
- `languages` - supported language reference data.

## How access is derived (not stored)

A user's effective role in a workspace is *computed*, not just read from a row. `inheritance.py`
folds together: their direct `workspace_membership` row, org-admin auto-join (gated by the
workspace's `visibility`), org-member inheritance, and sticky-removal records. The result feeds
`policies.py`, which expands the role into a policy set and checks the requested action with
`has_policy(...)`. So when debugging "why can this person see this?", trace
`inheritance.derive_workspace_role` → `policies.get_effective_policies`, don't just look at the
membership table.

---

*Related*

- [Architecture](./architecture.md)
- [Roles & policies in code](./roles-and-policies.md)
- [The processing pipeline](./processing-pipeline.md)
- [Database migrations & deployment](./deployment-and-releases.md)
