# Codebase Exploration Report
## Session 1: EXPLORE — Dembrane ECHO Platform
> **Date:** 2026-04-07
> **Branch:** workspaces (based on main)
> **Status:** READ-ONLY exploration, no code changes
> **Directus:** v11.13.4 on PostgreSQL

---

## 1. DIRECTUS SCHEMA MAP

### 1.1 directus_users (Directus system collection)

**Default Directus fields** (not in sync files, managed by Directus core):
| Field | Type | Notes |
|-------|------|-------|
| `id` | uuid, PK | Directus-managed |
| `first_name` | string, nullable | |
| `last_name` | string, nullable | |
| `email` | string, unique | |
| `password` | hash | Never exposed via API |
| `location` | string, nullable | |
| `title` | string, nullable | |
| `description` | text, nullable | |
| `tags` | json, nullable | |
| `avatar` | uuid, FK → directus_files | |
| `language` | string, nullable | |
| `tfa_secret` | string, nullable | 2FA secret (exposed as boolean `tfa_enabled` in /me) |
| `status` | string | active/invited/suspended/archived |
| `role` | uuid, FK → directus_roles | |
| `token` | string, nullable | Static API token |
| `last_access` | timestamp, nullable | |
| `last_page` | string, nullable | |
| `provider` | string | default/ldap/oauth2 |
| `external_identifier` | string, nullable | |
| `auth_data` | json, nullable | |
| `email_notifications` | boolean | |
| `appearance` | string, nullable | |
| `theme_dark` | string, nullable | |
| `theme_light` | string, nullable | |
| `theme_light_overrides` | json, nullable | |
| `theme_dark_overrides` | json, nullable | |

**Custom fields** (from sync files):
| Field | Type | Nullable | Default | Notes |
|-------|------|----------|---------|-------|
| `disable_create_project` | boolean | yes | false | Locks user to single project |
| `hide_ai_suggestions` | boolean | yes | false | Hides chat suggestions |
| `legal_basis` | string | yes | "client-managed" | consent/client-managed/dembrane-events |
| `privacy_policy_url` | string | yes | null | Per-user privacy policy URL |
| `whitelabel_logo` | uuid, FK → directus_files | yes | null | on_delete: SET NULL |
| `quick_access_preferences` | json | yes | [] | Ordered template preferences |
| `projects` | alias (O2M) | — | — | O2M → project via project.directus_user_id |

**Roles:**
| Role | Parent | admin_access | app_access |
|------|--------|-------------|------------|
| Administrator | — | true | true |
| Basic User | — | false | true |
| Enterprise User | Basic User | false | true |
| Read-Only | — | false | false |

---

### 1.2 project

| Field | Type | Nullable | Default | Notes |
|-------|------|----------|---------|-------|
| `id` | uuid, PK | no | — | |
| `name` | string | yes | null | |
| `context` | text | yes | null | Project description/context for LLM |
| `language` | string | yes | null | Project language code |
| `directus_user_id` | uuid, FK → directus_users | yes | null | Owner. on_delete: SET NULL |
| `is_conversation_allowed` | boolean | no | — | Controls participant portal access |
| `pin_order` | integer | yes | null | 1-3 for pinned projects |
| `created_at` | timestamp | yes | CURRENT_TIMESTAMP | |
| `updated_at` | timestamp | yes | CURRENT_TIMESTAMP | |
| `anonymize_transcripts` | boolean | yes | false | |
| `conversation_title_prompt` | text | yes | null | |
| `conversation_ask_for_participant_name_label` | string | yes | null | |
| `default_conversation_ask_for_participant_email` | boolean | yes | false | |
| `default_conversation_ask_for_participant_name` | boolean | yes | true | |
| `default_conversation_description` | text | yes | null | |
| `default_conversation_finish_text` | text | yes | null | |
| `default_conversation_title` | string | yes | null | |
| `default_conversation_transcript_prompt` | text | yes | null | |
| `default_conversation_tutorial_slug` | string | yes | "none" | |
| `enable_ai_title_and_tags` | boolean | yes | false | |
| `get_reply_mode` | string | yes | "summarize" | |
| `get_reply_prompt` | text | yes | null | |
| `image_generation_model` | string | yes | "PLACEHOLDER" | |
| `is_enhanced_audio_processing_enabled` | boolean | yes | false | |
| `is_get_reply_enabled` | boolean | yes | false | |
| `is_project_notification_subscription_allowed` | boolean | yes | false | |
| `is_verify_enabled` | boolean | yes | false | |
| `is_verify_on_finish_enabled` | boolean | yes | false | |
| `selected_verification_key_list` | text | yes | null | Comma-separated keys |
| **Alias fields (O2M):** | | | | |
| `conversations` | alias | — | — | O2M → conversation |
| `tags` | alias | — | — | O2M → project_tag |
| `project_chats` | alias | — | — | O2M → project_chat |
| `project_reports` | alias | — | — | O2M → project_report |
| `project_analysis_runs` | alias | — | — | O2M → project_analysis_run |
| `custom_verification_topics` | alias | — | — | O2M → verification_topic |
| `processing_status` | alias | — | — | O2M → processing_status |

**Key relations from project:**
- `project.directus_user_id` → `directus_users` (SET NULL)
- `conversation.project_id` → `project` (CASCADE)
- `project_tag.project_id` → `project` (CASCADE)
- `project_chat.project_id` → `project` (CASCADE)
- `project_agentic_run.project_id` → `project` (CASCADE)
- `project_analysis_run.project_id` → `project` (CASCADE)
- `project_report.project_id` → `project` (SET NULL)
- `project_webhook.project_id` → `project` (SET NULL)
- `verification_topic.project_id` → `project` (SET NULL)
- `processing_status.project_id` → `project` (SET NULL)

---

### 1.3 conversation

| Field | Type | Nullable | Default | Notes |
|-------|------|----------|---------|-------|
| `id` | uuid, PK | no | — | |
| `project_id` | uuid, FK → project | no | — | on_delete: CASCADE |
| `duration` | float | yes | null | Duration in seconds |
| `title` | text | yes | null | AI-generated |
| `summary` | text | yes | null | AI-generated |
| `participant_name` | string | yes | null | |
| `participant_email` | string | yes | null | |
| `participant_user_agent` | string | yes | null | |
| `source` | string | yes | null | |
| `is_finished` | boolean | yes | false | |
| `is_all_chunks_transcribed` | boolean | yes | null | |
| `is_audio_processing_finished` | boolean | yes | false | |
| `is_anonymized` | boolean | yes | false | |
| `merged_audio_path` | text | yes | null | S3 path |
| `merged_transcript` | text | yes | null | |
| `created_at` | timestamp | yes | CURRENT_TIMESTAMP | |
| `updated_at` | timestamp | yes | CURRENT_TIMESTAMP | |
| **Alias fields:** | | | | |
| `chunks` | alias | — | — | O2M → conversation_chunk |
| `conversation_artifacts` | alias | — | — | O2M → conversation_artifact |
| `conversation_segments` | alias | — | — | O2M → conversation_segment |
| `tags` | alias | — | — | M2M → project_tag via conversation_project_tag |
| `project_chats` | alias | — | — | M2M → project_chat via project_chat_conversation |
| `project_chat_messages` | alias | — | — | O2M via junction |
| `replies` | alias | — | — | O2M → conversation_reply |
| `linked_conversations` | alias | — | — | O2M → conversation_link (source) |
| `linking_conversations` | alias | — | — | O2M → conversation_link (target) |

**NOTE:** The field is named `duration` (not `duration_seconds` as PRD assumes). It stores seconds as a float.

---

### 1.4 conversation_chunk

