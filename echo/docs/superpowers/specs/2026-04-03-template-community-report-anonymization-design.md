# Design: Template Fixes, Community Removal, Report Colors, Anonymization UX

**Date**: 2026-04-03
**Status**: Approved

## 1. Template Quick Access -- Simplify to JSON

### Problem

The current `prompt_template_preference` collection stores each quick access item as a separate Directus record. This causes:
- Duplicate entries (same template appearing multiple times)
- Orphaned entries (`template_type: "user"` with `prompt_template_id: null`)
- No backend validation (saves whatever frontend sends)
- Unnecessary complexity for a simple ordered list

### Solution

Replace separate Directus records with a single JSON field on the user settings.

**New field**: `quick_access_preferences` (JSON) on `directus_users` or appropriate user settings collection.

**Schema**:
```json
[
  {"type": "static", "id": "summarize"},
  {"type": "static", "id": "meeting-notes"},
  {"type": "user", "id": "abc-123"}
]
```

**Backend**:
- New `GET /templates/quick-access` endpoint: reads the JSON field, returns the array (empty array default)
- New `PUT /templates/quick-access` endpoint: validates and writes the JSON field
- Validation rules:
  - Max 5 items
  - No duplicate (type, id) pairs
  - Each entry must have `type` in ("static", "user") and non-empty `id`
  - For `type: "user"`, verify the template exists and belongs to the user
- Remove old preference CRUD endpoints that interact with `prompt_template_preference` collection
- Remove `PromptTemplatePreferenceOut` and `QuickAccessPreferenceIn` schemas

**Frontend**:
- Update API client functions to use new endpoints
- Update hooks (`useQuickAccessPreferences` or equivalent) to work with the new JSON shape
- Add client-side dedup as a safety net before saving
- Remove `QuickAccessConfigurator.tsx` if unused

**Directus field needed** (user to create manually):
- Collection: `directus_users` (or user settings collection -- confirm with user)
- Field name: `quick_access_preferences`
- Type: JSON
- Default: `[]`
- Nullable: true

## 2. Community Code -- Full Removal

### What to delete

**Backend** (`server/dembrane/api/template.py`):
- Endpoints: `GET /community`, `GET /community/my-stars`, `POST /{id}/publish`, `POST /{id}/unpublish`, `POST /{id}/star`, `POST /{id}/copy`, `POST /ratings`, `DELETE /ratings/{id}`, `GET /ratings`
- Schemas: `CommunityTemplateOut`, `PublishTemplateIn`, `PromptTemplateRatingIn`, `PromptTemplateRatingOut`, `ALLOWED_TAGS`

**Frontend**:
- Hook file: `frontend/src/components/chat/hooks/useCommunityTemplates.ts` (delete entire file)
- Community sections in `TemplatesModal.tsx` (community tab/list, publish/unpublish UI, star UI, copy UI)
- API client functions in `frontend/src/lib/api.ts` (community-related fetch/mutation functions)

**Not deleted**: The `prompt_template_rating` and related Directus collections remain in the database (no destructive migration). They just become unused.

## 3. Report Buttons -- Teal to Blue

### Problem

All primary action buttons in the report feature use `color="teal"`. The brand style guide specifies Royal Blue (#4169e1) for primary buttons.

### Fix

Change `color="teal"` to `color="blue"` in these 6 instances:

1. `frontend/src/components/report/CreateReportForm.tsx` -- "Schedule Report" button
2. `frontend/src/components/report/CreateReportForm.tsx` -- "Generate now" button
3. `frontend/src/components/report/UpdateReportModalButton.tsx` -- "Update Report"/"New Report" trigger button
4. `frontend/src/components/report/UpdateReportModalButton.tsx` -- "Schedule Report" button
5. `frontend/src/components/report/UpdateReportModalButton.tsx` -- "Generate now" button
6. `frontend/src/routes/project/report/ProjectReportRoute.tsx` -- "Confirm reschedule" button

Mantine's `color="blue"` maps to a blue range that aligns with Royal Blue.

## 4. Anonymization UX

### 4a. Participant Anonymization Notice (Recording Page)

**Where**: The initial message/instruction area shown to participants before they start recording (in `ParticipantConversationAudio` and `ParticipantConversationText` or their shared parent).

**When shown**: When the conversation's `is_anonymized` flag is true.

**Content**: Muted text appended to the existing welcome/instruction content:
> "Your transcription will be anonymized and your host will not be able to listen to your recording."

**Style**:
- Muted/dimmed text (e.g., `c="dimmed"`, smaller font size)
- Part of the existing instruction flow, not a separate banner or alert
- Should feel informational, not alarming

**Translations**: All 6 languages (en-US, nl-NL, de-DE, fr-FR, es-ES, it-IT).

**Data flow**: The `is_anonymized` field is already on the conversation object returned by the API. The participant components already have access to conversation data.

### 4b. Host Confirmation Modal (Portal Editor)

**Where**: `ProjectPortalEditor.tsx`, on the anonymize transcripts toggle.

**When triggered**: Only when toggling from ON to OFF (not when turning ON).

**Modal content**:
- Title: "Turn off anonymization?"
- Body: "Turning off anonymization while recordings are ongoing may have unintended consequences. Active conversations will also be affected mid-recording. Please use this with caution."
- Buttons: "Cancel" (default) and "Turn off" (destructive/red)

**Behavior**:
- If user confirms: proceed with the toggle, save the setting
- If user cancels: revert the toggle, no change saved
- No modal when turning ON (enabling anonymization is always safe)

## Out of Scope

- Migration of existing `prompt_template_preference` data to new JSON format (old records can be ignored; users get fresh defaults)
- Delete the `prompt_template_preference` Directus collection (replaced by JSON field)
- Deleting `prompt_template_rating` Directus collection
- Changing other button colors outside the report feature
