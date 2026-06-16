# Agentic chat + virtual filesystem / git-over-S3: design exploration

Status: exploration / proposal. Not yet a committed plan.
Branch: `feat/agentic-vfs` (worktree). Reference repos cloned (gitignored) under `.agent-reference/` in the main checkout: `sam`, plus notes on `tursodatabase/agentfs`, `awslabs/git-remote-s3`, `strukto-ai/mirage`.

## 1. Goal

Three things the user wants, in priority order:

1. Land the live **agentic chat** work (LangGraph + CopilotKit agent on port 8001). Most of it is already in-tree on this branch.
2. Give the agent a **virtual filesystem + git, backed by object storage (S3 / DO Spaces)**, isolated per workspace / org / user. Inspiration: `dembrane/sam` and the three reference repos.
3. Reframe **chat as a first-class, scope-level entity** that is no longer hard-linked to a single project, because real events (workshops, consultations) span multiple projects. Make it collaborative across the members of its scope, and reachable from multiple input channels (native CopilotKit chat, Slack, Gmail).

End goal: a materially better chat for users.

## 1a. Decisions locked (from review)

1. **Access control** is a *dynamic scope intersection*, not a fixed boundary:
   - **Hard line = what the user can access** (derived from `org_membership` / `workspace_membership` / `project_membership`). The agent can never read or write data the user can't.
   - **Soft line = sharing flags.** Cross-organization and cross-workspace context is allowed *unless* a no-sharing flag forbids it. A single chat may not span two orgs if either denies sharing. The same restriction can exist at workspace level (a workspace flag opts in/out of being combined with others).
   - The effective scope **collapses to the smallest applicable boundary**: a private/no-share workspace confines the chat to itself even within the same org. (The sharing flag is likely *separate* from the existing "private workspace" flag - TBD.)
2. **Git layer is optional and artifact-focused.** Its job is tracked artifacts (reports now, pull-request-like flows and CI-on-new-artifact later) with attribution: `git blame` on a report, who changed what and when. **The repo structure mirrors the database hierarchy** (org -> workspace -> project -> artifacts); the collaboration model (ownership, roles, permissions) is the one already in the DB. **Dembrane is the frontend for this git.** S3-vs-not is an implementation detail for us to decide.
3. **v1 channel = native CopilotKit chat.** Other adapters (Slack/Gmail) come later.
4. **Headline capability: agent-generated dynamic code in sandboxed frontend slots.** The agent generates dynamic UI/code whose *state lives in the git backend*; the agent manipulates that state through git; the frontend listens for those changes and re-renders. The frontend must provide sandboxed "slots" where this dynamic execution is contained. (Surfacing these built artifacts back to staff is a later, separate concern.)

## 2. What exists today (baseline)

The agentic chat already in this branch:

- **Agent service** (`agent/`, port 8001): LangGraph state machine wrapped by the CopilotKit SDK (`CopilotKitRemoteEndpoint` + `LangGraphAgent`), Gemini via `langchain_google_genai`. Route `POST /copilotkit/{project_id}` streams NDJSON.
- **Tools** (`agent/agent.py`): all read-only and project-scoped, fronted by the Echo BFF (`agent/echo_client.py`): `listProjectConversations`, `findConvosByKeywords`, `listConvoSummary`, `listConvoFullTranscript`, `grepConvoSnippets`, `sendProgressUpdate`. No write tools. No filesystem.
- **Runtime** (`server/dembrane/agentic_runtime.py`, `agentic_worker.py`, `api/agentic.py`): reconnect-driven, lease-based in Redis. A run is created (`POST /agentic/runs`), turn execution starts when a client attaches to `POST /agentic/runs/{run_id}/stream?after_seq=N`. A Redis turn-lease (`agentic:run:{id}:turn:{seq}:lease`, 30s TTL, refreshed every 10s) guarantees a single executor; events persist to Directus (`project_agentic_run_event`, monotonic `seq`) and fan out over Redis pub/sub (`agentic:run:{id}:events`).
- **Scope + authz** (`api/agentic.py`): a run is scoped to a single **project** (`project_agentic_run.project_id`) and a **user** (`directus_user_id`). Authorization is *ownership-based*: `_assert_project_authorized` / `_assert_run_authorized` allow admins or the owning user only. Pilot-tier workspaces are hard-blocked.
- **Frontend** (`frontend/src/components/chat/AgenticChatPanel.tsx`): consumes the SSE stream directly (it does **not** use the CopilotKit React UI), renders the event timeline, persists `runId` in localStorage, falls back to polling. Gated by `ENABLE_AGENTIC_CHAT` (off in production).
- **Storage**: none. The agent is stateless per run over Directus data + transient Redis state.

