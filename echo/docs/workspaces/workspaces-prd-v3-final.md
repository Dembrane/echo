# Workspaces & Organizations — Final PRD
## Dembrane ECHO Platform

> **Status:** Ready for implementation
> **Date:** April 2026
> **Version:** 3 (final)

---

## Guiding Principles

> *"The Tao that can be told is not the eternal Tao."* — Lao Tzu
>
> The best infrastructure is invisible. A solo facilitator should never know they're "in a workspace." A partner managing 20 client engagements should feel the system anticipates their needs. **Wu Wei** — effortless action — is the design target.

> *"योगः कर्मसु कौशलम्"* (Yogah karmasu kaushalam) — "Yoga is skill in action." — Bhagavad Gita 2.50
>
> Every architectural decision should make the *next* decision easier, not harder. Skill is not in building more — it's in building the thing that makes everything else simpler.

> *"水善利万物而不争"* — "Water benefits all things and does not compete." — Tao Te Ching, Ch. 8
>
> The platform serves facilitators who serve communities. We are water — shaping ourselves to the container (workspace) while carrying what matters (conversations, insights, outcomes) downstream.

### Architectural Dharma — Each Layer Has Its Duty

| Layer | Dharma (duty) | Fails when... |
|-------|--------------|---------------|
| **Org** | Be the legal/billing boundary. Protect the business entity. | ...it leaks into the user's daily experience |
| **Workspace** | Be the collaboration boundary. Contain the work. | ...it becomes a prison (can't share, can't leave) |
| **Project** | Be where meaning is made. Hold conversations, insights, reports. | ...it's burdened with access control it doesn't need |
| **User** | Move freely between contexts. Carry identity, not permissions. | ...their access is confusing or surprising |

> *"In the Arthashastra, Kautilya teaches that the strength of an alliance is not in its rigidity but in its flexibility — the ability to change relationships without changing structure."*
>
> This is why `billed_to_workspace_id` is a pointer, not a hierarchy. Relationships change. Structure should not need to.

---

## TL;DR

Introduce **Orgs** and **Workspaces** above projects. On signup, every user gets an Org + Default Workspace. Solo users never see these concepts. Multi-user and B2B2B features are additive. All data access through Directus HTTP API. All new tables as Directus collections.

---

## The Real World

```
Partner 1 (consultancy)              Org 1
  ├── manages Client 1 projects      ├── Workspace A (Default) — own projects
  └── manages Client 2 projects      ├── Workspace B — Client 1's projects
                                     └── Workspace C — Client 2's projects
```

**Two paths to collaboration:**

| | Path A: Partner-led | Path B: Client-led |
|---|---|---|
| Who creates workspace | Partner | Client |
| Where it lives | Partner's org | Client's org |
| Who pays | Partner | Client |
| Partner users appear as | Direct members | External members |
| Handoff needed? | Yes (future) | No |

> *Sun Tzu: "The supreme art of war is to subdue the enemy without fighting."*
> We don't compete with partners — we make them more powerful. The B2B2B model wins by making the partner successful with their clients.

---

## Technical Stack (As-Is)

| Layer | Technology | Access Pattern |
|-------|-----------|----------------|
| Frontend | React + Vite SPA | Calls Python API + some direct Directus calls (migrating to Python) |
| API | Python FastAPI | Calls Directus HTTP API (admin token + user cookie forwarding) |
| Database | PostgreSQL (via Directus) | No direct SQL from Python. All through Directus REST API. |
| Schema | Directus admin UI + directus-extension-sync | Push/pull schema changes |
| Auth | Directus (cookie-based) | Frontend gets cookie, forwards to Python, Python validates with Directus |
| Email | SendGrid | Transactional emails configured |

**All new tables are Directus collections.** Created via Directus admin UI, synced via directus-extension-sync, accessed via Directus REST API from Python.

---

## Data Model

### New Collections

#### `app_user`

**Why:** Indirection layer between our domain tables and Directus auth. When we eventually migrate off Directus auth, we update this table once instead of every FK in every table.

> *Kautilya: "A wise king does not build his palace on borrowed land."*
> Our domain model should not be structurally dependent on a third-party auth system's internal IDs.

