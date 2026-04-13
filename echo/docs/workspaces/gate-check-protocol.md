# Gate Check Protocol
## "Surgical Timeout" Before Every Code Change Session

---

## The Rule

**No Claude Code session makes code changes without first running a Gate Check.**

Session 1 (Explore) is exempt — it's read-only.
Sessions 2, 3, and 4 MUST run the Gate Check before the first commit.

---

## How It Works

Every session prompt includes a two-phase structure:

```
PHASE 1: GATE CHECK (mandatory, before any changes)
  - Analyze what you're about to do
  - Surface impacts, risks, and open questions
  - Ask me questions until I say "proceed"
  - Do NOT write any code until I explicitly say "proceed"

PHASE 2: EXECUTE (only after I say "proceed")
  - Make changes commit by commit
  - Pause after each commit for my review
```

The Gate Check is NOT a formality. It's where the agent catches things like:
- "This collection has 3 Directus hooks that fire on delete — my soft delete conversion will trigger them"
- "The project.directus_user_id field has a unique constraint I didn't expect"
- "There's an existing archived_at field on conversations that conflicts with our deleted_at plan"

---

## Gate Check Template

Add this to every session prompt (Sessions 2, 3, 4):

```
IMPORTANT: This session has two phases. Do NOT skip Phase 1.

=== PHASE 1: GATE CHECK ===

Before making ANY code changes, do the following:

1. IMPACT ANALYSIS
   List every file you plan to modify or create. For each:
   - File path
   - What changes
   - What could break

2. BLAST RADIUS
   Answer these questions:
   - What existing functionality could this break?
   - What Directus hooks/flows/triggers will be affected?
   - Are there any scheduled jobs or background processes that touch these collections?
   - Will any existing API responses change shape?
   - Will any existing frontend behavior change?

3. IRREVERSIBILITY CHECK
   For each change, classify it:
   - SAFE: Additive change, easily reverted (new collection, new field, new endpoint)
   - CAUTION: Modifies existing behavior (changed query filters, rerouted deletes)
   - DANGER: Data mutation or destructive change (migration, schema modification)

   List all CAUTION and DANGER items explicitly.

4. OPEN QUESTIONS
   List anything you're unsure about. Examples:
   - "I see a Directus flow called 'cleanup-orphans' — will it conflict with soft delete?"
   - "The project collection has a field called 'status' — should deleted_at interact with it?"
   - "There are 3 different patterns for calling Directus in this codebase — which should I use?"

5. DEPENDENCIES
   What must be true before these changes work?
   - Are there collections from a previous session that must exist?
   - Are there environment variables needed?
   - Does the local DB need specific seed data?

6. ASK ME
   Based on the above, ask me specific questions. Keep asking until you have
   no remaining uncertainties. Format as numbered questions I can answer quickly.

   Examples of GOOD questions:
   - "The conversation collection has an 'audio_status' field with values
     'processing'/'complete'/'error'. Should soft-deleted conversations preserve
     this field, or should we set it to a new 'deleted' status?"
   - "I found 2 places where conversations are deleted: user-initiated delete
     in the UI, and an automated cleanup that deletes conversations with
     status='error' after 24h. Should the automated cleanup also become a
     soft delete?"
   - "The Directus permissions for the 'facilitator' role include DELETE on
     conversations. After soft delete conversion, should I remove this
     Directus permission (since deletes now go through Python)?"

   Examples of BAD questions (too vague):
   - "Is this approach okay?"
   - "Should I proceed?"
   - "Any concerns?"

DO NOT proceed to Phase 2 until I explicitly say "proceed" or "go ahead" or similar.

=== PHASE 2: EXECUTE ===

After I confirm, make changes commit by commit.
After each commit, give me a one-line summary of what changed.
Pause after every 3 commits and ask: "Should I continue?"
```

---

## Session-Specific Gate Checks

### Session 2: Schema — Gate Check Focus Areas

The agent should specifically investigate and ask about:

```
SCHEMA-SPECIFIC CHECKS:

a) For each existing collection getting a new field (deleted_at, workspace_id, visibility):
   - Are there any Directus hooks/triggers that fire on UPDATE for this collection?
   - Are there any computed/alias fields that might conflict?
   - Are there any Directus permissions that restrict field creation?
   - What's the current field count? Any approaching Directus limits?

b) For the app_user collection:
   - List EVERY field from directus_users that the Python API or frontend
     currently reads or writes
   - For each: should it be denormalized into app_user, or fetched from
     directus_users at runtime?
   - Are there any fields with sensitive data (passwords, tokens) that
     should NOT be in app_user?

c) For relations:
   - How does this project configure Directus M2O/O2M relations?
   - Are there any naming conventions for relation fields?
   - Will the new FK fields conflict with existing ones?

d) For schema sync:
   - Show me the current directus-extension-sync config
   - After I create these collections, what's the exact command to sync?
   - Is there a CI/CD step that validates schema?

ASK ME about anything that isn't clear from the codebase.
```

