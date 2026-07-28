# Brief: Wave 5 (server+agent) - goal revisions, methodology MVP, interview skill

The canvas v1 is proven live (read wave4-REPORT.md). This wave is Track C of
`echo/docs/plans/smart-loop.md`: D8 (interview skill), D9 (goal = versioned context),
D11 (methodology MVP). Read those three decisions plus D17, the story
(docs/building/smart-loop.md, "The evening before" and "The day after" beats), and
phase0-REPORT.md (schema procedure you must repeat).

HARD CONTRACT (parallel frontend track builds against this):

1. Schema (same procedure as phase 0: idempotent script in echo/directus/migrations/,
   run against localhost:8055, sync.sh pull, revert operations.json _syncId noise):
   - `project_goal_revision` {id uuid pk, project_id m2o, content text, set_by varchar
     ('host-edit'|'interview'|'loop'), chat_id varchar null, created_by varchar (directus
     user id), created_at date-created}.
   - `methodology` {id uuid pk, name varchar, description text, framing text ("what this
     does for your project", user-facing), owner_directus_user_id varchar null,
     workspace_id m2o null, visibility varchar default 'private'
     ('private'|'workspace'|'public'), is_seeded bool default false, created_at,
     updated_at}.
   - `methodology_version` {id uuid pk, methodology_id m2o, content json (see seed),
     note varchar null, created_by varchar null, created_at}.
   - `project.methodology_version_id` m2o -> methodology_version, nullable.
   - SEED (in the migration script, idempotent): the "dembrane" methodology,
     visibility 'public', is_seeded true, one version whose content json is
     {opening_move: "interview the host toward a goal", description: <2-3 sentences:
     figure out what this project is for; shape reports and canvases around it>}.
2. BFF (`echo/server/dembrane/api/v2/bff/` - new goals.py or fold into an existing
   sensible module; mount in v2/__init__):
   - `GET /v2/bff/projects/{id}/goal` (project:read) -> {current: revision|null,
     revisions: newest-first [{id, content, set_by, created_at}]}.
   - `POST /v2/bff/projects/{id}/goal` (project:update) {content, chat_id?} ->
     creates a revision with set_by='host-edit' (the chat apply flow also uses this).
   - `GET /v2/bff/methodologies?workspace_id=` (workspace member) -> seeded public +
     workspace-visible + own, [{id, name, description, framing, is_seeded,
     latest_version: {id, note, created_at}}].
   - Project selection: extend the existing ProjectUpdate whitelist (bff/tags.py
     project_router) with methodology_version_id.
3. Goal reaches the model: `_build_initial_agent_prompt_content` in api/agentic.py
   gains a `Project Goal:` line (after Project Context; "(none)" default - mirror the
   workspace-context change exactly, update the prompt tests), and the canvas gather
   bundle (canvas/gather.py) includes current goal content so ticks honor it.
4. Agent (echo/agent):
   - Interview skill file `echo/agent/skills/interviewing.md` (readSkill already
     serves this dir): the ONE interviewing muscle for (a) goal-setting and (b)
     feature-gap capture. Convergent options (2-4 concrete choices per question), <=5
     questions, confirm-understanding close, always escapable, consent-first for
     anything sent to the team. dembrane voice, no em dashes, never "AI".
   - Tools: `readGoal()` (GET via a new agentic endpoint mirroring the memory
     endpoints' auth), `proposeGoal(content)` - PURE proposal return {type:
     'goal_proposal', content} (host applies via the bff POST; docstring: propose
     after interviewing, restate the goal in the host's words),
     `listMethodologies()` (agentic endpoint mirroring the bff list).
   - System prompt: "## Project setup" section - when the first message signals setup
     or the project has no goal, offer the short interview (read the interviewing
     skill first), offer existing methodologies when any exist, always escapable
     ("you can skip this and come back any time, or read the docs"). Also: after a
     substantial artifact/report, you MAY suggest extracting a methodology - never
     automatic, one gentle line.
5. QA: unit tests per endpoint + tools (established styles); whole-tree ruff; agent
   pytest; server tests/api tests/agentic (known 4 pre-existing failures); live curl:
   goal round-trip (POST then GET shows revision history), methodologies list shows
   the seeded dembrane row, prompt content includes the Goal line (unit test fine).
   Schema: sync.sh diff clean after pull.

Constraints: touch ONLY echo/server, echo/agent, echo/directus. No git write
commands. Report -> echo/docs/plans/smart-loop-briefs/wave5-server-REPORT.md
(include what the frontend track must know).