| Field | Type | Notes |
|-------|------|-------|
| `id` | uuid, PK | Our canonical user ID. All other tables FK to this. |
| `directus_user_id` | uuid, UNIQUE | Maps to `directus_users.id`. Current auth provider. |
| `email` | string | Denormalized for quick lookup without hitting Directus |
| `display_name` | string | |
| `created_at` | timestamp | |
| `updated_at` | timestamp | |

**On user creation (Directus hook or Python post-registration):** Create corresponding `app_user` row.
**On user lookup:** Resolve `directus_user_id` → `app_user.id` once, use `app_user.id` everywhere.

#### `org`

| Field | Type | Notes |
|-------|------|-------|
| `id` | uuid, PK | |
| `name` | string | Default: "{user.display_name}'s Organization" |
| `slug` | string, UNIQUE | Display-only (NOT used in URLs) |
| `logo_url` | string, nullable | Default branding for workspaces |
| `created_by` | uuid, FK → `app_user.id` | |
| `deleted_at` | timestamp, nullable | Soft delete |
| `created_at` | timestamp | |
| `updated_at` | timestamp | |

#### `org_membership`

| Field | Type | Notes |
|-------|------|-------|
| `id` | uuid, PK | |
| `org_id` | uuid, FK → `org.id` | |
| `user_id` | uuid, FK → `app_user.id` | |
| `role` | string | `owner` / `admin` / `member` |
| `deleted_at` | timestamp, nullable | Soft delete (preserves seat-days for billing) |
| `created_at` | timestamp | |

UNIQUE: `(org_id, user_id)` WHERE `deleted_at IS NULL`

#### `workspace`

| Field | Type | Notes |
|-------|------|-------|
| `id` | uuid, PK | **Used in URLs** as short ID |
| `org_id` | uuid, FK → `org.id` | Owning org |
| `name` | string | |
| `slug` | string | **Display-only.** Not in URLs. Unique per org (not globally). |
| `description` | string, nullable | |
| `logo_url` | string, nullable | Override org logo |
| `tier` | string, default `'pioneer'` | `pilot`/`pioneer`/`innovator`/`changemaker`/`guardian` |
| `billed_to_workspace_id` | uuid, nullable, FK → `workspace.id` | Partner billing stub. NULL = org pays. |
| `is_default` | boolean, default `false` | Auto-created workspace |
| `legal_basis` | string, nullable | `consent`/`client-managed`/`dembrane-events` |
| `privacy_policy_url` | string, nullable | |
| `settings` | json, default `{}` | Feature flags, limits |
| `deleted_at` | timestamp, nullable | Soft delete |
| `created_by` | uuid, FK → `app_user.id` | |
| `created_at` | timestamp | |
| `updated_at` | timestamp | |

**URL pattern:** `/:locale/w/:workspaceId/projects` — uses `workspace.id` (short UUID), NOT slug.

**Slug uniqueness:** UNIQUE per `(org_id, slug)` — two orgs can both have a "default" workspace.

#### `workspace_membership`

| Field | Type | Notes |
|-------|------|-------|
| `id` | uuid, PK | |
| `workspace_id` | uuid, FK → `workspace.id` | |
| `user_id` | uuid, FK → `app_user.id` | |
| `role` | string | `owner`/`admin`/`member`/`viewer` |
| `source` | string, default `'direct'` | `direct` = explicitly invited. `inherited` = auto-added from org role. |
| `is_external` | boolean, default `false` | User's primary org ≠ workspace's org |
| `deleted_at` | timestamp, nullable | Soft delete (preserves seat-days) |
| `created_at` | timestamp | |

UNIQUE: `(workspace_id, user_id)` WHERE `deleted_at IS NULL`

**Org inheritance behavior:**
- When workspace is created: org `owner` and `admin` members get auto-added as workspace_membership rows with `source='inherited'`, `role='admin'`
- When org member is promoted to admin/owner: auto-add inherited memberships to all org workspaces
- When org member is demoted from admin/owner: remove their `source='inherited'` memberships (but not `source='direct'`)
- Workspace admin can remove inherited members (just soft-delete the row)
- Removed inherited members are NOT re-added automatically

**Workspace role policies:**