### Session 3: Soft Delete — Gate Check Focus Areas

```
SOFT-DELETE-SPECIFIC CHECKS:

a) For each delete operation you found:
   - Is this delete user-initiated, system-initiated, or both?
   - If system-initiated (cron, background job, Directus flow):
     should it ALSO become soft delete, or is hard delete correct?
   - What's the current error handling if the delete fails?

b) For Directus permissions:
   - Which Directus roles currently have DELETE permission on affected collections?
   - After converting to soft delete (PATCH instead of DELETE), do we need to
     ADD UPDATE permission and REMOVE DELETE permission?
   - Or do we leave Directus permissions as-is since Python uses admin token?

c) For read query updates:
   - How many read queries are there for each affected collection?
   - Are any of these queries in Directus flows/hooks (not Python/frontend)?
   - Are there any aggregate queries (COUNT, SUM) that would be affected?
   - Are there any Directus dashboard/insights panels that show these collections?

d) For the emit_usage_event utility:
   - Where should this file live? (Show me the project's utility/helper structure)
   - What's the existing logging pattern? (So error logging matches)
   - Is there an existing request context/trace ID system to use for trace_id?

e) For frontend changes:
   - List each frontend file that calls Directus DELETE directly
   - What's the existing error handling pattern in the frontend for API calls?
   - Are there any optimistic UI updates that assume immediate deletion?

ASK ME about each delete operation's intended behavior after conversion.
```

### Session 4: Core API + Migration — Gate Check Focus Areas

```
API-SPECIFIC CHECKS:

a) For the API structure:
   - Where do new route files go? Show the existing file/folder structure.
   - How are routes registered? (FastAPI router includes, prefix patterns)
   - What's the existing response format? (Envelope pattern? Raw data? Error format?)
   - What's the existing input validation pattern? (Pydantic? Manual?)

b) For auth:
   - Show me the EXACT code of the current get_current_user (or equivalent)
   - What does it return? (Directus user object? Custom user object? Just user ID?)
   - How does it handle expired sessions?
   - For admin endpoints: how do existing admin-only endpoints check admin status?

c) For the migration script:
   - What's the exact count of users in the local DB? In production?
   - How long does a typical Directus API call take locally? (To estimate migration time)
   - Is there a maintenance mode or can we run migration while the app is live?
   - What's the rollback plan if migration goes wrong?
     (Restore from backup? Reverse script?)

d) For email (invites):
   - Show me the existing SendGrid integration code
   - What email templates exist?
   - What's the FROM address used?
   - Is there a template system or are emails constructed in code?

e) For the workspace selector:
   - The API endpoint GET /workspaces needs to be FAST (called on every login)
   - How many Directus API calls will it need to assemble the response?
   - Can we batch the queries?

ASK ME about architectural decisions before implementing.
```

---

## What If the Gate Check Reveals a Problem?

Three possible outcomes from a Gate Check:

### 1. Minor clarification needed
Agent asks a question → you answer → agent proceeds.
Example: "Should deleted_at use ISO format or Unix timestamp?" → "ISO, match existing patterns" → proceed.

### 2. PRD needs updating
Agent discovers something that contradicts the PRD.
Example: "The project collection already has a 'shared_with' JSON field that stores user IDs. This overlaps with the project_user collection in the PRD."

**Action:** Update the PRD section before proceeding. The agent should propose the update, you approve it, agent writes it, THEN proceeds with code.

### 3. Scope change needed
Agent discovers something that makes the planned changes significantly harder or riskier.
Example: "There are 47 read queries across the codebase that touch the conversation collection. Adding deleted_at filter to all of them in one commit is risky."

**Action:** Replan. Break the session into smaller pieces. Or defer the risky part.

---

## The Full Session Prompt Pattern

Here's the complete prompt structure for any code-changing session:

```
You are working on the `workspaces` branch of the Dembrane ECHO platform.

CONTEXT:
[Attach PRD + codebase exploration report + this session's specific task description]

=== PHASE 1: GATE CHECK ===
[Session-specific gate check from above]

Do NOT write any code until I say "proceed."

=== PHASE 2: EXECUTE ===
[Session-specific commit sequence from execution plan]

After each commit:
- Tell me: what changed, what files, what to verify
- Pause every 3 commits and ask if I want to continue

If at any point you discover something unexpected:
- STOP
- Tell me what you found
- Ask how to handle it
- Wait for my response before continuing
```

---

## Summary

The Gate Check turns Claude Code from "autonomous agent that might go off the rails" into "surgical assistant that explains every cut before making it." It costs 5-10 minutes per session but prevents the scenario where you review 15 commits and realize commit #3 made a wrong assumption that invalidated commits 4-15.

> *Measure twice, cut once.*
> *Or in our case: Gate Check once, commit many.*
