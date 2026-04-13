# Workspaces PRD — Multi-Perspective Failure Analysis
## "Red Team" Review from 8 Specialist Perspectives

---

## Agent 1: Security Engineer

### How this fails

**Privilege escalation via org inheritance.** The "org owner/admin gets admin on all workspaces" rule is computed at query time. If someone compromises an org owner account, they instantly have admin access to every client workspace. That's not one customer breached — it's ALL their clients breached simultaneously. For a consultancy with 20 client workspaces, one phished password = 20 data breaches.

**Mitigation:** Add an explicit "require re-authentication for workspace switching" option that high-security clients can enable. At minimum, log workspace switches as security events with IP/device fingerprint. Consider making org-inherited access opt-out per workspace (client workspace admin can say "I don't want org admins auto-inheriting into my workspace").

**Invite token brute force.** Workspace invite tokens are the keys to the kingdom. If they're UUIDs (36 chars, 122 bits of entropy), they're fine. If they're short tokens for "nice URLs," they're brute-forceable.

**Mitigation:** Use `secrets.token_urlsafe(32)` (256 bits). Rate-limit invite acceptance endpoint. Expire aggressively (7 days, single-use).

**Cross-tenant data leakage via usage_event.** The usage_event table contains org_id, workspace_id, project_id, user_id. If the admin usage endpoint (`/api/v1/admin/usage`) has an authz bug, it exposes the entire activity graph of all customers. An attacker learns: which orgs exist, how many projects they have, when they're active, who's in which workspace.

**Mitigation:** The admin endpoints should require a separate authentication mechanism (not just "is Directus admin"). Consider a separate admin API key or require 2FA verification for admin endpoints.

**Exported usage data as intelligence.** Even legitimate access to usage data reveals competitive intelligence. If a partner can see their client's exact chat query counts, they can infer how dependent the client is on Dembrane (leverage in handoff negotiations).

**Mitigation:** Decide what usage data partners should vs. shouldn't see about client workspaces they manage. The current design shows everything.

### Recommendations
- [ ] Invite tokens: `secrets.token_urlsafe(32)`, single-use, 7-day expiry
- [ ] Log all workspace switches as security events
- [ ] Rate-limit invite acceptance: 5 attempts per token per hour
- [ ] Admin endpoints: separate auth mechanism or 2FA gate
- [ ] Consider per-workspace "disable org inheritance" flag for high-security clients
- [ ] Sanitize usage data visible to partners (aggregate, not per-user)

---

## Agent 2: Data Engineer / DBA

### How this fails