| Role | Policies |
|------|----------|
| `viewer` | Read-only access to workspace-visible projects |
| `member` | `project:create`, `project:update` |
| `admin` | All member + `project:delete`, `project:share`, `member:invite`, `member:manage`, `settings:manage` |
| `owner` | `*` (everything including ownership transfer) |

#### `project_user`

For sharing private projects with specific users. **Tier-gated: innovator+.**

| Field | Type | Notes |
|-------|------|-------|
| `id` | uuid, PK | |
| `project_id` | uuid, FK → `project.id` | |
| `user_id` | uuid, FK → `app_user.id` | |
| `role` | string, default `'editor'` | `editor`/`viewer` |
| `granted_by` | uuid, FK → `app_user.id` | |
| `created_at` | timestamp | |

#### `workspace_invite`

| Field | Type | Notes |
|-------|------|-------|
| `id` | uuid, PK | |
| `workspace_id` | uuid, FK → `workspace.id` | |
| `email` | string | |
| `role` | string | Role to assign on acceptance |
| `invited_by` | uuid, FK → `app_user.id` | |
| `token` | string, UNIQUE | `secrets.token_urlsafe(32)` — 256 bits |
| `expires_at` | timestamp | 7 days from creation |
| `accepted_at` | timestamp, nullable | |
| `created_at` | timestamp | |

#### `usage_event`

Append-only. **Never updated. Never deleted.** Source of truth for billing.

| Field | Type | Notes |
|-------|------|-------|
| `id` | uuid, PK | |
| `trace_id` | string | Correlation ID (use request ID when available) |
| `org_id` | uuid, nullable | |
| `workspace_id` | uuid, nullable | |
| `project_id` | uuid, nullable | |
| `user_id` | uuid, nullable | |
| `event_type` | string | |
| `event_data` | json | **Always include `"v": 1`** for schema versioning |
| `created_at` | timestamp | |

> *I Ching, Hexagram 1: "The Creative works sublime success."*
> The usage event log is the memory of the system. It never forgets, never argues, never lies. All billing disputes are settled by reading the log.

**Event types:**

| Type | Data (v1) | Emitted when |
|------|-----------|-------------|
| `org.created` | `{ "v": 1, "name": str }` | Signup |
| `workspace.created` | `{ "v": 1, "tier": str, "is_default": bool }` | Workspace creation |
| `workspace.member_added` | `{ "v": 1, "member_user_id": str, "role": str, "source": str, "is_external": bool }` | Member joins |
| `workspace.member_removed` | `{ "v": 1, "member_user_id": str, "role": str, "seat_days": int }` | Member removed (include days active for billing) |
| `project.created` | `{ "v": 1, "visibility": str }` | Project creation |
| `project.deleted` | `{ "v": 1, "conversation_count": int, "total_audio_hours": float }` | Project soft-deleted (snapshot billing metadata) |
| `conversation.deleted` | `{ "v": 1, "duration_seconds": int, "audio_hours": float }` | Conversation soft-deleted (preserve duration!) |
| `audio.uploaded` | `{ "v": 1, "duration_seconds": int, "conversation_id": str }` | Audio upload |
| `audio.processed` | `{ "v": 1, "duration_seconds": int, "conversation_id": str, "billable": bool }` | Transcription complete. `billable: false` for failures. |
| `chat.query` | `{ "v": 1, "mode": str }` | Chat message |
| `report.generated` | `{ "v": 1, "report_id": str }` | Report created |
| `report.deleted` | `{ "v": 1 }` | Report soft-deleted |

### Modified Collections

#### `project` (existing)

Add fields:

| Field | Type | Notes |
|-------|------|-------|
| `workspace_id` | uuid, nullable, FK → `workspace.id` | NULL only during migration window |
| `visibility` | string, default `'workspace'` | `workspace` / `private` |
| `deleted_at` | timestamp, nullable | Soft delete |

#### `conversation` (existing)

Add field:

| Field | Type | Notes |
|-------|------|-------|
| `deleted_at` | timestamp, nullable | Soft delete. **Critical for billing** — preserves duration metadata. |

#### Other collections needing `deleted_at`

- `chat` (or whatever the chat/message collection is called)
- `report`

---

## Soft Delete Strategy

> *Ahimsa (अहिंसा) — non-harm. First, do no harm to user data. Second, do no harm to billing accuracy.*

### The Rule