| Field | Type | Nullable | Default |
|-------|------|----------|---------|
| `id` | uuid, PK | no | — |
| `conversation_id` | uuid, FK → conversation | no | — (CASCADE) |
| `path` | string | yes | null | S3 audio path |
| `transcript` | text | yes | null | Corrected transcript |
| `raw_transcript` | text | yes | null | Original from ASR |
| `source` | string | yes | null | |
| `timestamp` | timestamp | no | — | |
| `created_at` | timestamp | yes | CURRENT_TIMESTAMP |
| `updated_at` | timestamp | yes | CURRENT_TIMESTAMP |
| `desired_language` | string | yes | null |
| `detected_language` | string | yes | null |
| `detected_language_confidence` | float | yes | null |
| `diarization` | json | yes | null |
| `error` | text | yes | null |
| `hallucination_reason` | text | yes | null |
| `hallucination_score` | float | yes | null |
| `noise_ratio` | float | yes | null |
| `silence_ratio` | float | yes | null |
| `cross_talk_instances` | integer | yes | null |
| `runpod_job_status_link` | text | yes | null |
| `runpod_request_count` | integer | yes | null |
| `translation_error` | string | yes | null |

---

### 1.5 project_chat

| Field | Type | Nullable | Default |
|-------|------|----------|---------|
| `id` | uuid, PK | no | — |
| `project_id` | uuid, FK → project | yes | null (CASCADE) |
| `name` | string | yes | null |
| `chat_mode` | string | yes | null | overview/deep_dive/agentic |
| `auto_select` | boolean | yes | null |
| `user_created` | uuid, FK → directus_users | yes | null |
| `user_updated` | uuid, FK → directus_users | yes | null |
| `date_created` | timestamp | yes | null |
| `date_updated` | timestamp | yes | null |

---

### 1.6 project_chat_message

| Field | Type | Nullable | Default |
|-------|------|----------|---------|
| `id` | uuid, PK | no | — |
| `project_chat_id` | uuid, FK → project_chat | yes | null (CASCADE) |
| `message_from` | string | yes | null | user/assistant/dembrane |
| `text` | text | yes | null |
| `template_key` | string | yes | null |
| `tokens_count` | integer | yes | null |
| `date_created` | timestamp | yes | null |
| `date_updated` | timestamp | yes | null |

---

### 1.7 project_report

| Field | Type | Nullable | Default |
|-------|------|----------|---------|
| `id` | bigInteger, PK | no | — |
| `project_id` | uuid, FK → project | yes | null (SET NULL) |
| `content` | text | yes | null |
| `language` | string | yes | null |
| `status` | string | no | — | draft/generating/published/archived/scheduled/cancelled/error |
| `show_portal_link` | boolean | yes | null |
| `scheduled_at` | timestamp | yes | null |
| `error_code` | string | yes | null |
| `error_message` | text | yes | null |
| `user_instructions` | text | yes | null |
| `date_created` | timestamp | yes | null |
| `date_updated` | timestamp | yes | null |

---

### 1.8 Other Collections (summary)

| Collection | PK Type | Key Fields | Key Relations |
|-----------|---------|------------|---------------|
| `conversation_artifact` | uuid | content, key, topic_label, approved_at | conversation_id → conversation (CASCADE) |
| `conversation_segment` | integer | transcript, contextual_transcript, config_id, counter | conversation_id → conversation (CASCADE) |
| `conversation_link` | bigInteger | link_type, source_conversation_id, target_conversation_id | → conversation (SET NULL) |
| `conversation_reply` | uuid | content_text, type | reply → conversation (SET NULL) |
| `conversation_project_tag` | integer | — | conversation_id → conversation (CASCADE), project_tag_id → project_tag (CASCADE) |
| `conversation_segment_conversation_chunk` | integer | — | junction: conversation_segment (CASCADE) ↔ conversation_chunk (CASCADE) |
| `project_chat_conversation` | integer | — | junction: project_chat (CASCADE) ↔ conversation (CASCADE) |
| `project_tag` | uuid | text, sort | project_id → project (CASCADE) |
| `project_webhook` | uuid | name, url, events, secret, status | project_id → project (SET NULL) |
| `project_agentic_run` | uuid | status, agent_thread_id, directus_user_id | project_id → project (CASCADE), project_chat_id → project_chat (SET NULL) |
| `project_agentic_run_event` | bigInteger | event_type, payload (json), seq | project_agentic_run_id → project_agentic_run (CASCADE) |
| `project_analysis_run` | uuid | — | project_id → project (CASCADE) |
| `project_report_metric` | bigInteger | type, ip | project_report_id → project_report (SET NULL) |
| `project_report_notification_participants` | uuid | email, email_opt_in, email_opt_out_token | conversation_id → conversation (SET NULL) |
| `prompt_template` | uuid | title, content, description, icon, is_public, is_anonymous, language, tags, sort | user_created → directus_users |
| `verification_topic` | uuid (key-based) | All translated fields via junction | project_id → project (SET NULL) |
| `verification_topic_translations` | — | title, message per language | verification_topic_key → verification_topic (SET NULL) |
| `view` | uuid | name, summary, description, language, user_input | project_analysis_run_id → project_analysis_run (SET NULL) |
| `aspect` | uuid | name, short_summary, long_summary, image_url | view_id → view (SET NULL) |
| `aspect_segment` | uuid | description, verbatim_transcript, relevant_index | aspect → aspect (CASCADE), segment → conversation_segment (SET NULL) |
| `processing_status` | bigInteger | event, message, duration_ms, timestamp | multiple nullable FKs to project, conversation, etc. (all SET NULL) |
| `insight` | uuid | title, summary | project_analysis_run_id → project_analysis_run (SET NULL) |
| `chat` | uuid | title | user_created/user_updated → directus_users (appears unused/legacy) |
| `project_chat_message_metadata` | uuid | conversation, message_metadata, ratio, reference_text, type (reference/citation) | In TypeScript types but NOT in sync snapshot (newer collection) |
| `prompt_template_preference` | uuid | template_type (static/user), static_template_id, prompt_template_id, sort | In TypeScript types but NOT in sync snapshot |
| `prompt_template_rating` | uuid | prompt_template_id, rating, chat_message_id | In TypeScript types but NOT in sync snapshot |
| `announcement` | uuid | level, expires_at | system announcements with translations |
| `announcement_activity` | uuid | read, user_id | tracks which users read announcements |
| `languages` | string (code), PK | name, direction | Reference table |

---

### 1.9 CASCADE Dependency Tree

```
project (DELETE CASCADE triggers)
  ├── conversation (CASCADE)
  │   ├── conversation_chunk (CASCADE)
  │   │   └── conversation_segment_conversation_chunk (CASCADE)
  │   ├── conversation_segment (CASCADE)
  │   │   └── conversation_segment_conversation_chunk (CASCADE)
  │   ├── conversation_artifact (CASCADE)
  │   ├── conversation_project_tag (CASCADE)
  │   └── project_chat_conversation (CASCADE)
  ├── project_tag (CASCADE)
  │   └── conversation_project_tag (CASCADE)
  ├── project_chat (CASCADE)
  │   ├── project_chat_message (CASCADE)
  │   └── project_chat_conversation (CASCADE)
  ├── project_agentic_run (CASCADE)
  │   └── project_agentic_run_event (CASCADE)
  └── project_analysis_run (CASCADE)

project (SET NULL on delete — data preserved, FK nullified)
  ├── project_report.project_id
  ├── project_webhook.project_id
  ├── verification_topic.project_id
  └── processing_status.project_id
```

---

## 2. PYTHON API ROUTE MAP

### Architecture

- **Entry point:** `server/dembrane/main.py`
- **Router aggregation:** `server/dembrane/api/api.py` — mounts all sub-routers under `/api`
- **Auth:** `DependencyDirectusSession` decodes JWT from Directus session cookie using shared `DIRECTUS_SECRET`
- **Admin client:** Module-level `directus` instance with static admin token (`DIRECTUS_TOKEN` env var)
- **User-scoped client:** Per-request `DirectusClient` created from user's JWT, available as `session.client`
- **No global response envelope** — each endpoint returns its own shape

### Route Table

#### /api (root)
| Method | Path | Auth | Description | Collections | Deletes? |
|--------|------|------|-------------|-------------|----------|
| GET | `/api/health` | None | Health check | — | No |