**The soft delete gap (CTO's insight).** When a conversation is deleted, its audio duration metadata disappears. But billing needs that data. "You used 25 hours this month" becomes "you used 18 hours" because someone deleted 7 hours of conversations mid-month. The customer disputes the invoice. You have no proof.

This extends beyond conversations. If a project is deleted, all its conversations vanish from usage calculations. If a workspace member is removed, you lose the "they were a billable seat for 15 days" data.

**The fix: Universal soft delete with metadata preservation.**

Every entity that affects billing needs a soft delete that preserves billing-relevant metadata:

```
conversation.deleted_at        → keep: duration_seconds, audio_hours, created_at
project.deleted_at             → keep: workspace_id, conversation_count_at_deletion
workspace_membership.deleted_at → keep: user_id, role, created_at (for seat-days calc)
workspace.deleted_at           → keep: tier, org_id, member_count_at_deletion
```

Implementation pattern — every "delete" route must:
1. Route through Python API (not Directus direct)
2. Set `deleted_at = now()` instead of `DELETE`
3. Emit a usage_event with metadata snapshot
4. All SELECT queries add `WHERE deleted_at IS NULL`

**Subagent task for implementation:** Audit every existing DELETE endpoint (Directus + Python), reroute through Python, convert to soft delete, update all queries.

**The query performance cliff.** Permission resolution joins 4 tables. The workspace selector joins workspace + org_membership + workspace_membership + counts. These are fine at 10 workspaces but degrade at 100+ (which a large partner will have).

**The fix:**
- Materialized view for "user accessible workspaces" refreshed on membership changes
- Or: denormalized `workspace_summary` table updated via triggers/events
- Index strategy: composite indexes on the JOIN paths

```sql
-- Critical indexes for permission resolution
CREATE INDEX idx_org_membership_user_role ON org_membership(user_id, role);
CREATE INDEX idx_ws_membership_user ON workspace_membership(user_id) INCLUDE (workspace_id, role);
CREATE INDEX idx_project_workspace_visibility ON project(workspace_id, visibility) WHERE deleted_at IS NULL;
CREATE INDEX idx_project_user_project ON project_user(project_id, user_id);
```

**Migration atomicity.** The migration script creates org + workspace + membership + moves projects for EVERY existing user in one go. If it fails halfway, you have orphaned data.

**The fix:**
- Wrap per-user migration in its own transaction (not one giant transaction)
- Add idempotency check (`IF EXISTS org_membership for this user, SKIP`)
- Run in batches of 50 with progress logging
- Dry-run mode that reports what it WOULD do

### Recommendations
- [ ] Soft delete on: conversation, project, workspace, workspace_membership, org_membership
- [ ] Emit metadata snapshot in usage_event on every soft delete
- [ ] All deletes routed through Python API (no direct Directus deletes)
- [ ] Add `WHERE deleted_at IS NULL` to all existing queries (tracked as implementation subtask)
- [ ] Composite indexes for permission resolution
- [ ] Migration: per-user transactions, idempotent, batched, dry-run mode

---

## Agent 3: Frontend Engineer

### How this fails

**Workspace context is ambient state.** Once a user selects a workspace, every API call needs `workspace_id`. Where does this live? If it's in the URL (slug), the frontend has to slug→ID resolve on every route transition. If it's in React context/store, a page refresh loses it. If it's in localStorage, it can desync with the URL.

**The fix:** Single source of truth:
- URL slug is the authority: `/:locale/:workspaceSlug/...`
- On route mount, resolve slug→workspace (cache aggressively)
- Store resolved workspace in React context (but derive from URL, don't sync bidirectionally)
- If slug resolution fails (404), redirect to workspace selector
- localStorage stores `lastWorkspaceSlug` for the post-login redirect ONLY

```typescript
// WorkspaceProvider pattern
function WorkspaceProvider({ children }: PropsWithChildren) {
  const { workspaceSlug } = useParams();
  const { data: workspace, error } = useQuery(
    ['workspace', workspaceSlug],
    () => api.getWorkspaceBySlug(workspaceSlug),
    { staleTime: 60_000 } // Cache for 60s
  );

  if (error?.status === 404) return <Navigate to="/select-workspace" />;
  if (!workspace) return <WorkspaceLoading />;

  return (
    <WorkspaceContext.Provider value={workspace}>
      {children}
    </WorkspaceContext.Provider>
  );
}
```

**Stale workspace list.** User is on workspace selector. Another admin adds them to a new workspace. They don't see it until they refresh. Worse: they get removed from a workspace, navigate to it from a stale selector, and get a 403.

**The fix:** 
- Poll workspace list every 30s on the selector page
- On 403 from any workspace API call, invalidate workspace cache and redirect to selector with a toast: "You no longer have access to this workspace"

**Deep linking breaks.** User shares `app.dembrane.com/en/dietz/projects/abc123` with a colleague. Colleague clicks it. They're not logged in. After login, the post-login router sends them to the workspace selector instead of the deep link.

**The fix:** Store the intended URL pre-login, restore after authentication:

```typescript
// Before redirect to login
sessionStorage.setItem('redirectAfterLogin', window.location.pathname);

// After login
const redirect = sessionStorage.getItem('redirectAfterLogin');
if (redirect) {
  sessionStorage.removeItem('redirectAfterLogin');
  navigate(redirect);
} else {
  navigate(postLoginRoute);
}
```

**Mobile: workspace selector on small screens.** The card view works on tablet but is cramped on phone. The list view is fine on phone but wastes space on desktop.

**The fix:** Card view only on tablet+, always list view on mobile. Don't try to make cards responsive — just switch the component.

### Recommendations
- [ ] WorkspaceProvider derives from URL, caches in context, never syncs bidirectionally
- [ ] Slug→ID resolution with aggressive caching (60s staleTime)
- [ ] 403 handling: invalidate cache, redirect to selector, toast
- [ ] Deep link preservation through login flow (sessionStorage)
- [ ] Mobile: list view only, card view tablet+
- [ ] Polling on selector page (30s interval)

---

## Agent 4: Product Manager (Customer Success)

### How this fails

**The "Default workspace" is confusing.** Every user gets a workspace called "Default" in an org called "{Name}'s Organization." For solo facilitators who never need multi-user features, this is mystery meat. "Why am I in an organization? I'm a freelancer." "What's a workspace? I just want my projects."

**The fix:** 
- For single-workspace users: HIDE all workspace/org language. Don't show "Default" anywhere. The experience should be identical to today — just "Projects."
- Only surface workspace concepts when the second workspace is created or when they're invited to someone else's workspace.
- The org name should be editable during onboarding (not auto-generated as "Sameer's Organization").
- Consider: don't auto-name it at all. When the user first needs to see the org name (e.g., inviting someone), prompt them to name it.

**Partner can't explain it to clients.** This is the imagination problem from the strategy doc, now in the product itself. A partner creates a workspace for Client 1 and invites C1X. C1X gets an email: "You've been invited to a workspace on Dembrane." C1X has never heard of Dembrane. They don't know what a workspace is. They bounce.

**The fix:**
- Invite email must be customizable by the partner (at minimum: partner logo, partner name, custom message)
- The invite landing page should show: who invited you, what org, and a one-sentence explanation
- Consider: "You've been invited by [Partner Name] to collaborate on [Workspace Name]"
- Partner should be able to preview the invite email before sending

**Tier confusion during workspace creation.** Partner creates a new workspace for a client. What tier is it? The mockdown shows a tier selection step, but the pricing page isn't in-app. The partner has to remember "Pioneer is €200, Innovator is €500..."

**The fix:**
- Show tier comparison inline during workspace creation (not just a dropdown)
- Default to the partner's own workspace tier (reasonable guess)
- Show estimated monthly cost based on selection
- "Contact us" for Guardian tier (don't make it self-serve)

**No onboarding for the workspace concept.** Existing users who've been using Dembrane for months suddenly see a workspace selector after the migration. "What changed? Did I lose my data?"

**The fix:**
- First login after migration: show a one-time explainer modal
- "We've upgraded your account! Your projects are right where you left them, now inside your workspace. Here's what's new: [collaborate with team members, manage client projects, ...]"
- Include a "Learn more" link to documentation
- Make it dismissible but not skippable on first appearance

### Recommendations
- [ ] Hide workspace/org language for single-workspace users
- [ ] Customizable invite emails (partner logo, custom message)
- [ ] Tier comparison card during workspace creation
- [ ] Post-migration onboarding modal for existing users
- [ ] Lazy naming: don't force org name on signup, prompt when needed

---

## Agent 5: DevOps / SRE

### How this fails

**Migration script runs against production DB with no rollback.** The migration creates orgs and workspaces for every user and updates every project. If it corrupts data, there's no undo.

**The fix:**
- Take a full DB snapshot before migration
- Run migration on a clone first, verify
- Migration script has a `--dry-run` flag that logs what it would do
- Migration is idempotent (can be re-run safely)
- Each user migration is its own transaction
- Progress reporting: "Migrated 450/2000 users, 3200/8500 projects"

**No health checks for the new workspace layer.** The Python API now has critical new functionality. If the workspace endpoints go down, users can't log in (post-login router calls `/api/v1/workspaces`). But there's no specific health check for workspace functionality.

**The fix:**
- `/api/v1/health` checks: DB connectivity, workspace table exists, can query workspace_membership
- Post-login router: if workspace endpoint fails, fall back to legacy project list (graceful degradation)
- Alert on workspace endpoint error rate > 1%

**Alembic migration + Directus in same DB = collision risk.** Alembic manages workspace tables. Directus manages its own tables. If Directus runs a migration that affects shared resources (indexes, sequences, roles), it could conflict with Alembic's state.

**The fix:**
- Use separate schemas: `public` for Directus, `app` for workspace tables
- Or: prefix all workspace tables with `app_` to avoid any naming collision
- Document: "Never modify app_* tables through Directus admin panel"

### Recommendations
- [ ] DB snapshot before migration, clone-test first
- [ ] Migration: dry-run, idempotent, per-user transactions, progress logging
- [ ] Health check endpoint covering workspace layer
- [ ] Graceful degradation if workspace API is down
- [ ] Schema separation or table prefixing to avoid Directus collision

---

## Agent 6: Business / Pricing Strategist

### How this fails

**Seat counting double-charges partners.** PX (org owner) is a billable seat in WS A, WS B, and WS C. If each workspace is on Pioneer (3 seats), PX consumes one seat in each. The partner is paying for PX three times. At €25/extra seat, that's €75/month for one person existing in multiple workspaces.

This is the correct business model if each workspace is a separate client engagement (they're getting value in each). But it FEELS wrong to the partner. "I'm paying for myself three times?"

**The fix (product, not pricing):**
- Be explicit about this in the UI: "Members who belong to multiple workspaces count as a seat in each"
- Consider: first N workspaces include the org admin as a "free seat" (avoids the psychological sting)
- Or: partner-tier pricing that includes "unlimited org admin seats across your workspaces"
- At minimum: show a clear breakdown so there are no surprises on the invoice

**Audio hours are consumed even on failed transcriptions.** User uploads 2 hours of audio, transcription partially fails (bad audio quality, language mismatch). They re-upload. Now they've "used" 4 hours. With Pioneer at 25h/month and €5/extra hour, that's a €10 charge for a system failure.

**The fix:**
- Only count successfully transcribed audio toward usage
- Failed/partial transcriptions should be flagged in usage events: `{ "status": "failed", "billable": false }`
- Show "billable hours" vs "total hours" in usage dashboard
- Allow admin to mark specific events as non-billable (for support resolution)

**No trial/free tier means self-service friction.** The cheapest option is Pilot at €349 (one-time) or Pioneer at €200/month. There's no way for someone to try Dembrane without committing €200+. The strategy doc says "you need to experience it to imagine what it can do" — but the pricing prevents experiencing.

**Consideration:** This is a deliberate filter for quality clients. But the workspace architecture should support a `free` or `trial` tier if you ever decide to add one. The `tier` field is a string so this is fine architecturally. Just note it.

### Recommendations
- [ ] Explicit UI explanation of per-workspace seat counting for multi-workspace users
- [ ] Only count successfully processed audio as billable hours
- [ ] `billable: bool` field on relevant usage events
- [ ] Support marking events as non-billable (admin/support tool)
- [ ] Ensure tier field supports future `free`/`trial` values

---

## Agent 7: Legal / Compliance

### How this fails

**Data residency is workspace-level, not just platform-level.** Dembrane is EU-hosted (good). But different clients may have different data residency requirements. A Dutch municipality may require data to stay in NL. A German client may require DE. Currently, all workspaces share the same infrastructure.

**For now:** This is fine — all EU-hosted. But the workspace model should have a `region` field for future multi-region support. Don't build it, just don't design it out.

**Soft delete retention periods.** GDPR gives users the right to erasure. Soft delete with 30-day retention is fine for business data, but if a user requests account deletion, all their personal data must be purged within 30 days (not just soft-deleted).

**The fix:**
- Soft delete for billing/audit purposes: preserve metadata, strip PII
- User deletion (GDPR): hard delete PII, keep anonymized usage events
- Two different paths: "delete conversation" (soft, keep metadata) vs "delete my account" (hard, GDPR)

```python
# Conversation soft delete (billing-safe)
async def soft_delete_conversation(conversation_id: str):
    # Snapshot billing metadata before soft delete
    await emit_usage_event("conversation.deleted", {
        "duration_seconds": conversation.duration_seconds,
        "audio_hours": conversation.audio_hours,
        "project_id": str(conversation.project_id),
    })
    await db.execute(
        "UPDATE conversation SET deleted_at = now() WHERE id = :id",
        {"id": conversation_id}
    )
    # Audio file can be purged immediately (not needed for billing)
    await delete_audio_file(conversation.audio_path)

# GDPR account deletion (privacy-safe)
async def gdpr_delete_user(user_id: str):
    # Anonymize usage events (keep for billing, strip PII)
    await db.execute(
        "UPDATE usage_event SET user_id = NULL, "
        "event_data = event_data - 'participant_name' - 'email' "
        "WHERE user_id = :uid",
        {"uid": user_id}
    )
    # Hard delete PII-containing records
    await db.execute("DELETE FROM workspace_invite WHERE email IN (SELECT email FROM directus_users WHERE id = :uid)", {"uid": user_id})
    # Remove memberships
    await db.execute("DELETE FROM workspace_membership WHERE user_id = :uid", {"uid": user_id})
    await db.execute("DELETE FROM org_membership WHERE user_id = :uid", {"uid": user_id})
    # Anonymize user record (don't delete — preserves FK integrity)
    await db.execute(
        "UPDATE directus_users SET first_name = 'Deleted', last_name = 'User', "
        "email = 'deleted-' || id || '@deleted.dembrane.com' WHERE id = :uid",
        {"uid": user_id}
    )
```

**Data processing agreements (DPA) scope changes.** Today, Dembrane processes data for one customer at a time. With workspaces, partner consultancies process data on behalf of their clients, through Dembrane. This is a sub-processor chain: Client → Partner → Dembrane. The DPA needs to reflect this.

**For now:** Flag for legal review. Not a technical blocker, but the workspace feature changes the data processing relationship.

### Recommendations
- [ ] Add `region` field to workspace (nullable, future use)
- [ ] Two deletion paths: soft delete (billing) vs GDPR erasure (privacy)
- [ ] GDPR deletion anonymizes usage events, doesn't delete them
- [ ] Audio files can be hard-deleted immediately on conversation delete
- [ ] Flag DPA update for legal team before B2B2B partner features go live

---

## Agent 8: The Dev Who Has to Implement This

### How this fails

**Scope creep disguised as "best practices."** The PRD + architecture review + this failure analysis describe a system that would take a team of 4 engineers ~3 months. If one person is building this, half of the "best practices" need to be deferred or the feature never ships.

**The actual critical path is:**
1. Tables + migration script (1 week)
2. Core API: workspace CRUD + membership + permission resolution (1 week)
3. Frontend: routing + selector + topbar (1 week)
4. Frontend: settings pages + usage dashboard (1 week)
5. Soft delete conversion + usage event instrumentation (1 week)
6. Testing + edge cases + polish (1 week)

That's 6 weeks for a focused engineer. Every "nice to have" adds a week.

**What to defer (build later, design for now):**
- `app_user` indirection table (just FK to directus_users for now, migrate later)
- Event versioning (add `"v": 1` but don't build multi-version aggregation)
- Materialized views for permission (single JOIN query is fine for now)
- Rate limiting (add after launch if abuse occurs)
- Request tracing (use existing logging)
- Customizable invite emails (plain text email first)
- Tier comparison during workspace creation (just a dropdown)

**What must NOT be deferred:**
- Soft delete (can't retrofit without data loss)
- Tenant isolation middleware (can't retrofit without security audit)
- usage_event table partitioning (can't add to existing table)
- Immutable slugs decision (can't change once URLs are in the wild)
- Pagination on list endpoints (can't add without breaking clients)

**The migration is the scariest part.** It touches every user and every project. If it's wrong, everything is wrong. Budget 2 full days for migration script development and testing. Run it on a DB clone at least 3 times before production.

### Recommendations for implementation sequencing
- [ ] Week 1: Schema + migration + soft delete columns + app_user table decision
- [ ] Week 2: Core API (CRUD, permissions, invites) + tenant isolation middleware
- [ ] Week 3: Frontend routing + workspace selector + post-login router
- [ ] Week 4: Settings pages + member management + invite modal
- [ ] Week 5: Usage events + dashboard + soft delete conversion of existing endpoints
- [ ] Week 6: Testing, edge cases, migration dry-run on prod clone, deploy