**Every delete operation in the entire application must:**
1. Route through the Python API (no frontend→Directus direct deletes)
2. Set `deleted_at = now()` instead of hard deleting
3. Emit a `usage_event` with a metadata snapshot of billing-relevant fields
4. The actual data (audio files, etc.) can be purged, but metadata stays

### Implementation Pattern

```python
# In Python API — generic soft delete handler
async def soft_delete(
    collection: str,
    item_id: str,
    metadata_snapshot: dict,
    event_type: str,
    workspace_id: str | None = None,
    org_id: str | None = None,
    user_id: str | None = None,
):
    """Soft delete any item. Emit usage event with billing metadata."""
    
    # 1. Set deleted_at via Directus API
    await directus.patch(f"/items/{collection}/{item_id}", {
        "deleted_at": datetime.utcnow().isoformat()
    })
    
    # 2. Emit usage event with metadata snapshot
    await emit_usage_event(
        event_type=event_type,
        event_data={"v": 1, **metadata_snapshot},
        workspace_id=workspace_id,
        org_id=org_id,
        user_id=user_id,
    )

# Example: deleting a conversation
async def delete_conversation(conversation_id: str, user: AppUser):
    conv = await directus.get(f"/items/conversation/{conversation_id}")
    project = await directus.get(f"/items/project/{conv['project_id']}")
    
    await soft_delete(
        collection="conversation",
        item_id=conversation_id,
        metadata_snapshot={
            "duration_seconds": conv["duration_seconds"],
            "audio_hours": conv["duration_seconds"] / 3600 if conv["duration_seconds"] else 0,
            "project_id": conv["project_id"],
        },
        event_type="conversation.deleted",
        workspace_id=project["workspace_id"],
        user_id=user.id,
    )
    
    # 3. Optionally purge audio file (not needed for billing)
    if conv.get("audio_path"):
        await storage.delete(conv["audio_path"])
```

### GDPR Erasure (Separate Path)