#### /api/projects
| Method | Path | Auth | Description | Collections | Deletes? |
|--------|------|------|-------------|-------------|----------|
| GET | `/api/projects/home` | Session | BFF: paginated projects list with pins, search, owner | R: project, directus_users | No |
| PATCH | `/api/projects/{id}/pin` | Session | Pin/unpin project (1-3 or null) | RW: project | No |
| POST | `/api/projects` | Session | Create project | W: project | No |
| GET | `/api/projects/{id}/transcripts` | Session | Download all transcripts as ZIP | R: project, conversation, conversation_chunk | No |
| POST | `/api/projects/{id}/create-library` | Session | Enqueue library generation task | R: project | No |
| POST | `/api/projects/{id}/create-view` | Session | Enqueue view creation task | R: project, project_analysis_run | No |
| POST | `/api/projects/{id}/create-report` | Session | Create report (immediate or scheduled) | RW: project_report | No |
| GET | `/api/projects/{id}/reports` | Session | List project reports | R: project_report | No |
| GET | `/api/projects/{id}/reports/latest` | Session | Get latest report | R: project_report | No |
| PATCH | `/api/projects/{id}/reports/{rid}` | Session | Update report | RW: project_report | No |
| DELETE | `/api/projects/{id}/reports/{rid}` | Session | **Hard delete** report | D: project_report | **YES** |
| POST | `/api/projects/{id}/reports/{rid}/cancel-schedule` | Session | Cancel scheduled report | W: project_report | No |
| GET | `/api/projects/{id}/reports/{rid}/detail` | Session | Report full content | R: project_report | No |
| GET | `/api/projects/{id}/reports/{rid}/views` | Session | Report view counts | R: project_report_metric | No |
| GET | `/api/projects/{id}/reports/{rid}/needs-update` | Session | Check for newer conversations | R: project_report, conversation | No |
| GET | `/api/projects/{id}/participants/count` | Session | Email-opted-in participant count | R: project_report_notification_participants | No |
| GET | `/api/projects/{id}/reports/{rid}/progress` | Session | SSE: report generation progress | R: project_report | No (SSE) |
| POST | `/api/projects/{id}/clone` | Session | Clone project with tags | RW: project | No |

#### /api/projects/{id}/webhooks
| Method | Path | Auth | Description | Collections | Deletes? |
|--------|------|------|-------------|-------------|----------|
| GET | `/api/projects/{id}/webhooks` | Session | List webhooks | R: project_webhook | No |
| GET | `/api/projects/{id}/webhooks/copyable` | Session | Copyable webhooks from other projects | R: project_webhook | No |
| POST | `/api/projects/{id}/webhooks` | Session | Create webhook | W: project_webhook | No |
| PATCH | `/api/projects/{id}/webhooks/{wid}` | Session | Update webhook | RW: project_webhook | No |
| DELETE | `/api/projects/{id}/webhooks/{wid}` | Session | **Hard delete** webhook | D: project_webhook | **YES** |
| POST | `/api/projects/{id}/webhooks/{wid}/test` | Session | Test webhook delivery | R: project_webhook | No |

#### /api/conversations
| Method | Path | Auth | Description | Collections | Deletes? |
|--------|------|------|-------------|-------------|----------|
| GET | `/api/conversations/health/stream` | None | SSE: conversation health monitoring | R: conversation | No (SSE) |
| GET | `/api/conversations/{id}/counts` | Session | Chunk counts | R: conversation_chunk | No |
| GET | `/api/conversations/{id}/content` | Session | Audio content (merge + redirect) | R: conversation_chunk; W: conversation | No |
| GET | `/api/conversations/{id}/chunks/{cid}/content` | Session | Single chunk audio (S3 redirect) | R: conversation_chunk | No |
| GET | `/api/conversations/{id}/transcript` | Session | Full transcript text | R: conversation_chunk | No |
| GET | `/api/conversations/{id}/emails` | Session | Participant emails | R: project_report_notification_participants | No |
| GET | `/api/conversations/{id}/token-count` | Session | LLM token count (cached) | R: conversation_chunk | No |
| POST | `/api/conversations/{id}/get-reply` | None | LLM reply (SSE stream) | R: conversation, conversation_chunk | No |
| POST | `/api/conversations/{id}/summarize` | Session | Generate summary | RW: conversation | No |
| POST | `/api/conversations/{id}/generate-title` | Session | Generate title | RW: conversation | No |
| POST | `/api/conversations/{id}/retranscribe` | Session | Clone + re-transcribe | RW: conversation, conversation_chunk, conversation_link | On error only |
| DELETE | `/api/conversations/{id}` | Session | **Hard delete** conversation + S3 files | D: conversation (service) | **YES** |

#### /api/chats
| Method | Path | Auth | Description | Collections | Deletes? |
|--------|------|------|-------------|-------------|----------|
| GET | `/api/chats/{id}/context` | Session | Chat context (conversations, token usage) | R: project_chat, project_chat_message, conversation | No |
| POST | `/api/chats/{id}/add-context` | Session | Add conversations to chat | RW: project_chat junction | No |
| POST | `/api/chats/{id}/delete-context` | Session | Remove conversation from chat | D: project_chat_conversation junction | **YES** (junction) |
| POST | `/api/chats/{id}/lock-conversations` | Session | Lock conversations into chat | W: project_chat_message | No |
| GET | `/api/chats/{id}/suggestions` | Session | LLM question suggestions | R: project_chat, project | No |
| POST | `/api/chats/{id}/initialize-mode` | Session | Set chat mode | RW: project_chat | No |
| POST | `/api/chats/{id}` | Session | Send message (SSE stream) | RW: project_chat_message | On error: deletes user msg |

#### /api/participant (PUBLIC — no auth)
| Method | Path | Auth | Description | Collections | Deletes? |
|--------|------|------|-------------|-------------|----------|
| GET | `/api/participant/projects/{id}` | None | Public project info | R: project, directus_users | No |
| POST | `/api/participant/projects/{id}/conversations/initiate` | None | Start conversation | W: conversation | No |
| GET | `/api/participant/projects/{id}/conversations/{cid}` | None | Conversation info | R: conversation | No |
| GET | `/api/participant/projects/{id}/conversations/{cid}/chunks` | None | List chunks | R: conversation_chunk | No |
| DELETE | `/api/participant/.../chunks/{chid}` | None | **Hard delete** chunk | D: conversation_chunk | **YES** |
| POST | `/api/participant/conversations/{cid}/upload-text` | None | Upload text chunk | W: conversation_chunk | No |
| POST | `/api/participant/conversations/{cid}/upload-chunk` | None | Upload audio chunk | W: conversation_chunk | No |
| POST | `/api/participant/conversations/{cid}/check-s3` | None | S3 connectivity test | R: conversation, project | No |
| POST | `/api/participant/conversations/{cid}/get-upload-url` | None | Presigned S3 URL | R: conversation | No |
| POST | `/api/participant/conversations/{cid}/confirm-upload` | None | Confirm S3 upload | RW: conversation_chunk | No |
| POST | `/api/participant/conversations/{cid}/finish` | None | Signal finished | — (dispatches task) | No |
| GET | `/api/participant/{id}/report/latest` | None | Latest published report | R: project_report | No |
| GET | `/api/participant/{id}/report/{rid}/detail` | None | Published report content | R: project_report | No |
| GET | `/api/participant/{id}/report/views` | None | Report view counts | R: project_report_metric | No |
| POST | `/api/participant/{id}/report/metric` | None | Record view metric | W: project_report_metric | No |
| POST | `/api/participant/report/subscribe` | None | Email subscription | RWD: project_report_notification_participants | **YES** (re-create) |
| POST | `/api/participant/{id}/report/unsubscribe` | None | Unsubscribe | W: project_report_notification_participants | No |
| GET | `/api/participant/report/unsubscribe/eligibility` | None | Check unsubscribe token | R: project_report_notification_participants | No |

