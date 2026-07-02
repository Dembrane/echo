# Agentic chat as the default: integration design

Status: draft for review. Owner: Sameer. Written 2026-07-02 from a research pass over
the live PR (#573), the current runtime on main, the Dembrane/sam agent harness, and
an evaluation of VFS/git substrates (agentfs, git-remote-s3, mirage, vercel/eve).

## Goal

Agentic chat becomes the default chat architecture. Users can still constrain the
agent to specific conversations (today's deep dive collapses into a scoped agentic
mode). The agent gains a per-workspace virtual file system containing the product
docs and meta-skills, acts within the logged-in user's auth boundary (including
writes like project settings and portal editor), auto-onboards new users, and serves
as primary support. Model: gemini-3.5-flash.

## Decisions taken

1. Runtime stays LangGraph plus CopilotKit. vercel/eve is a competing Node agent
   backend, not a frontend for a Python agent; CopilotKit has first-class LangGraph
   support and works with Vite. assistant-ui is the fallback if CopilotKit chafes.
2. PR #573 is harvested in slices, not merged wholesale (it is 4 months old and
   CONFLICTING). Worth taking: server-side grep with chunk-level citations, citation
   rendering, agentic title generation, test suites. Not taking: the raw Vertex
   Anthropic model swap.
3. Agent model goes through the LiteLLM router config (gemini-3.5-flash), replacing
   both main's raw GEMINI_API_KEY client and the PR's raw Vertex Anthropic client.
   If a stronger reviewer tier is added later, the cheap model never decides to
   escalate on its own (scheduled or user-explicit only).
4. VFS substrate is boring and portable: one git repo per workspace, materialized
   lazily on pod-local disk; durability by pushing to S3-compatible object storage
   (git-remote-s3 after a locking spike against Spaces, else ~50 lines of DIY git
   bundle shipping); one writer per workspace enforced with the existing Redis.
   agentfs and mirage stay on the watch list (promising, too immature). Spaces has
   no S3 object versioning, so app-level git is the honest versioning layer anyway.

## VFS layout

    /docs        read-only mount of the product docs corpus (features/, users/, nl-NL)
    /skills      meta-skills as markdown with YAML frontmatter (name, description,
                 when_to_use); catalog goes in the system prompt, bodies are read
                 lazily by the agent (the sam pattern)
    /workspace   agent-writable artifacts: notes, drafts, onboarding state

Isolation = which roots get mounted for a session, resolved by the same workspace
membership resolver the BFF uses. Workspace-level first; org-shared and per-user
mounts are later additions, not new architecture.

Agent tools: fs_read, fs_grep (ripgrep), fs_write (commit per turn).

## Patterns adopted from Dembrane/sam

- capabilities/skills/scope split: identity and always-on rules hot-loaded; skills
  exposed as a frontmatter catalog with lazily read bodies.
- Per-tool-call audit trail: extend project_agentic_run_event with a tool-audit
  event type; feed it back into recovery prompts as ground truth.
- Silent-exit gate: a deterministic runtime check that the agent produced a
  user-visible answer after its last tool call, with a structured respond contract.
  Prose explains; the runtime enforces.

## Access control

- Agentic endpoints move from the legacy creator-owner check to the v2 ladder:
  resolve_project_access(...).require("chat:use") for runs (done in this branch).
- Write tools call the existing BFF endpoints, which already enforce project:update
  under a user bearer: PATCH /v2/bff/projects/{id} (project settings plus all portal
  editor fields) and /v2/bff/tags CRUD. No new permission system.
- Open issue: a 600s run can outlive the bearer JWT; validate at run start and
  surface a clean re-auth instead of failing mid-turn.

## Phases

- Phase 0 (unblocks everything, this branch): agent image in the main build matrix;
  authz ladder swap; router-based model config; align gitops agent env with the code
  that actually ships.
- Phase 1 (echo-next): ENABLE_AGENTIC_CHAT = byEnv({production: false}, true);
  harvest #573 slices; docs mount plus first meta-skills (onboarding, project setup,
  support playbook).
- Phase 2 (parity): conversation scoping as an agent constraint (reads pinned
  conversations from chat context); suggestions and title parity; free-tier gates
  already exist.
- Phase 3 (default flip): new chats default to agentic; the mode selector becomes a
  scope control; overview/deep dive remain as legacy rendering for existing chats
  (mode is immutable per chat, so migration is clean).

## Known gaps and follow-ups

- CI runs mypy and ruff but not the server pytest suite; 4 tests in
  tests/api/test_agentic_api.py fail on main today. Wire pytest into CI.
- gitops values.yaml agent block still carries PR-573 era env (LLM_MODEL
  claude-opus-4-6); must be aligned when the model slice lands.
- No docs-serving endpoint exists yet; the VFS slice introduces the mount and tools.
- "Best practices from tasks": open product question whether the support skill also
  inspects live project state (stuck reports, unconfigured portal) via a read-only
  health tool, or only advises from docs.