When a user requests account deletion (GDPR Article 17):
- Anonymize usage_events: set `user_id = NULL`, strip PII from `event_data`
- Remove memberships (soft delete with metadata snapshot)
- Anonymize the `app_user` record (don't hard delete — preserves FK integrity)
- Hard delete PII: invite records with their email, etc.

### Subtask: Soft Delete Audit & Conversion

**This is a prerequisite implementation task.** Before workspace features go live:

1. **Audit:** Scan the entire codebase for all delete operations
   - Frontend → Directus direct DELETE calls
   - Frontend → Python API delete endpoints
   - Python API → Directus DELETE calls
   - Directus flows/hooks that delete items
2. **Add `deleted_at`** to: conversation, project, chat, report (workspace/org/membership tables are new and have it from day 1)
3. **Reroute** all frontend→Directus direct deletes through Python API endpoints
4. **Convert** each delete to soft delete + usage event emission
5. **Update all read queries** to filter `deleted_at IS NULL` (Directus filter: `{ "deleted_at": { "_null": true } }`)
6. **Test:** Verify deleted items don't appear in UI, usage events are emitted, billing metadata is preserved

---

## Permission Resolution

> *Confucius: "Let the ruler be a ruler, the minister a minister, the father a father, and the son a son."*
> Each role has clear responsibilities. Ambiguity in access control is a security vulnerability.

```python
async def get_user_project_access(app_user_id: str, project_id: str) -> Access | None:
    """Single resolution path. Check in order of specificity."""
    
    # Fetch project (with deleted_at filter)
    project = await directus.get(f"/items/project/{project_id}", {
        "filter": {"deleted_at": {"_null": True}}
    })
    if not project:
        return None
    
    # 1. Legacy ownership (backward compat — phase out over time)
    if project.get("directus_user_id"):
        app_user = await get_app_user(app_user_id)
        if app_user and app_user["directus_user_id"] == project["directus_user_id"]:
            return Access(role="owner", source="legacy")
    
    if not project.get("workspace_id"):
        return None
    
    # 2. Workspace membership (includes inherited org admins as explicit rows)
    membership = await directus.get("/items/workspace_membership", {
        "filter": {
            "workspace_id": {"_eq": project["workspace_id"]},
            "user_id": {"_eq": app_user_id},
            "deleted_at": {"_null": True},
        },
        "limit": 1
    })
    
    if membership and len(membership) > 0:
        ws_role = membership[0]["role"]
        
        if project["visibility"] == "workspace":
            return Access(role=ws_role, source="workspace")
        
        if project["visibility"] == "private":
            if ws_role in ("admin", "owner"):
                return Access(role=ws_role, source="workspace")
    
    # 3. Direct project share (private projects only)
    if project["visibility"] == "private":
        project_user = await directus.get("/items/project_user", {
            "filter": {
                "project_id": {"_eq": project_id},
                "user_id": {"_eq": app_user_id},
            },
            "limit": 1
        })
        if project_user and len(project_user) > 0:
            return Access(role=project_user[0]["role"], source="project_share")
    
    return None
```

### Tenant Isolation Middleware

**Every workspace-scoped endpoint** must use this dependency:

```python
async def get_workspace_context(
    workspace_id: str,  # From URL path parameter
    current_user: AppUser = Depends(get_current_user),
) -> WorkspaceContext:
    """Validates user has access to this workspace. Returns scoped context."""
    
    membership = await directus.get("/items/workspace_membership", {
        "filter": {
            "workspace_id": {"_eq": workspace_id},
            "user_id": {"_eq": current_user.id},
            "deleted_at": {"_null": True},
        },
        "limit": 1
    })
    
    if not membership or len(membership) == 0:
        raise HTTPException(status_code=403, detail="No access to this workspace")
    
    return WorkspaceContext(
        workspace_id=workspace_id,
        user=current_user,
        role=membership[0]["role"],
        source=membership[0]["source"],
    )

# Usage — structurally impossible to forget the access check
@router.get("/api/v1/workspaces/{workspace_id}/projects")
async def list_projects(ctx: WorkspaceContext = Depends(get_workspace_context)):
    return await directus.get("/items/project", {
        "filter": {
            "workspace_id": {"_eq": ctx.workspace_id},
            "deleted_at": {"_null": True},
        }
    })
```

---

## URL Structure

> *"Use short IDs in URLs, slugs are display-only."*

```
/:locale/login
/:locale/register
/:locale/select-workspace
/:locale/w/:workspaceId/projects                        # Dashboard
/:locale/w/:workspaceId/projects/new                    # Create project
/:locale/w/:workspaceId/projects/:projectId             # Project view
/:locale/w/:workspaceId/projects/:projectId/chats/:id   # Chat
/:locale/w/:workspaceId/projects/:projectId/reports/:id # Report
/:locale/w/:workspaceId/settings                        # Workspace settings
/:locale/org/:orgId/settings                            # Org settings (also by ID)
/:locale/settings                                       # User settings
```

`workspaceId` and `orgId` are UUIDs (or shortened UUIDs if you prefer — e.g., first 8 chars). Slugs appear in the UI (page titles, breadcrumbs, workspace cards) but never in URLs.

---

## Frontend Architecture

### Progressive Solo Experience

> *Wu Wei: the best infrastructure is invisible.*

```
IF user has exactly 1 workspace AND is not org admin/owner:
  → Auto-redirect to workspace dashboard
  → Topbar shows ONLY logo + user avatar (no workspace name, no "change workspace")
  → Settings gear goes to workspace settings (no "org" language)
  → Subtle prompt: "Invite your team →" in sidebar footer
  → The word "workspace" never appears

IF user has 2+ workspaces OR is org admin/owner:
  → Full workspace experience (selector, topbar with workspace name, etc.)
```

### Workspace Selector (Full Page)

Route: `/:locale/select-workspace`

Three variants based on context — see `ui-flows-mockdown.md` for complete specs:
- **Card View**: 2-3 workspaces, not org admin
- **List View**: >3 workspaces, searchable with Internal/External tabs
- **Partner View**: Org admin/owner, shows org context + management links

### Post-Login Router

```typescript
// After successful authentication
const workspaces = await api.getAccessibleWorkspaces();
const lastWorkspace = localStorage.getItem('lastWorkspaceId');
const isOrgAdmin = workspaces.some(w => !w.is_external && ['owner', 'admin'].includes(w.org_role));

// Check for deep link (saved before login redirect)
const deepLink = sessionStorage.getItem('redirectAfterLogin');
if (deepLink) {
  sessionStorage.removeItem('redirectAfterLogin');
  navigate(deepLink);
  return;
}

if (workspaces.length === 0) {
  navigate('/error/no-workspace');  // Should never happen
} else if (workspaces.length === 1 && !isOrgAdmin) {
  navigate(`/w/${workspaces[0].id}/projects`);
} else {
  navigate('/select-workspace');
}
```

### Stale State Handling

- On 403 from any workspace API call → invalidate workspace cache, redirect to selector, show toast
- Workspace list on selector page → poll every 30 seconds
- WorkspaceContext provider → staleTime 60s, refetch on window focus

---

## API Endpoints

All under `/api/v1/`. Auth via Directus cookie forwarding.

### Org
```
GET    /orgs                              # User's orgs
GET    /orgs/:id                          # Org detail
PATCH  /orgs/:id                          # Update (name, logo)
GET    /orgs/:id/members                  # Org members
POST   /orgs/:id/members                  # Add member
PATCH  /orgs/:id/members/:uid             # Change role
DELETE /orgs/:id/members/:uid             # Remove (soft delete)
GET    /orgs/:id/billing                  # Usage rollup across workspaces
```

### Workspace
```
GET    /workspaces                        # All accessible (for selector)
POST   /workspaces                        # Create (in user's org)
GET    /workspaces/:id                    # Detail
PATCH  /workspaces/:id                    # Update
DELETE /workspaces/:id                    # Soft delete (must be empty)
GET    /workspaces/:id/members            # Members + inherited + pending invites
POST   /workspaces/:id/members            # Invite (by email)
PATCH  /workspaces/:id/members/:uid       # Change role
DELETE /workspaces/:id/members/:uid       # Remove (soft delete)
GET    /workspaces/:id/projects           # Workspace projects
POST   /workspaces/:id/projects           # Create project
GET    /workspaces/:id/usage              # Usage summary
```

### Project
```
GET    /projects/:id/users                # Project share list
POST   /projects/:id/users               # Share (private projects, innovator+)
DELETE /projects/:id/users/:uid           # Revoke share
DELETE /projects/:id                      # Soft delete project
```

### Conversations, Chats, Reports (existing, modified)
```
DELETE /conversations/:id                 # Soft delete (via Python, not Directus direct)
DELETE /chats/:id                         # Soft delete
DELETE /reports/:id                       # Soft delete
```

### Admin (Dembrane internal)
```
GET    /admin/usage                       # Cross-org usage for manual invoicing
PATCH  /admin/workspaces/:id/tier         # Set workspace tier manually
```

---

## Migration Strategy

### Existing User Migration

> *I Ching, Hexagram 18 — "Work on What Has Been Spoiled": Correct the situation carefully. Acting too hastily brings misfortune.*

**Pre-migration:**
1. Full database backup
2. Run migration on a DB clone first
3. Dry-run mode: log what would be created without writing

**Migration script (runs via Python API against Directus HTTP API):**

```python
async def migrate_existing_users(dry_run: bool = True):
    """Idempotent. Safe to re-run. Per-user error handling."""
    
    users = await directus.get("/users", {"limit": -1, "fields": ["id", "first_name", "last_name", "email"]})
    
    for i, user in enumerate(users):
        try:
            # Idempotency: skip if app_user already exists
            existing = await directus.get("/items/app_user", {
                "filter": {"directus_user_id": {"_eq": user["id"]}},
                "limit": 1
            })
            if existing and len(existing) > 0:
                logger.info(f"[{i+1}/{len(users)}] SKIP {user['email']} — already migrated")
                continue
            
            if dry_run:
                logger.info(f"[{i+1}/{len(users)}] WOULD migrate {user['email']}")
                continue
            
            # Create app_user
            app_user_id = str(uuid4())
            await directus.post("/items/app_user", {
                "id": app_user_id,
                "directus_user_id": user["id"],
                "email": user.get("email", ""),
                "display_name": f"{user.get('first_name', '')} {user.get('last_name', '')}".strip(),
            })
            
            # Create org
            org_name = f"{user.get('first_name', 'My')}'s Organization"
            org_id = str(uuid4())
            org_slug = slugify(org_name)
            await directus.post("/items/org", {
                "id": org_id, "name": org_name, "slug": org_slug, "created_by": app_user_id,
            })
            await directus.post("/items/org_membership", {
                "id": str(uuid4()), "org_id": org_id, "user_id": app_user_id, "role": "owner",
            })
            
            # Create default workspace
            ws_id = str(uuid4())
            await directus.post("/items/workspace", {
                "id": ws_id, "org_id": org_id, "name": "Default",
                "slug": "default", "is_default": True, "tier": "pioneer",
                "created_by": app_user_id,
            })
            await directus.post("/items/workspace_membership", {
                "id": str(uuid4()), "workspace_id": ws_id, "user_id": app_user_id,
                "role": "owner", "source": "inherited",
            })
            
            # Move user's projects into default workspace
            projects = await directus.get("/items/project", {
                "filter": {"directus_user_id": {"_eq": user["id"]}},
                "fields": ["id"],
                "limit": -1,
            })
            for proj in projects:
                await directus.patch(f"/items/project/{proj['id']}", {
                    "workspace_id": ws_id,
                })
            
            # Emit usage events
            await emit_usage_event("org.created", {"v": 1, "name": org_name},
                                  org_id=org_id, user_id=app_user_id)
            await emit_usage_event("workspace.created",
                                  {"v": 1, "tier": "pioneer", "is_default": True},
                                  org_id=org_id, workspace_id=ws_id, user_id=app_user_id)
            
            logger.info(f"[{i+1}/{len(users)}] OK {user['email']} — org:{org_id} ws:{ws_id} projects:{len(projects)}")
        
        except Exception as e:
            logger.error(f"[{i+1}/{len(users)}] FAIL {user['email']} — {e}")
            # Continue to next user — don't fail the whole migration
            continue
```

### New User Signup (Post-Deploy)

1. User registers via Directus
2. Python post-registration endpoint (called by Directus hook or frontend):
   - Create `app_user`
   - Create org + org_membership(owner)
   - Create default workspace + workspace_membership(owner, source='inherited')
   - Emit usage events
3. Post-login router auto-redirects to workspace dashboard

---

## Implementation Sequence

> *Kautilya: "The work which has been begun should be completed."*
> Each phase ships a working increment. No phase depends on a later phase.

### Phase 0: Soft Delete Conversion (Prerequisite)

**This must happen BEFORE workspace features.** It's a standalone task.

1. Add `deleted_at` field to: `conversation`, `project`, `chat`, `report`
2. Audit all delete operations in the codebase (frontend + Python)
3. Create Python API delete endpoints for each collection
4. Reroute all frontend delete calls through Python API
5. Convert each to soft delete + usage event emission
6. Update all Directus read queries to filter `{ "deleted_at": { "_null": true } }`
7. Test: deleted items invisible, usage events emitted, metadata preserved

**Deliverable:** Every delete in the system goes through Python, is soft, and emits billing metadata.

### Phase 1: Schema + Data Model

1. Create Directus collections: `app_user`, `org`, `org_membership`, `workspace`, `workspace_membership`, `project_user`, `workspace_invite`, `usage_event`
2. Add fields to existing collections: `project.workspace_id`, `project.visibility`, plus `deleted_at` on workspace/org/membership tables
3. Sync schema via directus-extension-sync
4. Write `emit_usage_event` utility function
5. Write migration script (dry-run tested)

**Deliverable:** All tables exist. Migration script ready to run.

### Phase 2: Migration + Core API

1. Run migration on production (after clone testing)
2. Implement tenant isolation middleware (`get_workspace_context`)
3. Implement permission resolution (`get_user_project_access`)
4. Workspace CRUD endpoints
5. Org CRUD endpoints
6. Membership management endpoints
7. Invite flow (create invite → send email via SendGrid → accept on registration)
8. Instrument existing code paths to emit usage events

**Deliverable:** Full API working. Testable via Postman/curl.

### Phase 3: Frontend — Routing + Selector

1. Add workspace-scoped routing (`/:locale/w/:workspaceId/*`)
2. Post-login router logic (with deep link preservation)
3. Workspace selector page (card/list/partner variants)
4. Topbar changes (workspace name, change workspace button)
5. Progressive solo experience (hide workspace language for single-workspace users)
6. Legacy URL handling (redirect old URLs to workspace-scoped)
7. WorkspaceContext provider with stale state handling

**Deliverable:** Users can log in, see workspace selector, navigate to workspace.

### Phase 4: Frontend — Settings + Management

1. Workspace settings page (General, Members, Branding, Legal, Billing tabs)
2. Org settings page (General, Members, Billing tabs)
3. Member invite modal
4. Usage dashboard (per-workspace + org-level billing rollup)
5. New workspace creation flow (3-step wizard)
6. User settings updates (workspace list, org list)

**Deliverable:** Full workspace and org management in UI.

### Phase 5: Frontend — Project Changes

1. Project visibility (workspace/private) — private gated to innovator+
2. Private project sharing UI (project_user management)
3. Create project within workspace context (auto-set workspace_id)
4. Empty states and tier-gating upgrade prompts
5. Post-migration onboarding modal for existing users

**Deliverable:** Complete feature. Ready for production.

---

## Tier Feature Matrix (UI Enforcement)

| Feature | Pioneer | Innovator | Changemaker | Guardian |
|---------|:-------:|:---------:|:-----------:|:--------:|
| Projects + conversations | ✓ | ✓ | ✓ | ✓ |
| Chats + reports | ✓ | ✓ | ✓ | ✓ |
| Data export | — | ✓ | ✓ | ✓ |
| Private project sharing | — | ✓ | ✓ | ✓ |
| Whitelabel branding | — | — | ✓ | ✓ |
| API/integration access | — | — | ✓ | ✓ |

**Enforcement:** Python API checks `workspace.tier` before allowing tier-gated operations. Frontend hides/disables UI elements with upgrade prompts.

---

## Edge Cases

| Scenario | Handling |
|---|---|
| Solo user, 1 workspace | Progressive: no workspace language shown. "Invite your team →" prompt. |
| Delete workspace with projects | Blocked. "Delete or move all projects first." |
| Last owner leaves workspace | Blocked. "Transfer ownership first." |
| Invite to unregistered email | Create workspace_invite, send email. On signup, auto-add. Expire 7 days. |
| User removed from workspace | Soft delete membership. Loses access to all workspace projects. project_user entries also soft-deleted. |
| Inherited member removed | Soft delete the `source='inherited'` row. NOT re-added automatically. |
| External user | `is_external=true` on membership. Tagged "External" in UI. Counts as seat. |
| 403 on workspace API call | Frontend: invalidate cache, redirect to selector, toast "Access changed." |
| Audio transcription fails | Usage event: `{ "billable": false }`. Doesn't count toward hours. |
| User requests GDPR deletion | Anonymize usage events + app_user. Hard delete PII. Preserve billing metadata. |
| Deep link through login | sessionStorage preserves URL, restore after auth. |

---

## What's NOT In This Phase

- Automated billing / Stripe
- Better Auth migration
- Workspace handoff (transfer between orgs)
- Kickback/commission tracking
- Google OAuth
- Project transfer between workspaces
- API key management
- Real-time / WebSocket updates
- Network effects features

---

## Companion Documents

| Document | Contains |
|----------|---------|
| `ui-flows-mockdown.md` | Complete screen-by-screen specs (Flows 1-24) |
| `b2b2b-strategy.md` | Partner model, Path A/B, billing, onboarding |
| `architecture-review.md` | Detailed security/performance/compliance recommendations |
| `failure-analysis.md` | 8-perspective red team analysis |

---

## Final Wisdom

> *Thiruvalluvar (திருவள்ளுவர்), Kural 391:*
> *"செய்க பொருளைச் செறுநர் செருக்கறுக்கும்"*
> *"Acquire wealth — it cuts the arrogance of foes."*
>
> Build the billing infrastructure now, even though billing is manual. The usage event log is your wealth. It cuts disputes, proves value, and funds everything else.

> *Sun Tzu: "Every battle is won before it is ever fought."*
>
> The migration script, the soft delete conversion, the tenant isolation middleware — these are boring battles fought before the exciting feature work begins. Win them thoroughly.

> *Lao Tzu: "A journey of a thousand miles begins with a single step."*
>
> Phase 0 (soft delete conversion) is the single step. It's not glamorous. It doesn't ship a visible feature. But without it, every phase that follows is built on sand.