#### /api/agentic
| Method | Path | Auth | Description | Collections | Deletes? |
|--------|------|------|-------------|-------------|----------|
| POST | `/api/agentic/runs` | Session | Create agentic run | W: project_agentic_run, project_agentic_run_event | No |
| POST | `/api/agentic/runs/{id}/messages` | Session | Add follow-up message | RW: project_agentic_run_event, project_chat_message | No |
| GET | `/api/agentic/projects/{id}/conversations` | Session | List conversations for agent | R: conversation, conversation_chunk | No |
| POST | `/api/agentic/runs/{id}/stream` | Session | SSE: process + stream events | RW: project_agentic_run | No (SSE) |
| POST | `/api/agentic/runs/{id}/stop` | Session | Cancel active run | W: project_agentic_run | No |
| GET | `/api/agentic/runs/{id}` | Session | Run details | R: project_agentic_run | No |
| GET | `/api/agentic/runs/{id}/events` | Session | Run events (SSE or JSON) | R: project_agentic_run_event | No |

#### /api/verify
| Method | Path | Auth | Description | Collections | Deletes? |
|--------|------|------|-------------|-------------|----------|
| GET | `/api/verify/topics/{pid}` | None | Get verification topics | R: verification_topic, project | No |
| PUT | `/api/verify/topics/{pid}` | None | Update selected topics | RW: project | No |
| POST | `/api/verify/topics/{pid}/custom` | Session | Create custom topic | W: verification_topic, project | No |
| PATCH | `/api/verify/topics/{pid}/custom/{key}` | Session | Update custom topic | RW: verification_topic | No |
| DELETE | `/api/verify/topics/{pid}/custom/{key}` | Session | **Hard delete** topic | D: verification_topic; W: project | **YES** |
| GET | `/api/verify/artifacts/{cid}` | None | List approved artifacts | R: conversation_artifact | No |
| GET | `/api/verify/artifact/{aid}` | None | Single artifact | R: conversation_artifact | No |
| POST | `/api/verify/generate` | None | Generate artifact (LLM) | RW: conversation_artifact | No |
| PUT | `/api/verify/artifact/{aid}` | None | Update/revise artifact | RW: conversation_artifact | No |

#### /api/user-settings
| Method | Path | Auth | Description | Collections | Deletes? |
|--------|------|------|-------------|-------------|----------|
| GET | `/api/user-settings/me` | Session | Current user profile | R: directus_users (admin client) | No |
| PATCH | `/api/user-settings/password` | Session | Change password | Proxies to Directus auth | No |
| POST | `/api/user-settings/tfa/generate` | Session | Generate 2FA secret | Proxies to Directus | No |
| POST | `/api/user-settings/tfa/enable` | Session | Enable 2FA | Proxies to Directus | No |
| POST | `/api/user-settings/tfa/disable` | Session | Disable 2FA | Proxies to Directus | No |
| POST | `/api/user-settings/whitelabel-logo` | Session | Upload logo | W: directus_files, directus_users | No |
| DELETE | `/api/user-settings/whitelabel-logo` | Session | **Hard delete** logo file | D: directus_files; W: directus_users | **YES** (file) |
| PATCH | `/api/user-settings/name` | Session | Update display name | W: directus_users | No |
| POST | `/api/user-settings/avatar` | Session | Upload avatar | W: directus_files, directus_users | No |
| DELETE | `/api/user-settings/avatar` | Session | **Hard delete** avatar file | D: directus_files; W: directus_users | **YES** (file) |
| PATCH | `/api/user-settings/legal-basis` | Session | Set legal basis | RW: directus_users | No |

#### /api/templates
| Method | Path | Auth | Description | Collections | Deletes? |
|--------|------|------|-------------|-------------|----------|
| GET | `/api/templates/prompt-templates` | Session | List user templates | R: prompt_template | No |
| POST | `/api/templates/prompt-templates` | Session | Create template | W: prompt_template | No |
| PATCH | `/api/templates/prompt-templates/{id}` | Session | Update template | RW: prompt_template | No |
| DELETE | `/api/templates/prompt-templates/{id}` | Session | **Hard delete** template | D: prompt_template | **YES** |
| GET | `/api/templates/quick-access` | Session | Quick access preferences | R: directus_users | No |
| PUT | `/api/templates/quick-access` | Session | Save quick access prefs | W: directus_users | No |
| PATCH | `/api/templates/ai-suggestions` | Session | Toggle AI suggestions | W: directus_users | No |

#### /api/home
| Method | Path | Auth | Description | Collections | Deletes? |
|--------|------|------|-------------|-------------|----------|
| GET | `/api/home/search` | Session | Global search | R: project, conversation, conversation_chunk, project_chat | No |

#### /api/stats
| Method | Path | Auth | Description | Collections | Deletes? |
|--------|------|------|-------------|-------------|----------|
| GET | `/api/stats/` | None | Aggregate platform stats (cached) | R: directus_users, project, conversation | No |

#### /api/webhooks
| Method | Path | Auth | Description | Collections | Deletes? |
|--------|------|------|-------------|-------------|----------|
| POST | `/api/webhooks/assemblyai` | Webhook secret | AssemblyAI transcription callback | R: Redis; dispatches task | No |

---

## 3. FRONTEND ROUTE MAP

### Host Dashboard (mainRouter)

All paths prefixed with `/:language?/`

| Path | Component | Data Source | Delete Ops |
|------|-----------|-------------|------------|
| `/login` | LoginRoute | Directus SDK (auth) | — |
| `/register` | RegisterRoute | Directus SDK | — |
| `/check-your-email` | CheckYourEmailRoute | Static | — |
| `/password-reset` | PasswordResetRoute | Directus SDK | — |
| `/request-password-reset` | RequestPasswordResetRoute | Directus SDK | — |
| `/verify-email` | VerifyEmailRoute | Directus SDK | — |
| `/projects` | ProjectsHomeRoute | **Python API** (`/projects/home` BFF) | — |
| `/projects/:id` | Redirect → portal-editor | — | — |
| `/projects/:id/portal-editor` | ProjectPortalSettingsRoute | Directus SDK + Python API | Delete tags (Directus direct), delete verification topics (Python) |
| `/projects/:id/overview` | ProjectSettingsRoute | Directus SDK + Python API | **Delete project** (Directus SDK direct!), delete webhooks (Python) |
| `/projects/:id/chats/new` | NewChatRoute | Directus SDK + Python API | — |
| `/projects/:id/chats/:chatId` | ProjectChatRoute | Python API + Directus SDK | **Delete chat** (Directus SDK direct!) |
| `/projects/:id/conversation/:cid/overview` | ProjectConversationOverviewRoute | Directus SDK + Python API | **Delete conversation** (Python API) |
| `/projects/:id/conversation/:cid/transcript` | ProjectConversationTranscript | Directus SDK | — |
| `/projects/:id/library` | ProjectLibraryRoute | Directus SDK + Python API | — |
| `/projects/:id/library/views/:vid` | ProjectLibraryView | Directus SDK | — |
| `/projects/:id/library/views/:vid/aspects/:aid` | ProjectLibraryAspect | Directus SDK | — |
| `/projects/:id/report` | ProjectReportRoute | Python API | **Delete report** (Python API) |
| `/projects/:id/host-guide` | HostGuidePage | Directus SDK + SSE | — |
| `/settings` | UserSettingsRoute | Python API + Directus SDK | — |

### Participant Portal (participantRouter)

All paths prefixed with `/:language?/:projectId/`

| Path | Component | Data Source | Delete Ops |
|------|-----------|-------------|------------|
| `/start` | ParticipantStartRoute | Python API | — |
| `/conversation/:cid` | ParticipantConversationAudioRoute | Python API | Delete chunk (Python API) |
| `/conversation/:cid/text` | ParticipantConversationTextRoute | Python API | — |
| `/conversation/:cid/refine` | RefineSelection | Python API | — |
| `/conversation/:cid/verify` | VerifySelection | Python API | — |
| `/conversation/:cid/verify/approve` | VerifyArtefact | Python API | — |
| `/conversation/:cid/finish` | ParticipantPostConversation | Python API | — |
| `/report` | ParticipantReport | Python API | — |
| `/unsubscribe` | ProjectUnsubscribe | Python API | — |

