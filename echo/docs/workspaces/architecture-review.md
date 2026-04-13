# Architecture Review: Workspaces PRD
## What makes a senior eng at Google/Apple have a heart attack

---

## 1. CRITICAL: Mutable slugs in URLs

**The problem:** Workspace slugs are used in URLs (`/:locale/:workspaceSlug/projects/...`) AND are editable in settings. This is a classic footgun.

User bookmarks `app.dembrane.com/en/dietz-consulting/projects/abc`. Admin renames workspace slug to `dietz-nl`. Every bookmark, shared link, browser history entry, saved integration URL, and CI/CD webhook breaks instantly. The PRD says "no redirect" — that's a data loss event for users.

**The fix:** Pick one:

- **Option A (recommended):** Slugs are immutable after creation. Want a different URL? Too bad. This is what GitHub does with repo URLs (renames auto-redirect forever).
- **Option B:** Slugs are editable BUT old slugs redirect to new slug for 90 days. Requires a `workspace_slug_history` table. This is what Slack does with workspace URLs.
- **Option C:** Don't use slugs in URLs at all. Use short IDs (`/w/abc123/projects/...`). Slugs are display-only. This is what Notion does.

**Recommendation:** Option A. Simplest. If someone really wants a different slug, they can create a new workspace and move projects.

---

## 2. CRITICAL: No tenant isolation strategy

**The problem:** All orgs and workspaces live in the same tables with no row-level security. A single missing `WHERE workspace_id = :ws_id` in any query leaks data across tenants. This is a compliance-ending bug for EU public sector clients under ISO 27001.

**The fix:**

```python
# WRONG — every endpoint does its own filtering
@router.get("/api/v1/workspaces/{ws_id}/projects")
async def list_projects(ws_id: str, user: User):
    projects = await db.fetch_all(
        "SELECT * FROM project WHERE workspace_id = :ws_id", {"ws_id": ws_id}
    )
    # Oops, forgot to check if user can access this workspace

# RIGHT — middleware sets tenant context, all queries are scoped
class WorkspaceContext:
    """Dependency injection that validates access AND sets query scope."""
    
    async def __call__(self, ws_id: str, user: User = Depends(get_current_user)):
        access = await get_workspace_access(ws_id, user.id)
        if not access:
            raise HTTPException(403)
        return WorkspaceScopedSession(ws_id=ws_id, user=user, role=access.role)

workspace_ctx = WorkspaceContext()

@router.get("/api/v1/workspaces/{ws_id}/projects")
async def list_projects(ctx: WorkspaceScopedSession = Depends(workspace_ctx)):
    # ctx.query() automatically adds WHERE workspace_id = ctx.ws_id
    projects = await ctx.query(project).fetch_all()
```

Also consider PostgreSQL Row-Level Security (RLS) as a defense-in-depth layer:

```sql
ALTER TABLE project ENABLE ROW LEVEL SECURITY;

CREATE POLICY project_workspace_isolation ON project
    USING (workspace_id = current_setting('app.current_workspace_id')::uuid);
```

Set `app.current_workspace_id` at the start of each request. Even if application code has a bug, the DB won't return wrong-tenant rows.

---

## 3. CRITICAL: Permission check is a multi-query waterfall on every request

**The problem:** The `get_user_project_access` function does up to 4 sequential DB queries on every single API call:

1. Check legacy ownership → query `project`
2. Check org membership → query `org_membership`
3. Check workspace membership → query `workspace_membership`
4. Check project_user → query `project_user`

At 2-5ms per query, that's 8-20ms of permission overhead before you even start the actual work. Under load, this cascades.

**The fix:** Single query with JOINs + cache.

```sql
-- Single query: "what access does user X have to project Y?"
SELECT
    p.id AS project_id,
    p.workspace_id,
    p.visibility,
    p.directus_user_id,
    w.org_id,
    om.role AS org_role,
    wm.role AS workspace_role,
    pu.role AS project_user_role
FROM project p
LEFT JOIN workspace w ON w.id = p.workspace_id
LEFT JOIN org_membership om ON om.org_id = w.org_id AND om.user_id = :user_id
LEFT JOIN workspace_membership wm ON wm.workspace_id = p.workspace_id AND wm.user_id = :user_id
LEFT JOIN project_user pu ON pu.project_id = p.id AND pu.user_id = :user_id
WHERE p.id = :project_id;
```

