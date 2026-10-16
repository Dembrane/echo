---
title: Chat and the assistant
description: How plain chat and the assistant work in code. The chats and agentic packages, where a reply and a turn run, the assistant's tools and limits, and the files to read.
audience: developer-internal
---

# Chat and the assistant

"Ask" in the dashboard has two code paths. Plain chat is the `chats` namespace: the API streams a reply over the full transcripts of the conversations a host attached. The assistant is the `agentic` namespace: a tool-using loop that runs inside the worker as a package. There is no separate agent service.

For what a host sees, read [chat and Ask](../../features/chat-and-ask.md).

## The two paths

| | Plain chat | The assistant |
|---|---|---|
| Name in the dashboard | "Specific Details" | "Agentic" (Beta) |
| `project_chat.chat_mode` | `deep_dive` | `agentic` |
| Package | `packages/chats` | `packages/agentic` |
| Where the model runs | In the API, inside the request | In the worker, as a durable workflow |
| What the model reads | The full transcripts of the attached conversations | What it fetches with tools |
| State | `project_chat`, `project_chat_message` | The chat tables, plus `project_agentic_run` and `project_agentic_run_event` |
| Survives a closed page | No. The open page saves the reply when it finishes. | Yes. The turn runs on the server. |

A third mode, `overview`, is still stored on older chats. Those chats still open, and nothing creates a new one. A chat's mode is set once and cannot be changed. New chats start as "Specific Details", and a host opts in to the assistant from the Ask screen.

Both paths need the `chat:use` policy on the project. See [roles and policies in code](./roles-and-policies.md). On the free tier both allow one chat per workspace and three questions per chat.

## Plain chat

- The reply is `POST /api/chats/:chat_id`, in `packages/chats/src/reply.ts`. It streams text. An `agentic` chat is refused there.
- The model receives the full transcripts of the attached conversations, their approved verification artefacts, and the project's name, language, context and key terms. There is no retrieval step and no automatic selection of conversations.
- The context budget is 80% of 1,048,576 tokens, shared by all attached conversations (`MAX_CHAT_CONTEXT_LENGTH` in `packages/chats/src/tokens.ts`). A conversation that does not fit is skipped.
- The host's message is stored first and removed again when the reply fails. The reply itself is written by the dashboard through the chat BFF (`/api/v2/bff/chat-messages`) when the stream ends.
- Replies run on the `multi_modal_pro` model group. Chat titles and follow-up suggestions run on `multi_modal_fast`.
- One reply may take 300 seconds.
- The free tier limits are in `packages/chats/src/tiers.ts`.

## The assistant

### How a turn runs

1. The dashboard creates a run with `POST /api/agentic/runs`, or adds a message with `POST /api/agentic/runs/:run_id/messages`. These routes only write the host's side.
2. The dashboard opens `POST /api/agentic/runs/:run_id/stream`. For a queued run that enqueues the `agentic.turn` job. At most one job per run and turn is queued or running, so two tabs or a reconnect start the turn once.
3. The worker turns the job into a durable workflow. Each model step is checkpointed, so a turn whose worker dies is resumed elsewhere at its first unfinished step.
4. The turn appends events to `project_agentic_run_event` and publishes them. The stream route reads them back as server-sent events, so a page that reconnects continues from its last sequence number.
5. `POST /api/agentic/runs/:run_id/stop` stops a run.

Only the person who started a run may follow, continue or stop it.

When a run ends and nobody has the chat open, the person who asked gets an in-app notification.

### The loop

- The agent is built on the AI SDK's `streamText`, in `packages/agentic/src/agent/agent.ts`.
- It runs on the model group named by `AGENTIC_MODEL_GROUP`, which defaults to `multi_modal_pro`.
- One turn may run 600 seconds (`AGENTIC_RUN_TIMEOUT_SECONDS`). A worker runs 8 turns at once (`AGENTIC_TURN_CONCURRENCY`).
- Safety caps: 150 tool calls per turn and 1,500 per run. The plan and progress tools do not count. The agent's own repetition guard normally ends a runaway turn first.
- Selected conversations are a focus, not a preload. The assistant reads what it needs with tools, so the context budget of plain chat does not apply.
- The first message of a run carries the project name, the workspace's "Assistant context", the project context and the project goal.