---

## 4. DELETE OPERATION INVENTORY

### 4a. Frontend → Directus Direct DELETE Calls

| # | File | Hook/Function | Collection | Trigger | Metadata Lost |
|---|------|--------------|------------|---------|---------------|
| D1 | `components/project/hooks/index.ts:104` | `useDeleteProjectByIdMutation` | **project** | User clicks delete in ProjectDangerZone | **CATASTROPHIC**: ALL conversations (duration, transcripts, audio), ALL chunks, segments, artifacts, tags, chats, chat messages, analysis runs, agentic runs. Biggest data loss event possible. |
| D2 | `components/chat/hooks/index.ts:68` | `useDeleteChatMutation` | **project_chat** | User deletes chat from sidebar menu | All chat messages (text, tokens_count), conversation junction records |
| D3 | `components/project/hooks/index.ts:188` | `useDeleteTagByIdMutation` | **project_tag** | User deletes a project tag | All conversation-tag associations (CASCADE) |
| D4 | `components/conversation/hooks/index.ts:187` | `useUpdateConversationTagsMutation` | **conversation_project_tag** | User removes tags from conversation | Junction records only (low impact) |

### 4b. Frontend → Python API Delete Endpoints

| # | Frontend File | Python Endpoint | Collection | Trigger | Metadata Lost |
|---|------|--------|------------|---------|---------------|
| D5 | `lib/api.ts:1614` | `DELETE /api/conversations/{id}` | **conversation** | User clicks delete in ConversationDangerZone | duration, summary, title, transcript, participant info; S3 audio files also deleted |
| D6 | `lib/api.ts:1341` | `DELETE /api/projects/{id}/reports/{rid}` | **project_report** | User deletes report | Report content, language, status; metrics SET NULL |
| D7 | `lib/api.ts:1737` | `DELETE /api/projects/{id}/webhooks/{wid}` | **project_webhook** | User deletes webhook | Webhook URL, secret, events config |
| D8 | `lib/api.ts:1811` | `DELETE /api/templates/prompt-templates/{id}` | **prompt_template** | User deletes template | Template title, content, description |
| D9 | `components/settings/WhitelabelLogoCard.tsx:70` | `DELETE /api/user-settings/whitelabel-logo` | **directus_files** | User removes logo | File only (no billing impact) |
| D10 | `components/settings/AccountSettingsCard.tsx:87` | `DELETE /api/user-settings/avatar` | **directus_files** | User removes avatar | File only (no billing impact) |
| D11 | `lib/api.ts:965` | `POST /api/chats/{id}/delete-context` | **project_chat_conversation** | User removes conversation from chat | Junction record only |
| D12 | `lib/api.ts:58` | `DELETE /api/participant/.../chunks/{id}` | **conversation_chunk** | Participant deletes their chunk | Chunk transcript, S3 audio path (orphaned!) |
| D13 | (verify settings page) | `DELETE /api/verify/topics/{pid}/custom/{key}` | **verification_topic** | User deletes custom topic | Topic translations SET NULL |

### 4c. Python API → Directus DELETE Calls (System-Initiated)

| # | File | Function | Collection | Trigger | Metadata Lost |
|---|------|----------|------------|---------|---------------|
| D14 | `audio_utils.py:740` | split_audio_chunk | **conversation_chunk** | Audio chunk too large, auto-split | Original replaced by sub-chunks (data preserved) |
| D15 | `api/conversation.py:878` | retranscribe (error path) | **conversation** | Retranscription fails | Partial new conversation (cleanup) |
| D16 | `api/chat.py:1138,1160` + `service/chat.py:296` | ChatService.delete_message | **project_chat_message** | LLM stream error | User's chat message text |
| D17 | `api/participant.py:808` | report subscribe | **project_report_notification_participants** | Participant re-subscribes | Re-created immediately |

### 4d. Directus Hooks/Flows That Delete Data

| Flow | Status | Trigger | What It Does |
|------|--------|---------|-------------|
| Send Email | active | operation (manual trigger) | Sends email, no deletes |
| Send Email Base | active | manual on project | Sends email, no deletes |
| Send Report Emails | active | event on project_report update | Sends notification emails, no deletes |
| Validate create project | **inactive** (draft) | filter on project create | Would validate, no deletes |

**No Directus flows or hooks perform delete operations.**

### 4e. Automated Cleanup

| # | Location | What | Trigger |
|---|----------|------|---------|
| D18 | `audio_utils.py:287` | S3 original audio after format conversion | Audio processing pipeline |
| D19 | `audio_utils.py:751` | S3 files on split failure (cleanup) | Error during chunk splitting |
| D20 | `api/project.py:369` | Local temp files after ZIP download | BackgroundTask after response |
| D21 | `coordination.py:441` | Redis coordination keys | After conversation finalization |

---

## 5. AUTH FLOW

### End-to-End Login

```
Frontend Login.tsx
  → directus.login({ email, password }, { otp })      # Directus SDK
  → Directus POST /auth/login (session mode)
  → Directus sets HTTP-only cookie: directus_session_token
  → Frontend stores nothing (browser cookie jar handles it)
  → Redirect to /projects (or ?next= param)
```

### Session Validation (Frontend)

```
Protected.tsx → useAuthenticated()
  → directus.refresh()                                  # Directus SDK
  → Directus POST /auth/refresh (using session cookie)
  → If fails → logout + redirect to /login
  → staleTime: 60s (re-validates every 60s)
```

### Get Current User (Python)

**File:** `server/dembrane/api/dependency_auth.py`

```python
async def require_directus_session(request: Request) -> DirectusSession:
    # 1. Extract JWT from cookie or Authorization header
    directus_cookie = request.cookies.get(DIRECTUS_SESSION_COOKIE_NAME)
    auth_header = request.headers.get("Authorization")

    # 2. Decode JWT locally (NOT forwarded to Directus)
    decoded = jwt.decode(token=to_decode, key=DIRECTUS_SECRET, algorithms=["HS256"])
    user_id = decoded.get("id")
    is_admin = decoded.get("admin_access", False)

    # 3. Create per-request Directus client scoped to user's token
    client = create_directus_client(token=to_decode)

    return DirectusSession(str(user_id), bool(is_admin), access_token=to_decode, client=client)
```

**Returns:** `DirectusSession` with `user_id` (string), `is_admin` (bool), `access_token`, `client` (user-scoped DirectusClient)

### User Profile Fields (from /me endpoint)

```python
USER_PROFILE_FIELDS = [
    "id", "first_name", "email", "avatar", "disable_create_project",
    "tfa_secret", "whitelabel_logo", "legal_basis", "privacy_policy_url",
    "hide_ai_suggestions",
]
# tfa_secret is replaced with boolean tfa_enabled before returning
```

---

## 6. DIRECTUS CLIENT PATTERN

### Python DirectusClient

**File:** `server/dembrane/directus.py` (975 lines)

**Library:** `requests` (synchronous)

**Two instances:**
1. **Admin client** (module-level): `directus = create_directus_client(token=settings.directus.token)`
2. **User-scoped** (per-request): `create_directus_client(token=user_jwt)` — returned as `session.client`

**CRUD patterns:**

```python
# CREATE — returns {"data": {...}} — MUST unwrap with ["data"]
new = directus.create_item("collection", {"field": "value"})["data"]

# READ (list) — returns data directly (list), requires "query" wrapper
items = directus.get_items("collection", {"query": {"filter": {...}, "fields": [...]}})
# Internally calls: self.search(f"/items/{collection}", query=query)
# Uses HTTP SEARCH method

# READ (single) — returns data directly
item = directus.get_item("collection", item_id)

# UPDATE — returns {"data": {...}}
updated = directus.update_item("collection", item_id, {"field": "value"})["data"]

# DELETE — no return value
directus.delete_item("collection", item_id)

# GET USERS — special method for directus_users
users = directus.get_users({"query": {"filter": {...}, "fields": [...]}})
```