One query, one round trip. Resolve access in application code from the joined result.

For the workspace list (selector page), similar approach:

```sql
-- All workspaces accessible to user X, with counts
SELECT
    w.*,
    COALESCE(om.role, NULL) AS org_role,
    COALESCE(wm.role, NULL) AS ws_role,
    (SELECT COUNT(*) FROM project WHERE workspace_id = w.id) AS project_count,
    (SELECT COUNT(*) FROM workspace_membership WHERE workspace_id = w.id) AS member_count
FROM workspace w
LEFT JOIN org_membership om ON om.org_id = w.org_id AND om.user_id = :user_id
LEFT JOIN workspace_membership wm ON wm.workspace_id = w.id AND wm.user_id = :user_id
WHERE om.role IN ('owner', 'admin') OR wm.id IS NOT NULL
ORDER BY w.updated_at DESC;
```

**Optional cache layer:** For the workspace selector (called on every page load), cache the result per user for 30-60 seconds. Invalidate on membership changes. Even a simple in-memory dict with TTL is fine at your scale. No Redis needed.

---

## 4. HIGH: Cascading deletes with no soft delete

**The problem:** `ON DELETE CASCADE` from org → workspace → project means:
- Deleting an org nukes every workspace, every project, every conversation, every transcript
- No recovery. No audit trail. No "oops" button.
- An angry org admin (or a compromised account) can destroy a partner's entire client portfolio in one click.

ISO 27001 auditors will flag this.

**The fix:**

```sql
-- Soft delete on all tenant-scoped tables
ALTER TABLE org ADD COLUMN deleted_at timestamptz;
ALTER TABLE workspace ADD COLUMN deleted_at timestamptz;
ALTER TABLE project ADD COLUMN ... ; -- if not already present

-- All queries filter: WHERE deleted_at IS NULL
-- Cascade becomes: set deleted_at on children
-- Actual purge: scheduled job after 30 days, with email notification
```

Application-level delete flow:
1. User clicks delete → sets `deleted_at = now()`
2. Data disappears from all queries immediately
3. Emit `workspace.deleted` usage event
4. 30-day grace period — support can restore by setting `deleted_at = NULL`
5. Scheduled job hard-deletes after 30 days
6. Email notification to org owner when workspace is soft-deleted

Remove all `ON DELETE CASCADE`. Replace with application-level soft delete propagation.

---

## 5. HIGH: No idempotency on mutations

**The problem:** User clicks "Create workspace" → network timeout → user clicks again → two workspaces created. Same with invites, project creation, etc. Mobile users with flaky connections will hit this constantly.

**The fix:** Idempotency key pattern.

```python
@router.post("/api/v1/workspaces")
async def create_workspace(
    body: CreateWorkspaceRequest,
    idempotency_key: str = Header(alias="Idempotency-Key"),
    user: User = Depends(get_current_user),
):
    # Check if we've seen this key before
    existing = await db.fetch_one(
        "SELECT response_body FROM idempotency_cache WHERE key = :key AND user_id = :uid",
        {"key": idempotency_key, "uid": user.id}
    )
    if existing:
        return JSONResponse(content=json.loads(existing.response_body), status_code=201)
    
    # Create workspace...
    result = await _create_workspace(body, user)
    
    # Cache the response (TTL: 24h)
    await db.execute(
        idempotency_cache.insert().values(
            key=idempotency_key, user_id=user.id,
            response_body=json.dumps(result), expires_at=now() + timedelta(hours=24)
        )
    )
    return result
```

Frontend generates `Idempotency-Key: {uuid}` on form submission, reuses same key on retry.

At minimum, do this for: workspace creation, invite sending, project creation. These are the most visible duplicate-creation bugs.

---

## 6. HIGH: No pagination on any list endpoint

**The problem:** `GET /workspaces/:ws_id/projects` returns all projects as a flat array. A workspace with 200 projects sends 200 rows on every page load. Usage events will be thousands of rows per month.

**The fix:** Cursor-based pagination on all list endpoints.

