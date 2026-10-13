---
title: The data model
description: Where the dembrane schema lives, the spine from organisation to conversation chunk, the main groups of tables, and how to change a table.
audience: developer-internal
---

# The data model

The Drizzle schema in `dembrane/platform/packages/db/src/schema/` is the source of truth for every table. This page gives you the spine and the groups, so you know where to look. Read the schema file for columns.

## Where the schema lives

| File | Tables |
|---|---|
| `index.ts` | The product tables: organisations, workspaces, projects, conversations, chats, reports and the rest. |
| `auth.ts` | Better Auth's tables. |
| `platform.ts` | Platform tables: worker heartbeats, rate limits, presence, model call metering. |
| `accounts.ts` | Customer accounts, which the dembrane team uses for offers, signing and tasks. |
| `staff.ts` | The staff audit trail. |

Migrations are SQL files in `packages/db/migrations`. DBOS, the job engine, keeps its own tables in a separate schema named `dbos`.

## Changing a table

1. Change the table in the Drizzle schema.
2. Run `bun run db:generate` in `dembrane/platform`. It writes a new SQL migration.
3. Run `bun run db:migrate` to apply it locally.
4. Commit the schema change and the migration together.

CI fails when the schema and the migrations disagree. In every environment the `migrate` app runs before the new version takes traffic, and a failed migration stops the deploy. See [deployment and releases](./deployment-and-releases.md).

A migration whose name contains `_contract_` drops something. Outside the local, test and preview environments it runs only after an archive of the dropped tables is recorded.

## The spine

```
org
  workspace                (workspace.org_id)
    project                (project.workspace_id)
      conversation         (conversation.project_id)
        conversation_chunk (conversation_chunk.conversation_id)

billing_account            (workspace.billing_account_id)
```

| Table | What you need to know |
|---|---|
| `org` | The organisation. Carries `is_partner` and the agent access switch `agent_access_enabled`. |
| `workspace` | Belongs to an org. Carries `visibility`, the required `billing_account_id`, the data owner fields and `allow_support_access`. |
| `billing_account` | The billing unit: `tier`, `status`, `payment_mode`, seats, invoice details. A workspace's tier is the tier of its billing account. |
| `project` | Belongs to a workspace. Holds the portal settings, `language`, `visibility`, `is_conversation_allowed` and `anonymize_transcripts`. |
| `conversation` | One contribution. Flags: `is_finished`, `is_all_chunks_transcribed`, `is_over_cap`, `is_anonymized`. Also `summary`, `title`, `duration` and `merged_audio_path`. |
| `conversation_chunk` | The unit of upload and transcription: `path`, `transcript`, `error`, `diarization`, `timestamp`, `source`. |

A chunk is pending while it has no transcript and no error. [The processing pipeline](./processing-pipeline.md) explains how the flags move.

## The groups

| Area | Tables |
|---|---|
| Membership | `org_membership`, `org_invite`, `workspace_membership`, `workspace_invite`, `access_request`, `project_membership` |
| Conversations | `conversation_reply`, `conversation_artifact`, `conversation_link`, `project_tag`, `conversation_project_tag`, `processing_status` |
| Chat and the assistant | `project_chat`, `project_chat_message`, `project_chat_conversation`, `project_chat_message_conversation`, `project_agentic_run`, `project_agentic_run_event`, `agent_memory`, `prompt_template` |
| Reports | `project_report`, `project_report_metric`, `project_report_notification_participants` |
| Analysis, maps and canvases | `analysis_run`, `analysis_step`, `analysis_snapshot`, `analysis_object` and their siblings, `map_result`, `map_group`, `map_fact_check`, `map_embedding`, `canvas_generation`, `canvas_config_revision` |
| Webhooks | `project_webhook` |
| Agent access | `agent_client`, `agent_grant`, `agent_token`, `agent_audit_event` |
| Billing | `billing_account`, `recording_overage`, `referral_ledger` |
| Notifications | `notification`, `announcement` and its translations |
| Verification, goals and training | `verification_topic`, `methodology`, `methodology_version`, `project_goal_revision`, `training`, `training_license` |
| Support and staff | `support_request`, `support_access_request`, `support_access_event`, and `staff_audit_event` with one row per use of a staff permission |
| Timers | `scheduled_task`: one-shot timers that a schedule claims |
| Platform | `dbos_executor_heartbeat`, `platform_rate_limit`, `platform_presence`, `model_call` |

Details worth knowing:

- `workspace_membership` carries `role`, `source`, `custom_policies` and `expires_at`. `org_membership` carries `role` and `custom_policies`.
- `project_membership` is per-project sharing. It has no role column.
- `project_chat.chat_mode` is `overview`, `deep_dive` or `agentic`.
- `processing_status` gets one row per finished or failed pipeline step. The dashboard's processing timeline reads it.
- `project_webhook` is soft deleted with `deleted_at`.
- `map_embedding` holds the one pgvector column. The baseline migration creates the `vector` extension, so the database login that migrates needs the right to do that.
- `model_call` gets one row per model call attempt: names and numbers only, never a prompt or an answer.

## Identity in the data

A person has three linked rows:

| Row | Role |
|---|---|
| `auth_user` | Sign-in. The other Better Auth tables are `auth_session`, `auth_account`, `auth_verification` and `auth_two_factor`. |
| `directus_users` | The same id as `auth_user`. Kept because several tables still carry foreign keys to it. |
| `app_user` | The application user. Memberships point at this one. Onboarding creates it. |

- A user who never finished onboarding has no `app_user` row but is still signed in.
- Staff is the role named `Administrator` on the person's `directus_users` row.
- Access is derived, not stored. The role on a membership row is resolved to policies in `packages/access`. See [roles and policies in code](./roles-and-policies.md).

## What is left from the previous stack

- The `directus_*` tables are still in the schema. The Directus service is gone.
- The first migration, `0000_baseline`, is the schema the previous stack had. A database the old stack created is adopted: the baseline is recorded as applied and not run again.
- Migration `0012_contract_dead_features.sql` drops the tables no code reads any more: `view`, `aspect`, `aspect_segment`, `insight`, `project_analysis_run`, `conversation_segment`, `conversation_segment_conversation_chunk`, every `lightrag_*` table, and `workspace_request`.

## Related

- [Architecture](./architecture.md)
- [The processing pipeline](./processing-pipeline.md)
- [Roles and policies in code](./roles-and-policies.md)
- [Chat and the assistant](./chat-and-agent.md)
- [Deployment and releases](./deployment-and-releases.md)
- [Webhooks](../developer-external/webhooks.md)
