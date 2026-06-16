# Agentic chat MVP: propose-and-confirm

This is what we build **first**. It supersedes the broad vision in `agentic-vfs-design.md` for v1. The git artifact vault, dynamic React "live canvas" templates, and undo/rollback are **backlog** (listed at the bottom), kept for later, not built now.

Scope in one line: **agentic chat + a fixed set of mutating tools that only ever produce proposals the user approves.**

## The one principle: the agent proposes, the user executes

A mutating tool call never writes. It produces a **proposal**. The proposal surfaces in the UI as a diff; the user reviews it; on accept, the **user's own browser submits the change** through the normal authenticated API.

This **inverts the delegation boundary**. We do not push the user's write authority down into the agent. The agent drafts; the user's session executes. Consequences:

- The agent **never holds write credentials or write authorization**. Its worst case is a bad proposal the user declines.
- Authorization is automatically correct: the write runs **as the user**, through the same endpoint and permission checks the manual UI already uses. There is no separate agent-side write-authz to get wrong.
- The security surface shrinks to two things that are already true for the manual path: *is the diff rendered honestly* and *is the existing endpoint's authz correct*.

## The flow

1. In chat, the host and the agent discuss a change (say, portal editor settings).
2. The agent calls a mutating tool, e.g. `proposeChange(target, edits[])`. It returns a **proposal object**, streamed to the UI as a new run-event kind (`proposal`), reusing the existing event spine (same pipe as `sendProgressUpdate` today).
3. The UI opens a **diff edit view**: each edit shown field by field, current value to proposed value.
4. Guardrail: **no more than ~5 edits per proposal** (a prompt rule plus a schema cap). Larger changes are split into successive proposals so each stays reviewable.
5. The host can **accept, decline, or edit** (adjust the proposed values before accepting).
6. On accept, the **browser submits** via the existing authenticated mutation endpoint (the same React Query hook the manual editor uses). The agent is not in the write path.
7. The outcome (applied / declined / edited-then-applied) flows back as a run-event, so the agent knows what happened and can continue the conversation.

## Honesty and concurrency

- A proposal carries the **original values it was based on**. At submit time, detect whether the underlying data changed since the proposal was made (optimistic concurrency / version check) and re-confirm rather than overwrite silently.
- The diff always shows **real current state to proposed state**, never a fabricated baseline.

## Tooling shape

- Mutating tools are a **fixed, reviewed allowlist** that mirrors existing FastAPI actions (portal/editor settings, create or schedule a report, edit a project, and so on). This allowlist **is** the boundary. There is no arbitrary script execution in v1.
- Read tools stay as they are. Mutating tools return proposals only.
- Reference pattern: CopilotKit's human-in-the-loop / render-and-wait-for-response actions match this exactly. We can adopt that primitive if we move onto CopilotKit's React layer; today's `AgenticChatPanel` can render the proposal/diff card directly from the run-event.

## It is all tool calls (some carry a frontend renderer)

There are no output "modes" or "types." Everything the agent does is a **tool call**. The only axis that matters: does a given tool have a **frontend renderer** registered for it?

- **Most tool calls render passively** - a status card (running / done), which the panel already does via `agenticToolActivity.ts`. Read tools and progress updates live here. Navigation and best-practices are not even tools: they are just links in the model's text, powered by the route map in the product-context doc.
- **Some tools declare a typed output and a rich, interactive renderer.** `proposeChange` is the first. Its output is a typed proposal; the frontend has a renderer keyed to that type which:
  1. reads the drafted change from the tool output,
  2. queries current state to build a real before -> after diff,
  3. renders the diff (accept / decline / edit, about five edits max),
  4. on accept, **submits as the user** through the normal authenticated endpoint.

Step 4 *is* the delegation inversion, and it is nothing more than what this tool's renderer is allowed to do. The agent emitted a tool call; the frontend handled it. There is no second concept.

This is exactly CopilotKit's frontend-action model (`useCopilotAction` with `render`, and `renderAndWaitForResponse` for the human-in-the-loop pause), sitting on top of the tool-activity rendering the panel already does.

Future interactive tools (a date-range picker, a chart the host tweaks, a "pick conversations" selector) plug in the same way: declare a typed output, register a renderer. The architecture is a **tool registry where some tools carry a frontend renderer** - not a taxonomy of output types.

## Context awareness (living product knowledge)

The agent has to understand the world it operates in: Echo's model (organization to workspace to project to conversation), what each surface does, and the features that are coming. Today it knows none of this.

- Maintain a **living product-context document** that is injected into the agent's system prompt (the SAM "capabilities" pattern: always loaded).
- It **will keep changing**. Treat it as a maintained, versioned doc reloaded each session, not hardcoded strings.
- Starter scaffold: `docs/dembrane-product-context.md` (its runtime home will likely be `agent/context/`). Gaps are marked TODO for the team to fill in: workspaces, organizations, and the new incoming features.

## Backlog (explicitly later, not now)

- **Undo / rollback** of an applied change.
- **Git artifact vault**: versioned, attributed reports and tools over object storage, and everything in `agentic-vfs-design.md` Layer A / A'.
- **Dynamic React "live canvas"** templates (react-runner slots) from `agentic-vfs-design.md` Layer D.

## Still on the table (cheap, independent of the above)

- Chat decoupled from a single project so "the context I have access to" naturally spans projects (design doc section 5).
- Membership-based access (the effective-scope "access engine", design doc section 6) is still the spine: it bounds **what the agent can read and propose against**.