**Filter syntax (Directus operators):**

```python
{"filter": {"field": {"_eq": value}}}
{"filter": {"field": {"_null": True}}}
{"filter": {"field": {"_in": [val1, val2]}}}
{"filter": {"_and": [{"field1": {"_eq": v1}}, {"field2": {"_eq": v2}}]}}
```

**Error handling:**

```python
# Custom exceptions in directus.py:
DirectusGenericException    # Base
DirectusAuthError           # Auth failures
DirectusServerError         # Connection errors
DirectusBadRequest          # 4xx responses

# Retry logic: up to 3 retries with exponential backoff
# Auto re-auth on 401/403 if email/password available
```

**Environment variables:**

| Var | Required | Default | Purpose |
|-----|----------|---------|---------|
| `DIRECTUS_BASE_URL` | No | `http://directus:8055` | Internal Directus URL |
| `DIRECTUS_SECRET` | Yes | — | Shared JWT secret (HS256) |
| `DIRECTUS_TOKEN` | Yes | — | Admin static token |
| `DIRECTUS_SESSION_COOKIE_NAME` | No | `directus_session_token` | Cookie name |

---

## 7. EXISTING PATTERNS

### Multi-User / Sharing / Team Concepts

**None exist.** Projects are owned by a single user via `project.directus_user_id`. All Directus permissions for "Basic User" filter by `directus_user_id = $CURRENT_USER`. No `shared_with`, `collaborators`, `team_id`, or `workspace` fields exist anywhere.

### Soft Delete / Archive Patterns

**None exist.** No `deleted_at` field on any collection. No archive functionality configured. The only "status" field with archive-like values is `project_report.status` which includes `"archived"`, but this is a workflow status, not a soft delete.

### Schema Sync

**Tool:** `directus-sync` (npm package)
**Config:** `directus/directus-sync.config.js` — dumpPath: `./sync`, specs disabled
**Wrapper:** `directus/sync.sh` — supports `push` (source → Directus), `pull` (Directus → source), `diff`
**Output:**
- `sync/collections/` — permissions.json, roles.json, policies.json, flows.json, operations.json, settings.json
- `sync/snapshot/collections/` — one JSON per collection
- `sync/snapshot/fields/<collection>/` — one JSON per field
- `sync/snapshot/relations/<collection>/` — one JSON per relation

**No CI/CD validates schema.** Sync is manual.

### Email

**Handled entirely by Directus Flows** using Liquid templates. Templates in `directus/templates/`:
- `email-base.liquid` — base layout
- `password-reset.liquid`, `user-invite.liquid`, `user-registration.liquid` — auth
- `report-notification-en.liquid`, `report-notification-nl.liquid` — report notifications

**Python does NOT send emails directly.** No SendGrid in the Python backend. This is important for the workspace invite flow — it will need to either use Directus email or add SendGrid to Python.

### Background Tasks (Dramatiq)

- **Broker:** Redis with lz4 compression
- **Queues:** `network` (gevent, most tasks), `cpu` (standard, compute-heavy)
- **17 actors** in `server/dembrane/tasks.py`
- **4 periodic jobs** via APScheduler in `scheduler.py`
- **Middleware:** Results, GroupCallbacks, Workflow, SkipRetryOnUnrecoverableError

---

## 8. PROJECT STRUCTURE

### Python API

```
server/dembrane/
  api/                    # Routes — add new router files here
    api.py                # Router aggregator — register new routers here
    dependency_auth.py    # Auth dependencies
    exceptions.py         # HTTP exception constants
    rate_limit.py         # Redis rate limiters
    project.py, conversation.py, chat.py, ...  # Route files
  service/                # Business logic — add new service classes here
    __init__.py           # Factory functions (build_*_service)
    project.py, conversation.py, chat.py, ...
  directus.py             # DirectusClient wrapper
  settings.py             # All env var config (Pydantic BaseSettings)
  tasks.py                # Dramatiq actors
  utils.py                # General utilities
  async_helpers.py        # Thread pool + async helpers
```

### Frontend

```
frontend/src/
  Router.tsx              # Route definitions — add new routes here
  routes/                 # Page components — add new pages here
    auth/, project/, participant/, settings/
  components/             # Feature-organized — add new components in domain folders
    <domain>/hooks/       # React Query hooks per domain
  lib/
    api.ts                # Centralized API calls — add new API functions here
    directus.ts           # Directus SDK setup
    typesDirectus.d.ts    # Directus schema types — add new collection types here
    types.d.ts            # Frontend-only types
  locales/                # i18n translations
```

---

## 9. PRD RECONCILIATION

### 9a. APP_USER GAP ANALYSIS

The PRD defines `app_user` with: `id`, `directus_user_id`, `email`, `display_name`, `created_at`, `updated_at`.

**Fields on directus_users that are actively used by the app but NOT in PRD's app_user:**

