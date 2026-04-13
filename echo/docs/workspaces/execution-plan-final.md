# Execution Plan: Workspaces Implementation
## Refined for Solo Developer + Claude Code

---

## Engineering Principles

### What we follow

**Strangler Fig Pattern** — Don't rewrite. Wrap. The workspace layer grows around existing functionality. At no point does the existing system stop working.

**Expand and Contract** — First, add new fields and tables (expand). Then, migrate data. Then, update code to use new paths. Finally, deprecate old paths (contract). Never do these in the same commit.

**Make the Change Easy, Then Make the Easy Change** (Kent Beck) — If a change is hard, first refactor to make it easy (that's a separate commit), THEN make the change.

**One Commit, One Concern** — Each commit does exactly one thing. "Add deleted_at field to conversation" is one commit. "Convert conversation delete to soft delete" is another commit. Never both.

**Reversibility** — Every commit should be revertible without data loss. Schema additions (new fields, new tables) are safe. Schema modifications (changing types, renaming) are risky. Data mutations (migration) need a backup.

**The Campsite Rule** — Leave the code better than you found it, but don't refactor unrelated things in a workspace commit. Stay focused.

### What we DON'T do

**No Big Bang.** We don't build everything and then flip a switch. Each commit is deployable.

**No Premature Abstraction.** Don't build a "generic soft delete framework." Just convert each delete one at a time. The pattern will emerge.

**No Future-Proofing Beyond One Step.** `app_user` is one step of future-proofing (we know auth migration is coming). Don't add fields "just in case." Add them when needed.

**No Gold Plating.** The usage dashboard doesn't need charts in the first pass. A JSON response from the API is enough. The UI comes later.

**No Mixing Concerns.** A session about schema doesn't touch Python routes. A session about API doesn't touch frontend. Separation is discipline.

---

## Session Plan

Four sessions. Each produces commits on the `workspaces` branch.

```
Session 1: EXPLORE (no code changes)
    ↓
Session 2: SCHEMA (Directus collections + soft delete fields)
    ↓
Session 3: SOFT DELETE CONVERSION (reroute deletes through Python)
    ↓
Session 4: CORE API (workspace/org endpoints + migration script)
```

Frontend is a separate effort AFTER backend is solid. Not covered here.

---

## Session 1: EXPLORE

**Goal:** Understand the codebase. Reconcile PRD with reality. Produce updated PRD.
**Output:** `codebase-exploration-report.md` + `workspaces-prd-v4.md` (reconciled)
**Commits:** None. Read-only session.
**Duration estimate:** 1 session

### What the agent does

1. Map every Directus collection (especially `directus_users` — ALL custom fields)
2. Map every Python API route (method, path, what it does, auth pattern)
3. Map every frontend route (for awareness, not modification)
4. Inventory every delete operation in the codebase
5. Map the auth flow (cookie → Directus → Python)
6. Map the Directus client/wrapper used by Python
7. Check: what fields does `directus_users` have that `app_user` is missing?
8. Check: what Directus roles exist and what permissions are configured?
9. Check: does the project collection already have any sharing/team fields?
10. Check: is there an existing `deleted_at` or archive pattern anywhere?

Then reconcile with PRD and produce updated version.

### Prompt for Claude Code

```
Read the entire codebase. Do not make any changes.

I'm planning a major feature: adding Organizations and Workspaces to this platform.
Before I start, I need to understand exactly what exists.

Produce a report (`codebase-exploration-report.md`) covering:

1. DIRECTUS SCHEMA
   For every collection in the Directus schema (check the schema sync files
   or query the Directus API):
   - Collection name, all fields with types
   - Relations to other collections
   - Pay SPECIAL attention to directus_users — list EVERY field including custom ones
   - Pay SPECIAL attention to project — list EVERY field

2. PYTHON API ROUTES
   For every route in the FastAPI app:
   - Method + path + what it does (1 line)
   - How it authenticates (admin token vs user cookie)
   - What Directus collections it reads/writes
   - Does it delete anything? If so, what collection and how?

3. DELETE INVENTORY
   Every place data is deleted, anywhere in the codebase:
   - File path + line number (or function name)
   - What collection
   - Frontend→Directus direct, Frontend→Python, or Python→Directus?
   - What metadata would be lost if this row is deleted?
     (e.g., conversation delete loses duration_seconds)

4. AUTH FLOW
   - How does login work end-to-end?
   - What does the Python API's "get current user" function look like?
   - What user fields does it return?
   - How is the Directus client configured in Python? (wrapper class? raw fetch?)

5. DIRECTUS CLIENT PATTERN
   - How does Python call Directus? Show the actual code pattern.
   - Is there a wrapper/helper class?
   - How are filters constructed?
   - How is error handling done?

6. EXISTING PATTERNS
   - Any existing multi-user, sharing, or team concepts?
   - Any existing soft delete or archive patterns?
   - How is the Directus schema synced (show the config/setup)?

After producing the report, read the attached PRD (workspaces-prd-v3-final.md) and
produce a reconciliation section at the end of the report noting:
   - Fields missing from app_user that directus_users has
   - Any collection names that don't match PRD assumptions
   - Any API patterns that don't match PRD assumptions
   - Any conflicts or surprises
```

**Attach:** `workspaces-prd-v3-final.md`

### Success criteria
- [ ] Can answer: "What exact fields does directus_users have?"
- [ ] Can answer: "What are all the delete operations and what metadata do they lose?"
- [ ] Can answer: "What's the exact pattern for calling Directus from Python?"
- [ ] PRD discrepancies identified with specific corrections

---

## Session 2: SCHEMA

**Goal:** Create all new Directus collections. Add soft delete fields to existing collections.
**Output:** Series of commits, each adding one collection or modifying one existing collection.
**Duration estimate:** 1 session

### Commit sequence

```
commit 1: "chore: create app_user collection"
  - Create app_user in Directus with ALL fields from reconciliation
  - Include directus_user_id as unique FK
  - Sync schema via directus-extension-sync

commit 2: "chore: create org and org_membership collections"
  - org: id, name, slug, logo_url, created_by→app_user, deleted_at, timestamps
  - org_membership: id, org_id→org, user_id→app_user, role, deleted_at, timestamps
  - Sync schema

commit 3: "chore: create workspace and workspace_membership collections"
  - workspace: id, org_id→org, name, slug, tier, billed_to→workspace,
    is_default, legal_basis, privacy_policy_url, logo_url, settings,
    deleted_at, created_by→app_user, timestamps
  - workspace_membership: id, workspace_id→workspace, user_id→app_user,
    role, source, is_external, deleted_at, timestamps
  - Sync schema

commit 4: "chore: create workspace_invite and project_user collections"
  - workspace_invite: id, workspace_id→workspace, email, role,
    invited_by→app_user, token, expires_at, accepted_at, timestamps
  - project_user: id, project_id→project, user_id→app_user, role,
    granted_by→app_user, timestamps
  - Sync schema

commit 5: "chore: create usage_event collection"
  - id, trace_id, org_id, workspace_id, project_id, user_id,
    event_type, event_data (json), created_at
  - No deleted_at (append-only, never deleted)
  - Sync schema

commit 6: "chore: add workspace_id and visibility fields to project"
  - workspace_id: M2O → workspace, nullable
  - visibility: string, default 'workspace'
  - Sync schema

commit 7: "chore: add deleted_at to existing collections"
  - Add deleted_at (timestamp, nullable) to:
    conversation, project, chat (whatever it's called), report
  - Sync schema
```

### Prompt for Claude Code

```
We're on branch `workspaces`. Make the following changes as SEPARATE COMMITS.
Each commit should ONLY contain schema changes synced via directus-extension-sync.
Do NOT modify any Python code or frontend code in this session.

Use the Directus admin API or whatever method this project uses to create collections
(check the codebase exploration report for the exact pattern).

After each collection is created, sync the schema using the project's
directus-extension-sync setup.

[Include commit sequence from above]

Use the codebase exploration report to:
- Match the exact Directus field types used in this project
- Match the exact relation configuration pattern
- Match the schema sync workflow
- Include ALL app_user fields identified in the reconciliation
  (not just the ones in the original PRD)

IMPORTANT: This session is schema-only. No Python code. No frontend code.
No migration logic. Just Directus collections and schema sync.
```

**Attach:** `codebase-exploration-report.md` + `workspaces-prd-v4.md`

### Success criteria
- [ ] All 7 commits on branch
- [ ] Schema synced after each commit
- [ ] Can CRUD each new collection via Directus API
- [ ] project.workspace_id exists and is nullable
- [ ] deleted_at exists on all required collections

---

## Session 3: SOFT DELETE CONVERSION

**Goal:** Convert all delete operations to soft deletes. Route everything through Python.
**Output:** Series of commits, one per delete operation converted.
**Duration estimate:** 1 session

### Commit sequence (order determined by exploration report)

```
commit 1: "feat: add emit_usage_event utility"
  - Create utility function in Python API
  - Fire-and-forget, never fails parent operation
  - Posts to usage_event collection via Directus API
  - Always includes "v": 1 in event_data

commit 2: "refactor: convert conversation delete to soft delete"
  - Create/update Python endpoint: DELETE /api/v1/conversations/:id
  - Soft delete: PATCH deleted_at via Directus API
  - Emit usage event: conversation.deleted with duration_seconds snapshot
  - Update frontend to call Python API (not Directus direct)
  - Purge audio file if applicable

commit 3: "refactor: convert project delete to soft delete"
  - Same pattern
  - Emit: project.deleted with conversation_count, total_audio_hours

commit 4: "refactor: convert chat delete to soft delete"
  - Same pattern
  - Emit: chat.deleted

commit 5: "refactor: convert report delete to soft delete"
  - Same pattern
  - Emit: report.deleted

commit N: (one commit per remaining delete operation found in exploration)

commit N+1: "refactor: add deleted_at filter to all read queries"
  - Audit every Directus read call in Python API
  - Add filter: { "deleted_at": { "_null": true } }
  - Audit every Directus read call in frontend (if any)
  - Add same filter

commit N+2: "test: verify soft deletes work end-to-end"
  - Test each delete: item disappears from reads, usage event emitted
  - Document in commit message what was tested
```

### Prompt for Claude Code

```
We're on branch `workspaces`, continuing from the schema commits.

TASK: Convert all delete operations in the codebase to soft deletes.

STEP 1: Create the emit_usage_event utility (see PRD for implementation).
         Put it wherever utility functions live in this codebase.

STEP 2: For each delete operation listed in the codebase exploration report,
         create a SEPARATE COMMIT that:
         a) Creates or updates a Python API endpoint for the delete
         b) Changes it from hard DELETE to PATCH { deleted_at: now() }
         c) Emits a usage_event with metadata snapshot BEFORE soft deleting
            (so we capture duration_seconds, counts, etc.)
         d) Updates the frontend to call the Python endpoint
            (if it was previously calling Directus directly)
         e) Handles any binary file cleanup (audio files can be hard-deleted)

STEP 3: Create ONE commit that adds { "deleted_at": { "_null": true } } filter
         to ALL existing read queries across the codebase.

METADATA TO SNAPSHOT (per collection):
- conversation: duration_seconds, audio_hours (duration/3600), project_id
- project: conversation_count, total_audio_hours (sum of conversations)
- chat: message_count, project_id
- report: project_id

PATTERN:
  async def delete_conversation(conversation_id, current_user):
      conv = await directus.get(f"/items/conversation/{conversation_id}")
      project = await directus.get(f"/items/project/{conv['project_id']}")

      await emit_usage_event(
          "conversation.deleted",
          {"v": 1, "duration_seconds": conv.get("duration_seconds", 0), ...},
          workspace_id=project.get("workspace_id"),
          user_id=current_user.id,
      )

      await directus.patch(f"/items/conversation/{conversation_id}", {
          "deleted_at": datetime.utcnow().isoformat()
      })

Follow the EXACT Directus client pattern from this codebase.
Each commit = one delete operation converted. Atomic and reviewable.
```

**Attach:** `codebase-exploration-report.md` + `workspaces-prd-v4.md`

### Success criteria
- [ ] Every delete operation is soft
- [ ] Every soft delete emits a usage event with billing metadata
- [ ] All read queries filter deleted_at IS NULL
- [ ] No frontend→Directus direct deletes remain
- [ ] Deleted items don't appear in any UI

---

## Session 4: CORE API + MIGRATION

**Goal:** Implement workspace/org API endpoints and the migration script.
**Output:** Series of commits building up the API surface.
**Duration estimate:** 1-2 sessions (this is the biggest one)

### Commit sequence

```
FOUNDATION:
commit 1: "feat: add get_workspace_context middleware"
  - FastAPI dependency that validates workspace access
  - Returns WorkspaceContext with workspace_id, user, role
  - 403 if no access

commit 2: "feat: add permission resolution helpers"
  - get_user_project_access()
  - get_user_accessible_workspaces()
  - Uses Directus API calls, returns resolved access objects

WORKSPACE CRUD:
commit 3: "feat: GET /api/v1/workspaces — list accessible workspaces"
  - Used by workspace selector
  - Returns workspaces with role, source, counts, is_external

commit 4: "feat: POST /api/v1/workspaces — create workspace"
  - Creates workspace in user's org
  - Auto-adds creator as owner
  - Auto-adds org admins as inherited members
  - Emits workspace.created + workspace.member_added events

commit 5: "feat: GET/PATCH/DELETE workspace endpoints"
  - Detail, update, soft delete
  - Delete blocked if workspace has projects

MEMBERSHIP:
commit 6: "feat: workspace membership CRUD"
  - List (includes inherited org admins in separate section)
  - Invite by email (existing user → immediate, new user → invite)
  - Change role
  - Remove (soft delete)
  - Emits member_added / member_removed events

commit 7: "feat: workspace invite flow"
  - Create invite with secure token
  - Send email via SendGrid
  - Accept endpoint (validates token, creates membership)
  - Post-registration hook: check for pending invites

ORG:
commit 8: "feat: org CRUD + membership endpoints"
  - List user's orgs
  - Update org (name, logo)
  - Org member management
  - Role changes propagate inherited workspace memberships

USAGE:
commit 9: "feat: usage summary endpoint"
  - GET /api/v1/workspaces/:id/usage
  - Aggregates from usage_event table
  - Per-project breakdown

commit 10: "feat: org billing rollup endpoint"
  - GET /api/v1/orgs/:id/billing
  - Sums across all org workspaces

MIGRATION:
commit 11: "feat: migration script — create orgs and workspaces for existing users"
  - Creates app_user for each directus_user
  - Creates org + workspace + memberships
  - Moves projects into default workspace
  - Dry-run mode, idempotent, per-user error handling
  - Progress logging

commit 12: "feat: post-registration hook — auto-create org + workspace"
  - New users get org + workspace on signup
  - Called from Directus hook or Python endpoint after user creation

PROJECT SHARING:
commit 13: "feat: project sharing endpoints (private projects)"
  - project_user CRUD
  - Tier-gated: innovator+

ADMIN:
commit 14: "feat: admin usage endpoint + tier management"
  - Cross-org usage for manual invoicing
  - Set workspace tier manually
```

### Prompt for Claude Code

```
We're on branch `workspaces`, continuing from soft delete commits.

TASK: Implement the workspace and org API endpoints. One commit per endpoint group.

CRITICAL RULES:
1. Follow the EXACT Directus client pattern from this codebase
   (use the same wrapper/helper class for all Directus API calls)
2. Follow the EXACT auth pattern from this codebase
   (match how existing endpoints get the current user)
3. Every workspace-scoped endpoint MUST use get_workspace_context dependency
4. Every mutation MUST emit a usage_event
5. Every read MUST filter deleted_at IS NULL
6. Match the existing code style (naming conventions, file organization, etc.)

API RESPONSE SHAPES: See PRD for exact response JSON structures.

PERMISSION MODEL:
- Org owner/admin → admin access to all org workspaces (via inherited membership rows)
- Workspace owner/admin/member/viewer → see workspace role policies in PRD
- Private projects → only creator + workspace admin + project_user entries

MIGRATION SCRIPT:
- Must have --dry-run flag
- Must be idempotent (safe to re-run)
- Must handle per-user errors without stopping
- Must log progress
- Must create app_user with ALL fields from directus_users
- Test on local devcontainer before production

Start with commits 1-2 (middleware + permission helpers) as they're used by everything else.
```

**Attach:** `codebase-exploration-report.md` + `workspaces-prd-v4.md`

### Success criteria
- [ ] All endpoints return correct response shapes
- [ ] Permission checks work for all role combinations
- [ ] Invite flow works end-to-end (create → email → accept)
- [ ] Migration script works in dry-run mode
- [ ] Migration script works on local devcontainer
- [ ] Usage events emitted for all mutations
- [ ] Org inheritance creates/removes workspace memberships correctly

---

## Anti-Patterns to Watch For

### During Claude Code sessions

| Anti-pattern | What it looks like | What to do instead |
|---|---|---|
| **Boiling the ocean** | Agent tries to do everything in one commit | Stop it. One commit, one concern. |
| **Inventing patterns** | Agent creates a new utility/framework not in the codebase | Ask: "How does the existing code do this?" |
| **Ignoring existing code** | Agent writes a fresh Directus client wrapper | Use the existing one. |
| **Optimistic testing** | "I've implemented the endpoints" but didn't test | Ask: "Call the endpoint. Show me the response." |
| **Silent failures** | emit_usage_event throws but nobody notices | Check: is there error logging? |
| **Schema drift** | Agent creates fields via API but doesn't sync schema | Every schema change → directus-extension-sync |
| **God commits** | One commit with 20 files changed | Break it up. |

### During your review

| Red flag | What it means |
|---|---|
| Agent modified files outside the feature scope | Scope creep. Revert. |
| Agent introduced a new dependency (pip/npm package) | Question it. Is it necessary? |
| Agent used raw SQL instead of Directus API | Wrong pattern. Rewrite. |
| Commit message is vague ("update files") | Rewrite the commit message. |
| No deleted_at filter on a new read query | Bug. Fix before merging. |
| Usage event has no "v" field in event_data | Fix. This will save you later. |

---

## Pre-Flight Checklist (Before Session 1)

- [ ] Create `workspaces` branch from main
- [ ] Verify local devcontainer is running and healthy
- [ ] Verify Directus admin access works locally
- [ ] Verify Python API starts and serves requests locally
- [ ] Verify directus-extension-sync works (pull current schema)
- [ ] Take a snapshot/backup of the local DB (for safe migration testing)
- [ ] Have the PRD v3 final ready to attach to Claude Code
- [ ] Have this execution plan ready to reference

---

## Post-Session Verification (After Each Session)

### After Session 2 (Schema)
```bash
# Verify collections exist
curl http://localhost:8055/items/app_user     # Should return empty array
curl http://localhost:8055/items/org           # Should return empty array
curl http://localhost:8055/items/workspace     # Should return empty array
curl http://localhost:8055/items/usage_event   # Should return empty array

# Verify project has new fields
curl http://localhost:8055/items/project?limit=1&fields=id,workspace_id,visibility

# Verify deleted_at on existing collections
curl http://localhost:8055/items/conversation?limit=1&fields=id,deleted_at
```

### After Session 3 (Soft Delete)
```bash
# Create a test conversation, then delete it
# Verify: conversation has deleted_at set (not hard deleted)
# Verify: usage_event created with duration_seconds
# Verify: conversation doesn't appear in normal queries
```

### After Session 4 (API)
```bash
# Run migration in dry-run
python migration.py --dry-run

# Run migration for real (on local DB)
python migration.py

# Verify: every user has app_user + org + workspace
curl http://localhost:8000/api/v1/workspaces \
  -H "Cookie: <your-session-cookie>"
# Should return workspaces

# Create a new workspace
curl -X POST http://localhost:8000/api/v1/workspaces \
  -H "Cookie: <your-session-cookie>" \
  -H "Content-Type: application/json" \
  -d '{"name": "Test Client"}'
# Should return workspace with inherited memberships
```

---

## The Moment of Truth: Session 1 Prompt

When you're ready, open Claude Code with the repo loaded and paste this:

```
I'm implementing a Workspaces & Organizations feature for this platform.

FIRST: Read the attached PRD (workspaces-prd-v3-final.md) to understand what we're building.

THEN: Explore this codebase thoroughly and produce a report (save as
docs/codebase-exploration-report.md) that maps:

1. Every Directus collection with ALL fields (especially directus_users and project)
2. Every Python API route with auth pattern and Directus calls
3. Every delete operation (file, collection, method, what metadata is lost)
4. The exact auth flow and Directus client pattern
5. The schema sync setup (directus-extension-sync config)

FINALLY: Compare the codebase against the PRD and note:
- What fields does directus_users have that PRD's app_user is missing?
- What collection names or patterns in the PRD don't match reality?
- Any existing concepts that overlap with workspaces (sharing, teams, etc.)?
- What's the exact code pattern for calling Directus from Python?

Save the reconciliation notes at the end of the report.

DO NOT make any code changes. This is a read-only exploration session.
```

Attach: `workspaces-prd-v3-final.md`