Data-model facts confirmed in Directus snapshots:

- Hierarchy is **org -> workspace -> project**: `project.workspace_id`, plus `org_membership` / `workspace_membership` / `project_membership` tables already exist. Collaboration and scoped access control have a real foundation already.
- Today's non-agentic chat (`project_chat`) is hard-scoped to one `project_id` and tracks `used_conversations`. The agentic run (`project_agentic_run`) is likewise project-scoped.
- Object storage is **S3-compatible with a configurable endpoint** (`STORAGE_S3_ENDPOINT`, `STORAGE_S3_BUCKET`) => DigitalOcean Spaces, not AWS S3. The Echo backend already mediates object access through a shared file service (`_get_audio_file_object`).

## 3. Reference systems, digested

### dembrane/sam - the harness model
A Claude-Code-style "engineering coworker." Event-driven daemon (Slack socket mode + GitHub webhooks), single-instance lock, reaction-based state machine (`:eyes:` -> `:hourglass:` -> terminal), recovery on boot. Prompt assembly from markdown: **capabilities** (always hot-loaded) + **skills** (catalog emitted, body read on demand) + **scope.md** (what it refuses, who the principal is). Multi-agent: Flash main + Pro executor + Opus mentor (review-only) + subagents. Persistent state at `/data` on a **GCS bucket mounted via gcsfuse** in Cloud Run: `journal/`, `tool_calls/*.jsonl`, `sessions.jsonl`, **`repos/` (git clones)**, lock + cursor. Audit trail is first-class.

What we take: the capabilities/skills/scope prompt model; isolated per-instance state directory; multi-channel input as a normalized event queue; subagents; audit/journal as a product surface.

### tursodatabase/agentfs - per-agent filesystem as a single SQLite file
The entire agent runtime (files + KV state + tool-call history) lives in **one SQLite (Turso) `.db` file**. POSIX-like FS, KV store, queryable audit trail. **Copy-on-write overlays** give cheap snapshot / fork / time-travel. FUSE (Linux) / NFS (macOS) mount or programmatic SDK (Rust core, Python + TS SDKs). No native S3 backend, but the single file is portable, so the unit of sync to object storage is one blob per agent workspace.

What we take: the snapshot/fork/time-travel model and the single-portable-artifact-per-scope idea. Strong fit if we want "branch this chat's workspace" UX. Weakness: not git, and syncing a hot SQLite file to Spaces needs care.

### awslabs/git-remote-s3 - literal "git via S3"
A git remote helper (Python, `pip install`) that makes an S3 bucket a serverless git remote. Bundles stored at `<prefix>/<ref>/<sha>.bundle`; push = `git bundle create` + upload, then prune older bundles. **Per-ref locking via S3 conditional writes** (`<prefix>/<ref>/LOCK#.lock`, 60s TTL); a `doctor` command reconciles multiple-head divergence. Access control via **IAM** (per-prefix policies for multi-tenant); IRSA on EKS; encryption in transit + at rest.

What we take: this is the most direct answer to "git via S3," and git maps cleanly to the collaboration model (branches, history, review). **Two caveats for us:** (a) its locking depends on S3 conditional-write / `If-None-Match` semantics that **DO Spaces does not reliably support** -> we must not rely on it; (b) its clean multi-tenancy story is **IAM-per-prefix**, which **Spaces does not offer** (Spaces uses static access keys, no per-prefix IAM roles).