### The tools

There are 46 tools in release 3.1.0, and 37 when canvases are off for the project. They are defined in `packages/agentic/src/agent/tools.ts`, which is the list to trust.

| Group | Examples | What they do |
|---|---|---|
| Conversations | `listProjectConversations`, `findConversationsByKeywords`, `listConversationFullTranscript`, `grepConversationSnippets`, `getLiveConversationStatus` | List, search and read conversations, summaries and transcripts. Check live recordings. |
| Documentation and skills | `listDocs`, `readDoc`, `grepDocs`, `readSkill` | Read the product documentation and the assistant's own skill files. |
| Project | `getProjectSettings`, `getProjectTags`, `getPortalLink`, `listReports`, `readReport`, `readGoal`, `readChat` | Read settings, tags, the portal link, reports, the project goal and earlier chats. |
| Proposals | `proposeProjectUpdate`, `proposeTagsUpdate`, `proposeCustomVerificationTopic`, `proposeGoal`, `navigateTo` | Show a card the host accepts or dismisses. `navigateTo` shows a shortcut to a page. |
| Progress | `ack`, `updatePlan`, `sendProgressUpdate` | The plan and the progress messages. A plan has at most six steps. |
| Memory | `readMemory`, `remember`, `amendMemory`, `forgetMemory` | Read and keep notes across chats. |
| dembrane team | `reachOutToDembraneSupport`, `noteInsight` | Log a support request, or draft a note for the dembrane team. |
| Canvas | `proposeCanvas`, `editCanvas`, `pauseCanvasLoop` | Propose, read and change canvases. Only when canvases are on for the project. |

Rules that hold for every tool:

- A tool acts with the rights of the person chatting. `packages/agentic/src/agent/data.ts` runs the same service operation as the matching `/api/agentic` route, in process, with the caller's identity.
- Project settings, tags, verification prompts, the project goal and a new canvas change only through a card the host accepts. Accepting a settings card needs `project:update`.
- Applied without a card: the assistant's own memory notes, edits to an existing canvas, and a support request.
- The assistant has no tool that generates a report, starts a map or changes a presentation.
- Older tool names still work as aliases (`TOOL_NAME_RENAMES`).

### Memory

Memory notes live in `agent_memory`, in three scopes: user, project and workspace. The assistant writes them with its memory tools. In the dashboard a host can remove a note and cannot add or edit one. Each chat is given the 12 newest notes, up to 3,000 characters.

### Documentation and skills

`packages/agentic/src/agent/knowledge.ts` gives the assistant two read-only sources.

- Skill files, in `packages/agentic/skills`. They ship in the worker image and the worker checks for them at boot.
- The product documentation. Run from source, the docs tools read the repository's `docs/` folder. The corpus is optional: without one the tools answer "No documentation corpus is available in this environment." and the prompt leaves out the docs guidance.

## Where to read

| File | What it holds |
|---|---|
| `packages/chats/src/reply.ts`, `prompt.ts`, `service.ts` | The plain reply, its prompt, and adding conversations to a chat. |
| `packages/agentic/src/runs/routes.ts`, `service.ts` | The run routes. |
| `packages/agentic/src/jobs.ts` | The `agentic.turn` job and the worker registration. |
| `packages/agentic/src/runs/turn.ts` | One turn: what is stored, what is streamed, when it stops. |
| `packages/agentic/src/agent/` | The loop, the tools, the prompt, the guard. |
| `packages/agentic/src/data/` | What the tools read and write. |

## Related

- [Chat and Ask](../../features/chat-and-ask.md)
- [Background jobs and schedules](./background-jobs-and-scheduler.md)
- [The data model](./data-model.md)
- [Roles and policies in code](./roles-and-policies.md)
- [MCP and agent access](../developer-external/mcp-and-byo-llm.md)
- [Configuration and language model providers](../developer-external/configuration-and-llm-providers.md)