```python
@router.get("/api/v1/workspaces/{ws_id}/projects")
async def list_projects(
    ctx: WorkspaceScopedSession = Depends(workspace_ctx),
    cursor: str | None = Query(None),  # Opaque cursor (base64 encoded created_at + id)
    limit: int = Query(25, ge=1, le=100),
):
    # Decode cursor, query with WHERE (created_at, id) < (cursor_ts, cursor_id)
    # Return: { "items": [...], "next_cursor": "...", "has_more": bool }
```

Offset-based pagination is fine too at your scale, but cursor-based is better for real-time lists where items get added/removed.

At minimum: projects, members, usage events, conversations.

---

## 7. HIGH: usage_event table will eat your database

**The problem:** Append-only, never deleted. `chat.query` alone could be 100+ events per workspace per day. At 50 workspaces × 100 events × 365 days = 1.8M rows/year. With jsonb `event_data`, that's non-trivial storage and index bloat.

**The fix:** Plan for it now, implement when needed.

```sql
-- Partition by month from day 1 (cheap to add, expensive to add later)
CREATE TABLE usage_event (
    id uuid NOT NULL,
    trace_id varchar(100) NOT NULL,
    org_id uuid,
    workspace_id uuid,
    -- ...
    created_at timestamptz NOT NULL DEFAULT now()
) PARTITION BY RANGE (created_at);

-- Create partitions (automate with pg_partman or a monthly cron)
CREATE TABLE usage_event_2026_04 PARTITION OF usage_event
    FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE usage_event_2026_05 PARTITION OF usage_event
    FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
```

Benefits: queries scoped to a billing period only scan one partition. Old partitions can be archived to cold storage. Indexes stay small per partition.

**Do this in the initial migration.** Adding partitioning to an existing table requires a full rewrite.

---

## 8. MEDIUM: FK coupling to directus_users

**The problem:** Every new table has `FK → directus_users.id`. When you eventually migrate to Better Auth (or any other auth system), you'll need to:
1. Create new user table
2. Map old Directus IDs to new IDs
3. Update EVERY foreign key in EVERY table

This is a multi-day, high-risk migration.

**The fix:** Indirection layer.

```sql
-- Create a thin user reference table that YOU control
CREATE TABLE app_user (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    directus_user_id uuid UNIQUE,      -- current auth provider
    -- future: better_auth_user_id uuid UNIQUE,
    email varchar(255) NOT NULL,
    display_name varchar(255),
    created_at timestamptz NOT NULL DEFAULT now()
);

-- All new tables FK to app_user.id, NOT directus_users.id
ALTER TABLE org_membership ADD COLUMN user_id uuid REFERENCES app_user(id);
ALTER TABLE workspace_membership ADD COLUMN user_id uuid REFERENCES app_user(id);
```

When you migrate auth, you update the `app_user` table once (add `better_auth_user_id`, drop `directus_user_id`). Zero changes to org/workspace/project tables.

**Trade-off:** One more JOIN on user lookups. Worth it for migration safety.

---

## 9. MEDIUM: No RBAC middleware — permission checks will be forgotten

**The problem:** Every endpoint does its own permission check. New endpoints will inevitably forget. One intern adding a quick admin endpoint without the permission check = data breach.

**The fix:** Declarative policy enforcement via decorators/dependencies.

```python
# Define policies as a dependency
def require_policy(*policies: str):
    """FastAPI dependency that checks workspace-level policies."""
    async def check(ctx: WorkspaceScopedSession = Depends(workspace_ctx)):
        for policy in policies:
            if not ctx.has_policy(policy):
                raise HTTPException(403, f"Missing policy: {policy}")
        return ctx
    return Depends(check)

# Usage — impossible to forget
@router.post("/api/v1/workspaces/{ws_id}/members")
async def invite_member(
    body: InviteMemberRequest,
    ctx = require_policy("member:invite"),  # Enforced by the framework
):
    ...

@router.delete("/api/v1/workspaces/{ws_id}")
async def delete_workspace(
    ctx = require_policy("*"),  # Only owner
):
    ...
```

Also: write a test that introspects all registered routes and verifies every workspace-scoped endpoint has a policy dependency. Fail CI if any endpoint is missing one.

---

## 10. MEDIUM: No rate limiting on invite and creation endpoints