### strukto-ai/mirage - unified VFS over many backends
Presents S3, Google Drive, Slack, GitHub, Postgres, Redis, etc. as one **POSIX filesystem with bash semantics** ("read, grep, pipe across every backend, zero new vocabulary"). ~50 resources, TS + Python, two-layer cache (index + bytes) optionally shared via Redis. Plugs into agent SDKs incl. Claude Code via a CLI daemon. Multi-tenancy/access-control is **not** a built-in; you wrap it per scope.

What we take: this is the answer to the **input** side - "events span multiple projects" and "external sources like Slack/Gmail." Mount the whole scope (all its projects/conversations/reports) plus external connectors as one read-mostly tree the agent navigates with `ls`/`grep`/`cat`. Weakness: we own the isolation wrapper.

## 4. Proposed architecture: three distinct layers

These solve different problems and should not be conflated.

```
                    ┌─────────────────────────────────────────────┐
   input channels   │  Slack  ·  Gmail  ·  native CopilotKit chat  │
                    └───────────────────────┬─────────────────────┘
                                             │  (normalized run events)
                    ┌────────────────────────▼─────────────────────┐
   harness (C)      │  capabilities / skills / scope  ·  subagents  │
   SAM-inspired     │  audit + journal  ·  Redis lease/run runtime  │
                    └─────────┬───────────────────────────┬────────┘
                              │ reads                      │ writes
              ┌───────────────▼──────────┐   ┌─────────────▼──────────────┐
   layer B    │  unified read VFS        │   │  agent workspace (state +   │  layer A
   (mirage)   │  scope-rooted: all       │   │  scratch + durable git)     │  (git-over-S3)
              │  projects/convos/reports │   │  per-scope git repo,        │
              │  + Slack/Gmail/Drive     │   │  remote = Spaces prefix     │
              └──────────────┬───────────┘   └─────────────┬──────────────┘
                             │                             │
                    ┌────────▼─────────────────────────────▼────────┐
                    │  Echo backend file/data service (single trust  │
                    │  boundary)  ·  Directus  ·  DO Spaces           │
                    └────────────────────────────────────────────────┘
```

### Layer A - the artifact store (optional git-over-S3)
Not a general scratchpad - a **versioned artifact store for things worth tracking**: reports today, agent-generated dynamic-UI code (see Layer D), and later PR-like review flows and CI-on-new-artifact. The value of git here is **attribution and history**: `git blame` on a report, who changed what and when, a diffable trail per artifact.

The repo layout **mirrors the database hierarchy** so the structure and the collaboration model stay in lockstep, and so traversal is trivial:

```
org/<org_id>/
  workspace/<workspace_id>/
    project/<project_id>/
      reports/<report_id>.md
      artifacts/<artifact_id>/...        (dynamic-UI code, generated assets)
    workspace-level-artifacts/...
```

Ownership/roles/permissions are **not re-encoded in git** - they come from the DB membership model (§6). **Dembrane is the frontend for this git**; users never run git directly. Implementation choices, adapted to our constraints:

- **Do not rely on S3 conditional-write locking** (Spaces conditional-PUT is unreliable). Two viable serialization mechanisms, both already in the stack:
  - *Redis lease* (the agentic turn lease, re-keyed per scope: `agentic:scope:{scope_id}:repo:lock`). The runtime is already single-executor per turn; extend that to the repo.
  - *Queue serialization (preferred for durable writes)* - funnel artifact writes to a dedicated Dramatiq actor on the existing `network` queue, **keyed/ordered per scope**, with an **idempotency key** (op id or content hash) so retries are safe. The queue already serializes and survives restarts; report generation already uses `dramatiq.group()` so the fan-out/serialize pattern is established. Constraint: actors are gevent, **no asyncio** (`tasks.py` rule), and the git push must be a sync subprocess - which fits a worker fine. Net: interactive/low-latency edits can take the Redis lease; committed artifacts (reports, generated tool code) go through the queue for durability + idempotency.