| Field | Used Where | Recommendation |
|-------|-----------|----------------|
| `first_name` | /me endpoint, migration display_name construction, participant project view | **Denormalize** into app_user as `display_name` (concat first+last at migration time) |
| `last_name` | Same as first_name | Folded into `display_name` |
| `avatar` | /me endpoint, settings page | **Fetch from directus_users at runtime** — it's a file reference that changes |
| `disable_create_project` | /me endpoint, project creation gating | **Denormalize** — this is a domain concept |
| `whitelabel_logo` | /me endpoint, branding, participant portal | **Move to workspace** settings (per PRD's workspace.settings or workspace.logo_url) |
| `legal_basis` | /me endpoint, settings, participant consent | **Move to workspace** (PRD already has workspace.legal_basis) |
| `privacy_policy_url` | /me endpoint, settings, participant consent | **Move to workspace** (PRD already has workspace.privacy_policy_url) |
| `tfa_secret` | /me endpoint (as tfa_enabled boolean) | **Never denormalize** — sensitive, stays in directus_users |
| `quick_access_preferences` | Template quick access | **Stays in directus_users** — per-user UI preference |
| `hide_ai_suggestions` | Template suggestions toggle | **Stays in directus_users** — per-user UI preference |
| `email` | /me endpoint, various lookups | **Denormalize** (PRD already includes this) |
| `role` (Directus role ID) | Admin checks via JWT `admin_access` claim | **Do NOT denormalize** — resolved from JWT |

**Summary:** app_user should add `disable_create_project` beyond what the PRD specifies. The whitelabel/legal_basis/privacy_policy fields should move from directus_users to workspace-level settings (which the PRD already plans). `avatar` stays as a runtime fetch from directus_users.

### 9b. COLLECTION NAME CHECK

| PRD Says | Actual Codebase | Match? | Notes |
|----------|----------------|--------|-------|
| `conversation` | `conversation` | YES | |
| `project` | `project` | YES | |
| `chat` | `project_chat` | **NO** | PRD says "chat (or whatever the chat/message collection is called)". Actual name is `project_chat` with messages in `project_chat_message` |
| `report` | `project_report` | **NO** | PRD says "report". Actual name is `project_report` |
| `conversation.duration_seconds` | `conversation.duration` | **NO** | PRD references `duration_seconds`. Actual field is `duration` (float, stores seconds) |
| — | `chat` collection | — | There's a **separate legacy `chat` collection** (uuid id, title, user_created/updated). Appears unused. Not the same as `project_chat`. |

### 9c. API PATTERN CHECK

| PRD Pattern | Actual Pattern | Match? |
|-------------|---------------|--------|
| `await directus.get(f"/items/project/{id}")` | `directus.get_item("project", id)` | **NO** — Python uses wrapper methods, not raw path construction |
| `await directus.patch(f"/items/conversation/{id}", {...})` | `directus.update_item("conversation", id, {...})` | **NO** — uses `update_item` not raw `patch` |
| `await directus.get("/items/workspace_membership", {"filter": ...})` | `directus.get_items("workspace_membership", {"query": {"filter": ...}})` | **NO** — requires `{"query": {...}}` wrapper |
| `await directus.post("/items/app_user", {...})` | `directus.create_item("app_user", {...})["data"]` | **NO** — uses `create_item` and must unwrap `["data"]` |
| `async def` (PRD shows async functions) | DirectusClient is **synchronous** (uses `requests` library) | **NO** — no `await` needed |
| `directus.search()` returns `{"error": ...}` on failure | Actual: returns dict, must check `isinstance(result, list)` | Correct in CLAUDE.md but PRD examples don't show this |

**Critical:** The PRD's example code uses raw HTTP-style calls (`directus.get("/items/...")`, `directus.patch(...)`) but the actual codebase uses typed wrapper methods (`get_item`, `get_items`, `create_item`, `update_item`, `delete_item`). All PRD code examples need translation.

### 9d. PERMISSION MODEL CHECK

| PRD Assumption | Reality | Conflict? |
|----------------|---------|-----------|
| All deletes through Python API | Project delete currently goes Frontend → Directus SDK directly | **YES** — must reroute before soft delete |
| Chat delete through Python | Chat delete goes Frontend → Directus SDK directly | **YES** — must reroute |
| Directus roles have DELETE permissions | Basic User policy has DELETE on: conversation, project, project_chat, project_tag, view, aspect, conversation_artifact, etc. | Compatible — these can remain for backward compat during migration |
| Admin check via Directus | Auth uses JWT claim `admin_access` from Directus | Compatible |
| workspace_membership checks | No membership tables exist yet | N/A — new |

### 9e. CONFLICT CHECK

| Conflict | Details | Severity |
|----------|---------|----------|
| Legacy `chat` collection | A separate `chat` collection exists (not `project_chat`). It has `id`, `title`, `user_created`, `user_updated`. Appears unused but may confuse schema. | LOW — verify it's truly unused, then ignore |
| `project.directus_user_id` stays after workspace migration | PRD says to keep for backward compat. The field has `on_delete: SET NULL` to directus_users. No conflict, but need to decide when to stop using it. | LOW |
| `project_report.project_id` is SET NULL (not CASCADE) | Unlike most relations, deleting a project does NOT delete its reports. Reports survive project deletion. This is actually good for billing — but means soft delete of projects won't automatically "hide" their reports. | MEDIUM — reports need their own `deleted_at` filter, or need to join through project |
| `project_webhook.project_id` is SET NULL | Same as reports — webhooks survive project deletion | LOW |
| `verification_topic.project_id` is SET NULL | Topics survive project deletion | LOW |
| No `duration_seconds` field | PRD references `duration_seconds` but field is `duration` (float) | LOW — just use correct field name |
| `project_report.id` is bigInteger | Not UUID like other collections. PRD assumes UUID for all new collections. | LOW — only matters if we FK to it |

### 9f. RISK REGISTER

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| 1 | **Project delete bypasses Python entirely** — goes Frontend → Directus SDK. Soft delete conversion requires rerouting this through Python first. If missed, projects can still be hard-deleted. | HIGH (it's the current behavior) | CRITICAL (destroys all data) | Session 3 must create a Python endpoint for project delete AND update the frontend hook to call it. Remove Directus DELETE permission for Basic User on project collection. |
| 2 | **Chat delete also bypasses Python** — same issue as project. Frontend calls `directus.request(deleteItem("project_chat", id))` directly. | HIGH | HIGH (destroys chat history) | Same mitigation as #1 — new Python endpoint, update frontend, restrict Directus permissions. |
| 3 | **CASCADE deletes are destructive** — deleting a project cascades to 10+ tables. Even with soft delete on project, if any code path still does a hard DELETE, all cascaded data is gone forever. Must ensure NO hard delete paths remain after conversion. | MEDIUM | CRITICAL | Audit all code paths in Session 3. Consider removing CASCADE constraints and replacing with application-level soft cascade. |
| 4 | **Email sending is in Directus, not Python** — the PRD assumes workspace invites will use SendGrid from Python. But the current codebase has NO email capability in Python. All email goes through Directus Flows with Liquid templates. | HIGH | MEDIUM (blocks invite flow) | Either: (a) add SendGrid to Python for invite emails, or (b) create a Directus Flow triggered via Directus API from Python, or (c) use Directus's built-in mail API from Python. |
| 5 | **Synchronous DirectusClient** — the DirectusClient uses `requests` (blocking). In FastAPI async endpoints, this blocks the event loop. The PRD shows `async def` + `await` patterns but the client is synchronous. At scale with workspace permission checks on every request, this could become a bottleneck. | MEDIUM | MEDIUM (performance) | For now, wrap in `run_in_thread_pool()` (already used elsewhere in the codebase). Long-term, consider an async client. |

---

## 10. SUMMARY OF CRITICAL FINDINGS

### Must Address Before Session 2 (Schema)

1. **Collection name corrections for PRD:** `project_chat` (not "chat"), `project_report` (not "report"), `conversation.duration` (not `duration_seconds`)
2. **app_user needs `disable_create_project`** field added beyond PRD spec
3. **whitelabel_logo, legal_basis, privacy_policy_url** should move from directus_users to workspace — PRD already handles this via `workspace.settings`, `workspace.legal_basis`, `workspace.privacy_policy_url`

### Must Address Before Session 3 (Soft Delete)

1. **Route project delete through Python** — currently Frontend → Directus direct
2. **Route chat delete through Python** — currently Frontend → Directus direct
3. **Route tag delete through Python** — currently Frontend → Directus direct
4. **Email capability in Python** — needed for workspace invites (or use Directus mail API)

### Must Address Before Session 4 (Core API)

1. **Translate all PRD code examples** from raw HTTP patterns to actual DirectusClient wrapper methods
2. **All DirectusClient calls are synchronous** — use `run_in_thread_pool()` for async endpoints
3. **`get_items` requires `{"query": {...}}` wrapper** — PRD examples miss this
4. **`create_item` returns `{"data": {...}}`** — must unwrap with `["data"]`

---

## 10a. CASCADE & Hard Delete Analysis

### PostgreSQL Triggers

**None exist.** Zero custom PostgreSQL triggers in this codebase. The `.devcontainer/docker-compose.yml` mounts `./init.sql:/docker-entrypoint-initdb.d/init.sql` but that path is an empty directory. No Directus extensions install triggers either (`directus/extensions/` is empty).

### PostgreSQL Constraints Beyond Directus

**None exist.** All database schema is managed exclusively through Directus's snapshot system. While `alembic` appears in `pyproject.toml` as a dependency, no actual Alembic migration directory or `alembic.ini` exists. No `.sql` files with `ALTER TABLE...ADD CONSTRAINT` or `CREATE INDEX` exist anywhere.

All FK constraints and their `on_delete` behaviors are defined solely in `directus/sync/snapshot/relations/`.

### Remaining Hard DELETE Paths After Soft Delete Conversion

When we convert to soft delete (PATCH `deleted_at = now()`), the CASCADE constraints won't fire — they only trigger on actual SQL `DELETE`. However, these paths could still perform hard DELETEs:

#### Frontend → Directus SDK Direct (MUST reroute before removing permissions)

| # | File | Line | What | Collection |
|---|------|------|------|------------|
| 1 | `frontend/src/components/project/hooks/index.ts` | 105 | `useDeleteProjectByIdMutation` → `deleteItem("project", projectId)` | **project** |
| 2 | `frontend/src/components/chat/hooks/index.ts` | 72 | `useDeleteChatMutation` → `deleteItem("project_chat", payload.chatId)` | **project_chat** |
| 3 | `frontend/src/components/project/hooks/index.ts` | 193 | `useDeleteTagByIdMutation` → `deleteItem("project_tag", tagId)` | **project_tag** |

These go through the user's Directus session token and rely on Directus DELETE permissions.

#### Python Backend (use admin token — will still work after permission removal)

| # | File | Line | What | Collection |
|---|------|------|------|------------|
| 4 | `server/dembrane/service/project.py` | 135 | `ProjectService.delete()` — dead code, not called from any route | project |
| 5 | `server/dembrane/service/conversation.py` | 372 | `ConversationService.delete()` — called from DELETE endpoint | conversation |
| 6 | `server/dembrane/api/project.py` | 850-852 | Report delete endpoint — uses admin client | project_report |
| 7 | `server/dembrane/service/chat.py` | 299 | `ChatService.delete_message()` — error cleanup | project_chat_message |
| 8 | `server/dembrane/audio_utils.py` | 740 | Chunk split — replaces original with sub-chunks | conversation_chunk |
| 9 | `server/dembrane/api/conversation.py` | 878 | Retranscription error cleanup | conversation |

#### Directus Admin Panel

**Yes, Administrator role users can hard-delete anything via the Directus UI.** The Administrator policy has `admin_access: true` granting full CRUD. This cannot be prevented without Directus hooks — but admin users are trusted internal staff, so this is acceptable.

### Current DELETE Permissions (Basic User Policy)

All under policy `37a60e48-dd00-4867-af07-1fb22ac89078` ("Basic User Policy"), which applies to both "Basic User" and "Enterprise User" roles:

| Collection | Permission Filter | Scope |
|------------|------------------|-------|
| `project` | `directus_user_id._eq: $CURRENT_USER` | Owner only |
| `conversation` | `project_id.directus_user_id._eq: $CURRENT_USER` | Project owner only |
| `project_chat` | `project_id.directus_user_id._eq: $CURRENT_USER` | Project owner only |
| `project_report` | **No DELETE permission exists** | Deletion uses admin token from backend |
| `conversation_artifact` | via project owner chain | Project owner only |
| `conversation_chunk` | via project owner chain | Project owner only |
| `project_tag` | via project owner chain | Project owner only |
| `project_chat_message` | via project owner chain | Project owner only |
| `project_chat_conversation` | unrestricted (null filter) | Any user |
| `project_analysis_run` | via project owner chain | Project owner only |
| `project_webhook` | via project owner chain | Project owner only |
| `view` | via project owner chain | Project owner only |
| `verification_topic` | unrestricted (null filter) | Any user |

### Recommendation: Remove DELETE Permissions

**Yes — remove DELETE permissions on `project`, `conversation`, `project_chat`, and `project_tag` from the Basic User Policy after soft delete conversion.**

**Migration order (must follow this sequence):**

1. Create Python BFF soft-delete endpoints for project, chat, tag
2. Update frontend hooks to call BFF endpoints instead of Directus SDK
3. Remove DELETE permission on `project` from Basic User Policy
4. Remove DELETE permission on `project_chat` from Basic User Policy
5. Remove DELETE permission on `conversation` from Basic User Policy (already routed through Python, but defense-in-depth)
6. **Keep** DELETE on junction tables (`project_chat_conversation`, `conversation_project_tag`) — used for legitimate detach operations, not data destruction

**Benefits:**
- Eliminates all user-initiated hard-delete paths on core data
- Makes the CASCADE chain (`project` → 10+ tables) impossible to trigger from user operations
- Forces all deletes through controlled backend endpoints with soft-delete + usage event emission

**Risks:**
- If any frontend code still calls `deleteItem` via user session after permission removal, it gets a 403. Must complete step 2 before step 3.
- Backend service methods use the admin client and are unaffected by permission changes.

---

## 10b. Legacy `chat` Collection Status

### Verification Results

The legacy `chat` collection (distinct from `project_chat`) has been thoroughly investigated:

| Check | Result |
|-------|--------|
| Seed data | No references in `seed.py` or any fixture files |
| Python SDK calls | Zero: no `get_items("chat"`, `create_item("chat"`, etc. |
| Frontend SDK calls | Zero: no `readItems("chat"`, `createItem("chat"`, etc. |
| TypeScript types | No `Chat` interface in `typesDirectus.d.ts` (only `ProjectChat`) |
| Directus permissions | No DELETE/CREATE/UPDATE permissions for `chat` collection |
| Directus flows | No flows reference `chat` collection |
| Relations | Only standard audit fields (`user_created`, `user_updated` → `directus_users`). No other collection has FK to `chat`. |
| Tests | Zero references |

The only grep hits for `"chat"` in code are:
- `APIRouter(tags=["chat"])` — OpenAPI tag for the `project_chat` router (not the collection)
- `"chat": {` in `service/__init__.py` — exception dict key for ChatService (operates on `project_chat`)

### Conclusion

**Legacy `chat` collection confirmed unused. To be removed in Session 2 schema work.**

Files to remove from sync snapshot:
- `directus/sync/snapshot/collections/chat.json`
- `directus/sync/snapshot/fields/chat/*.json` (6 files)
- `directus/sync/snapshot/relations/chat/*.json` (2 files)

The `chat` table should also be dropped from the database in each environment after confirming zero rows via Directus admin UI.

---

## 10c. Email Capability for Workspace Invites

### Current Email Configuration

**Directus uses SendGrid via SMTP relay** (not the SendGrid API directly).

From `directus/.env`:
```
EMAIL_TRANSPORT="smtp"
EMAIL_FROM="do-not-reply@dembrane.com"
EMAIL_SMTP_HOST="smtp.sendgrid.net"
EMAIL_SMTP_PORT=587
EMAIL_SMTP_USER="apikey"
EMAIL_SMTP_PASSWORD="SG.****"
```

The SendGrid API key is used as an SMTP password (standard SendGrid SMTP auth pattern).

### Existing Email Templates

| Template | Purpose |
|----------|---------|
| `email-base.liquid` | Base layout (Dembrane logo, styling) |
| `user-invite.liquid` | Directus user invitation ("Join {{ projectName }}") |
| `user-registration.liquid` | Email verification after registration |
| `password-reset.liquid` | Password reset |
| `report-notification-en.liquid` | English report notification |
| `report-notification-nl.liquid` | Dutch report notification |

### Can We Trigger Directus Flows from Python?

The "Send Email" flow has `trigger: "operation"` — it can only be invoked from within another Directus Flow, NOT via `POST /flows/trigger/:flow_id` (which requires `trigger: "manual"` or `trigger: "webhook"`).

The "Send Email Base" flow has `trigger: "manual"` but is hardcoded to send to `sameer@dembrane.com` — a test/debug flow.

**No webhook-triggered email flow exists currently.**

### Python Email Dependencies

**Zero.** No `sendgrid`, `python-sendgrid`, `emails`, `aiosmtplib`, or any email package in `pyproject.toml`. No `SENDGRID_API_KEY` or `SMTP_*` env vars in server settings.

### Directus `/utils/mail` Endpoint

**Not used anywhere in the codebase currently**, but the `DirectusClient` has generic `.post()` that could call it. This endpoint requires admin-level token (which the server already has).

### Recommendation: Use Directus `POST /utils/mail/send`

**Option 1 (Recommended): Directus `/utils/mail/send` from Python**

```python
# Using the existing admin DirectusClient
directus.post("/utils/mail/send", json={
    "to": "invitee@example.com",
    "subject": "You've been invited to collaborate",
    "template": {
        "name": "workspace-invite",
        "data": {
            "url": "https://app.dembrane.com/...",
            "workspaceName": "Client Project",
            "inviterName": "Sameer",
        }
    }
})
```

**What's needed:**
- Create a new `workspace-invite.liquid` template in `directus/templates/` (extend `email-base.liquid`)
- No new Python dependencies
- No new environment variables
- Reuses existing SendGrid SMTP relay
- Works with the existing admin `DirectusClient` singleton

**Other options considered but NOT recommended:**

| Option | Why Not |
|--------|---------|
| Add `sendgrid` Python SDK | New dependency, duplicate transport config, need new env vars |
| Create webhook-triggered Directus Flow | More complex, constrained payload format, harder to maintain |
| Use `smtplib` directly | Reinventing the wheel, need SMTP config in Python |

---

*End of Codebase Exploration Report — Session 1*