**The problem:** Invite spam. A compromised or malicious account can send thousands of invite emails. Workspace creation spam fills the org with garbage.

**The fix:**

```python
from fastapi_limiter import RateLimiter

@router.post("/api/v1/workspaces/{ws_id}/members",
    dependencies=[Depends(RateLimiter(times=20, minutes=60))]  # 20 invites/hour
)
async def invite_member(...):
    ...

@router.post("/api/v1/workspaces",
    dependencies=[Depends(RateLimiter(times=5, minutes=60))]  # 5 workspaces/hour
)
async def create_workspace(...):
    ...
```

For MVP, even a simple in-memory counter per user is fine. Don't ship invite endpoints without this.

---

## 11. MEDIUM: No event versioning on usage_event

**The problem:** `event_data` is schemaless jsonb. When you change the shape (add a field, rename a field, remove a field), old events have the old shape and new events have the new shape. Billing aggregation queries that span months will break silently.

**The fix:** Version every event schema.

```json
{
  "v": 1,
  "duration_seconds": 3600,
  "conversation_id": "abc"
}
```

Aggregation code checks `v` and handles each version:

```python
def get_audio_hours(event_data: dict) -> float:
    v = event_data.get("v", 1)
    if v == 1:
        return event_data["duration_seconds"] / 3600
    elif v == 2:
        return event_data["duration_ms"] / 3_600_000  # hypothetical future change
```

Cheap to add, painful to add later.

---

## 12. MEDIUM: Global slug uniqueness is too restrictive

**The problem:** Workspace slugs are globally unique. Two different orgs can't both have a workspace called "default". At scale, good slugs get consumed. Users get `default-47`.

**The fix:** Slugs should be unique per org, not globally. The URL already has locale context — add org context too:

```
/:locale/:orgSlug/:workspaceSlug/projects
```

Or, if you don't want org in the URL (cleaner), make the uniqueness constraint:

```sql
-- Instead of: UNIQUE (slug)
-- Use: UNIQUE (org_id, slug)
```

And use the workspace `id` (or a short hash) in the URL for routing, with slug as display-only. This is the Notion/Linear pattern.

**If you keep global uniqueness:** At least namespace default workspaces: `{org_slug}-default` instead of just `default`.

---

## 13. LOW: No request tracing / correlation

**The problem:** User reports "I clicked invite and nothing happened." How do you debug? You have usage_events but no way to correlate a specific HTTP request to the events it generated, the queries it ran, and the response it returned.

**The fix:** Generate a request ID on every API call, propagate through all logging and events.

```python
@app.middleware("http")
async def add_request_id(request: Request, call_next):
    request_id = request.headers.get("X-Request-ID", str(uuid4()))
    # Set on context for all downstream logging
    contextvars.request_id.set(request_id)
    response = await call_next(request)
    response.headers["X-Request-ID"] = request_id
    return response
```

Use this `request_id` as the `trace_id` in usage_events. Now you can trace: request → permission check → DB queries → usage events → response, all with one ID.

---

## Summary: Priority Order

| # | Issue | Severity | Effort | Do Now? |
|---|-------|----------|--------|---------|
| 1 | Mutable slugs in URLs | Critical | Low | **Yes** — decide before shipping |
| 2 | No tenant isolation | Critical | Medium | **Yes** — build the middleware pattern from day 1 |
| 3 | Permission query waterfall | High | Medium | **Yes** — write the single JOIN query |
| 4 | No soft delete | High | Low | **Yes** — add `deleted_at` columns in initial migration |
| 5 | No idempotency | High | Medium | Yes for create endpoints |
| 6 | No pagination | High | Low | Yes on all list endpoints |
| 7 | usage_event partitioning | High | Low | **Yes** — partition from day 1 (can't add later easily) |
| 8 | FK coupling to directus_users | Medium | Medium | Recommended — `app_user` indirection table |
| 9 | No RBAC middleware | Medium | Medium | Yes — saves you from future security bugs |
| 10 | No rate limiting on invites | Medium | Low | Yes — trivial to add |
| 11 | No event versioning | Medium | Trivial | Yes — just add `"v": 1` |
| 12 | Global slug uniqueness | Medium | Low | Decide before shipping |
| 13 | No request tracing | Low | Low | Nice to have |