- **Backend mediates all Spaces access.** The agent never holds bucket credentials. Because Spaces has no per-prefix IAM, isolation is enforced at the **application layer**: the file/data service resolves `scope_id -> prefix` and refuses cross-scope paths. Same trust boundary as today's audio file service.
- **Hydrate-on-start, checkpoint-on-write** rather than a fuse mount. SAM uses gcsfuse; the Spaces analogue (s3fs/goofys) is fragile. Cleaner: on session start, `git clone`/`pull` the scope repo into an ephemeral working dir (emptyDir/PVC in the agent pod); on each checkpoint, `git commit && git push` to the Spaces remote. Survives pod restarts because the durable copy is in Spaces.
- Optional **agentfs** later: if we want snapshot/fork/time-travel ("branch this chat's workspace", reproducible runs), layer agentfs as the working-copy format and store its `.db` per scope. Phase 2+; not needed for v1.

### Layer B - unified read VFS (the input / multi-project ask)
A mirage-style scope-rooted read tree so the agent stops being limited to one project's conversations:

```
/scope/                         (= one workspace, the chat's scope)
  projects/<project>/conversations/<id>/transcript.md
  projects/<project>/reports/<id>.md
  connectors/slack/<channel>/...
  connectors/gmail/<label>/...
```

This directly serves "events span multiple projects" (projects are just directories under the scope root) and "external sources." v1 can be a thin wrapper exposing the existing BFF read tools as filesystem-shaped tools (`ls`, `cat`, `grep`) rather than adopting mirage wholesale; adopt mirage if the connector breadth pays for the dependency. Isolation: the tree is rooted at the scope and every resolution goes through backend authz.

### Layer C - the harness (better chat + collaboration + channels)
- **Prompt model**: adopt SAM's capabilities / skills / scope split. `scope.md` defines what the agent refuses, who the principal is, which channels are in-bounds - this is also where we encode the access-control posture in natural language on top of the hard checks.
- **Multi-channel**: keep the run as **channel-agnostic**. Native CopilotKit chat, a Slack event, and a Gmail thread all **create or continue a run** in the same Redis/Directus runtime; the channel is metadata on the run (`origin_channel`). SAM's daemon (normalize event -> queue -> session -> stream back) is the template for the Slack/Gmail adapters.
- **Collaboration**: runs/threads belong to a **scope**, visible to all scope members (see §6). The git workspace (layer A) is the shared artifact store; the audit/journal is the shared activity log.

### Layer A' - delegated execution: scripts + tools on Echo's own primitives
The ambition is bigger than "write files." A user (via the agent) should be able to **build tools on the same primitives Echo is built on** - generate an arbitrary script with Gemini 3.5 Flash and run it in a *delegated sandbox* that exposes:

- the **Directus SDK** (data layer),
- **LLM primitives** delegated from the user (the same model-router access the user has),
- **database access** (delegated, read/write within the user's envelope),
- **existing FastAPI actions** as callable primitives - edit project / portal / editor settings, create or schedule a report, etc. We do **not** hand-author a tool per endpoint; we expose the existing API surface and let generated scripts call it.

Mechanism, SAM-shaped:

- **Per-chat-session folder** in the Layer-A repo (e.g. `.../project/<id>/sessions/<chat_session_id>/`) holding the session's generated scripts, artifacts, and scratch.
- **Common primitives referenced like SAM capabilities/skills**: a curated, versioned set of primitive wrappers (Directus client, LLM client, API-action shims) that sessions import by reference rather than re-deriving. Capabilities = always available; skills = patterns pulled in on demand.
- **Delegation is per session, not global.** Each session carries a **unique access set**: which data it can touch (= the §6 effective scope of the originating user at session start) *and* which **actions** it may perform (which FastAPI primitives, read-only vs write, rate/cost ceilings on the delegated LLM/DB access). The agent runs *as* a constrained projection of the user, never with ambient backend authority. This is the crux: a generated script is only as powerful as the session's delegated grant, enforced at the primitive boundary (the wrappers check the session grant), not by trusting the script.

This is what turns "the agent builds a UI" into "the agent builds a working tool over Echo." Layer D below is the *render/interact* half; this is the *execute* half. Both are gated by §6.

### Layer D - dynamic code in sandboxed frontend slots (the headline capability)
The differentiator. The agent doesn't just answer; it **builds**: small dynamic UIs (a custom chart over conversations, an interactive filter, a live report widget, the front of a generated tool) that render inside the chat. The loop:

```
agent generates/edits artifact code ──► git backend (Layer A, attributed commit)
                                              │
                              git change event (webhook / Redis pub/sub)
                                              │
                                              ▼
frontend "slot" subscribes ──► re-renders the artifact in a sandbox
                                              │
                              user interacts; slot state changes
                                              │
                                              ▼
state diff ──► run event ──► agent reads it ──► edits artifact code ──► (loop)
```

Key properties:

- **Single source of truth is git, not React state.** The artifact's code and persisted state live in the Layer-A repo (attributed, versioned, blame-able). The frontend is a *projection* of git; it reacts to git changes rather than owning the state. This is what makes the agent's edits and the user's edits converge on one history.
- **Sandboxed slots = in-process dynamic React, not iframes.** The chosen model (per review): render **React components dynamically imported from S3/git directly on the page**, using a **shared runtime** the host injects for everything external (network, data, allowed components). No iframe, no `postMessage`, no deep JS engine features - "just the rendering engine."
  - **Library**: [`react-runner`](https://github.com/nihgwu/react-runner) is the closest fit. It runs a code string in-process with a **`scope` object** you supply (globals available to the code), supports `import`/`export default`/multi-file, and renders via a `<Runner>` component or `useRunner` hook. The injected `scope` **is** the shared runtime: we put `React`, a vetted component/UI kit, and a controlled `fetch`/Echo client into scope, and the artifact can touch *only* what's in scope. The artifact source lives in the Layer-A repo (S3); the slot fetches it and hands it to `react-runner`. Wrap in `ErrorBoundary` + `Suspense`.
  - Alternatives considered: [`react-live`](https://nearform.com/open-source/react-live/) (same in-process+scope model, but oriented to editable live-preview), [`@paciolan/remote-component`](https://www.npmjs.com/package/@paciolan/remote-component) (loads a module straight from a URL - most literal "import from S3" - but expects a CommonJS bundle and relies on `new Function`), and Webpack/Vite **Module Federation** (runtime remotes, but build-coupled and heavier). Recommend `react-runner` because the **scope injection is exactly the shared-runtime boundary** we want.
- **Change propagation.** Reuse the existing SSE/Redis pub/sub spine: a commit to an artifact path publishes an event the subscribed slot consumes (same pattern as run events today). No new realtime stack.
- **Security is the central risk, and in-process eval changes its shape.** Dynamically imported code runs in the host's JS context, so isolation is **capability-based, not a hard VM boundary**: containment = the artifact can only reach what we put in `scope`, and all data/network goes through the shared runtime, which enforces the §6 effective scope and the session's delegated grant (Layer A'). No tokens or ambient clients ever go into scope. Practical implications: (a) `react-runner` transforms+evaluates code, which interacts with CSP `unsafe-eval` - we accept and document this tradeoff, having explicitly ruled out iframes; (b) a vetted component allowlist + a hardened shared-runtime `fetch` (scope-checked, no arbitrary origins) are the real guardrails; (c) own threat model + `/security-review` before any generated code executes. If hard isolation is ever required, a worker/WASM (e.g. QuickJS) sandbox is the fallback - but that's explicitly out of scope for now.
- **Build approach**: evaluate whether CopilotKit's generative-UI surface can *host* the `react-runner` slot (CopilotKit drives the chat; `react-runner` renders the artifact; git is the persistence/edit channel behind it) before building a bespoke chat shell.
- **Later (separate concern)**: surfacing these built artifacts/connections back to staff for reuse or governance.

## 5. Chat as a scope-level entity (the data-model change)

Today: `project_agentic_run.project_id` is a required FK; `project_chat.project_id` likewise. This is the hard-coupling to undo.

Proposal: introduce a chat/thread entity whose **data reach is computed dynamically** (§6), not pinned to one project. A chat is anchored to an owning scope but can pull in any project/workspace/org the user may access and sharing flags permit.

- New collection (or generalized `project_chat`): `chat` with an owning scope (`owner_user_id` + anchor `workspace_id`/`org_id`), a **many-to-many** `context_refs` (the projects/workspaces actually pulled into the chat), `origin_channel`, and visibility derived from membership.
- `project_agentic_run` gains `chat_id` and `project_id` becomes **optional context**, not the scope key. On each turn the agent's effective data scope = (union of `context_refs`) ∩ (what the requesting user can access) ∩ (sharing flags) - see §6.
- Per the repo's Directus rules: do this with an **idempotent Python script against the Directus REST API**, verify against local Directus, then `sync.sh pull` and commit the snapshot. No hand-written snapshot JSON. Check for data migrations on existing project-scoped runs (backfill `chat_id`).

This is the largest single change and should be its own phase with its own migration review.

## 6. Access control & collaboration

The membership tables already exist (`org_membership`, `workspace_membership`, `project_membership`), so we do **not** invent authz - we compute an **effective scope** per request as an intersection of three things:

```
effective_scope(user, chat) =
      union(chat.context_refs)              # what the chat reaches for
    ∩ accessible(user)                      # HARD LINE - membership; never crossable
    ∩ sharing_allowed(context_refs)         # SOFT LINE - org/workspace no-share flags
```

- **Hard line - user access.** Every data read/write is gated by the requesting user's membership. The agent runs *as* the user's access envelope; it can never reach data the user can't. This is non-negotiable and is the floor under everything else.
- **Soft line - sharing flags.** Cross-org and cross-workspace combination is allowed *by default* but vetoed by flags:
  - A chat may not combine two **orgs** if either org sets no-data-sharing.
  - A **workspace** flag opts the workspace in/out of being combined with others. A private/no-share workspace **collapses the chat to that workspace** even within the same org (the "smallest applicable boundary" rule).
  - The sharing flag is probably **separate** from the existing "private workspace" flag - confirm before implementing; if it must be new, it's a small Directus field on `workspace`/`organization`.
- **Authz change (concrete)**: replace `_assert_run_authorized` / `_assert_project_authorized` (owner-only) with a membership-based check, and add a `resolve_effective_scope(user, chat)` helper that every tool call routes through. Runs/threads become visible and continuable by any member of the chat's scope, subject to the same intersection. Keep admin bypass and the Pilot-tier block.
- **Storage isolation (Layer A)**: the git repo path is the **DB hierarchy** (`org/.../workspace/.../project/...`); access to a path is gated by the *same* `resolve_effective_scope`. The agent never receives raw Spaces keys; the backend file service resolves and refuses out-of-scope paths. (Spaces has no per-prefix IAM, so app-layer enforcement is the only option - a deliberate, documented decision.)
- **Connector credentials** (Slack/Gmail/Drive, later): stored per scope, resolved server-side, never exposed to the model (mirrors SAM keeping creds in the runtime, not the prompt).
- **Run /security-review** before merging the authz change *and* before any Layer-D generated code executes (project rule for auth/permission/session changes).

## 7. Kubernetes / DOKS + Spaces constraints (the hard part)

The deployment is DigitalOcean Kubernetes + Spaces + managed Postgres/Redis, Helm + Argo CD (see `echo-gitops/`). This breaks several assumptions the reference repos make:

| Assumption in reference | Reality on DOKS + Spaces | Mitigation |
|---|---|---|
| git-remote-s3 locks via S3 `If-None-Match` | Spaces conditional-PUT support is unreliable | Use the existing **Redis lease** to serialize per-scope repo writes; never depend on object-store locking |
| git-remote-s3 multi-tenancy via per-prefix **IAM** | Spaces uses static access keys, no per-prefix IAM/IRSA | **Backend mediates** all access; isolation enforced app-side by `scope_id -> prefix` |
| SAM mounts state via **gcsfuse** | s3fs/goofys against Spaces is fragile | **Hydrate-on-start / checkpoint-on-push**; durable copy lives in Spaces, working copy is ephemeral pod storage |
| Agent has a long-lived writable home | Agent service pods are stateless/replaceable | Working dir is `emptyDir` or a small PVC; truth is the Spaces git remote; rebuild on session start |
| Dramatiq does the heavy lifting | **No asyncio in Dramatiq actors** (hard rule) | Git/VFS work happens in the **agent service / stream worker**, not Dramatiq actors - the agentic runtime is reconnect-driven from the stream endpoint, which is the right home |

Other notes:
- Per-scope **write concurrency** is bounded by the Redis lease keyed on scope; reads (layer B) are unbounded and cacheable.
- One git repo per workspace keeps object count and clone size bounded; prune/gc strategy needed if histories grow (git-remote-s3 prunes superseded bundles on push).
- The agent service may need git + the remote helper installed in its image, plus Spaces credentials available **only to the backend it calls**, not to the agent container if we keep the mediation boundary strict.

## 8. Suggested phasing

1. **Land + de-risk current agentic chat.** Merge the in-tree work, keep `ENABLE_AGENTIC_CHAT` gated, confirm the Redis/Directus runtime is solid. No data-model change yet.
2. **Effective-scope authz.** Replace owner-only checks with the membership-based `resolve_effective_scope` (hard line) and add the org/workspace sharing flags (soft line). `/security-review`. Unlocks collaboration; no chat-shape change yet.
3. **Chat as a scope-level entity.** Directus migration: chat decoupled from a single project, M2M `context_refs`, `chat_id` on runs, backfill existing project-scoped runs. Frontend: chat no longer requires a project.
4. **Layer A - artifact store (git over Spaces).** Repo layout mirrors org/workspace/project, Redis-serialized writes, hydrate/checkpoint, backend-mediated access scoped via `resolve_effective_scope`. First write tools (the agent commits reports/artifacts).
5. **Layer A' - delegated execution.** Per-session folder + common-primitive wrappers (Directus/LLM/DB/API-action shims) + the per-session grant model. The security core; own design + `/security-review`. Gates what generated scripts can do.
6. **Layer D - dynamic code in sandboxed slots.** The headline. `react-runner` slot + injected shared-runtime scope + git-change->frontend reactive loop on top of Layers A/A'. Own threat model + `/security-review`. Evaluate CopilotKit generative UI as the host first.
7. **Layer B - unified read VFS.** Scope-rooted read tree over all reachable projects; filesystem-shaped read tools. Then external connectors (Slack/Gmail) as mounts.
8. **Layer C polish + channels.** capabilities/skills/scope prompt model; Slack/Gmail input adapters; audit/journal surface; optional subagents; optional agentfs snapshot/fork; surfacing built artifacts to staff.

## 9. Decisions (resolved + remaining)

Resolved (see §1a):
- Isolation = dynamic intersection with user-access hard line + sharing-flag soft line.
- Git = optional artifact store mirroring the DB hierarchy, Dembrane as its frontend.
- v1 channel = native CopilotKit chat.
- Headline = dynamic code in sandboxed slots backed by git.
- **Slot sandbox = in-process dynamic React via `react-runner` + injected shared-runtime scope** (no iframe).
- **Agent can run delegated arbitrary scripts** over Echo primitives (Directus SDK, delegated LLM/DB, existing FastAPI actions), per-session folder + SAM-style common capabilities/skills, with a per-session access+actions grant.
- **Write serialization** can use either the Redis lease (interactive) or the Dramatiq queue with idempotency keys (durable artifacts) - both are in the stack.

Remaining:

1. **Sharing flag vs private-workspace flag**: is "can this workspace/org be combined into a cross-scope chat" a *new* flag, or does it reuse an existing privacy field? (Affects the Directus migration scope.)
2. **Delegation grant model**: how is a session's per-session access+actions grant represented and enforced - a signed capability token the primitive wrappers check, a per-session Directus role, or a scoped service token minted from the user's session? This is the security core of Layer A' and needs its own design + `/security-review`.
3. **CSP posture for `react-runner`**: confirm we accept `unsafe-eval` for the slot, plus the vetted component allowlist + hardened shared-runtime `fetch`. (Hard-isolation fallback = worker/WASM, out of scope now.)
4. **CopilotKit generative UI vs bespoke shell** for hosting the `react-runner` slot.
5. **Spaces vs a dedicated AWS S3 bucket** for the git layer specifically (cleaner IAM + conditional-write locking, at the cost of a second object store + AWS creds).
6. **agentfs**: do we want snapshot/fork/time-travel ("branch this chat") enough to add it, or is git history sufficient?
