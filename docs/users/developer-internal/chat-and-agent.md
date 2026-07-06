---
title: Chat & the agent service
description: How standard RAG chat and agentic chat differ, the standalone LangGraph agent service on :8001, its tools, and the lease-based turn runtime in Redis.
audience: developer-internal
---

# Chat & the agent service

dembrane has two ways to "talk to your data": *standard chat* (retrieval-augmented
generation served by the main backend) and *agentic chat* (a tool-using agent that runs in a
separate service). This page explains the split, the agent service in `echo/agent/`, the tools
it exposes, and how turns are coordinated with Redis leases. For the conceptual feature view
see [chat & ask](../../features/chat-and-ask.md); for retrieval and model groups see
[the processing pipeline](./processing-pipeline.md).

## Standard chat vs agentic chat

| | Standard chat | Agentic chat |
|---|---|---|
| Where it runs | Main FastAPI backend (`:8000`) | Standalone agent service (`:8001`) |
| How it works | RAG over a selected set of conversations - retrieve, then answer | A LangGraph agent that calls *tools* to decide what to read, iterating until it can answer |
| Retrieval mode | `overview` (summaries) or `deep_dive` (transcripts) | Tool-driven: lists conversations, keyword-searches, pulls transcripts on demand |
| Toggle | Default chat mode | "Agentic mode" in the chat UI |
| State | `project_chat` + `project_chat_message` | `project_agentic_run` + `project_agentic_run_event` (plus the chat tables) |

Both are scoped to a *project* and a selection of conversations as context. The "sources" a
message cites are recorded through the `project_chat_message_conversation` join. Standard chat's
two retrieval modes - `overview` over summaries, `deep_dive` over full transcripts - are
covered in [the processing pipeline](./processing-pipeline.md#chat-retrieval-modes).

## Why the agent is a separate service

`echo/agent/` is intentionally isolated (see its `README.md`):

- It keeps agent execution *out of the frontend runtime*.
- It *avoids dependency conflicts* with `echo/server` (CopilotKit/LangGraph pull in their own stack).
- It supports *long-running execution* with a *backend-owned run lifecycle* - the agent does the thinking, but auth, persistence and notifications stay with the `echo/server` gateway.

It exposes a tiny surface:

- `GET /health`
- `POST /copilotkit/{project_id}` - the CopilotKit endpoint the run flows through.

It builds its graph in `echo/agent/agent.py` (a LangGraph `StateGraph` over `CopilotKitState`)
and reads project data via `echo/agent/echo_client.py`, which calls back into the backend. Auth
is handled in `echo/agent/auth.py`.

## The tools

The agent's graph (`create_agent_graph` in `agent.py`) binds twenty tools. The model is
nudged to get an overview first, then narrow:

- *Conversations*: `listProjectConversations` (the inventory - start here),
  `findConvosByKeywords` (keyword search; the prompt steers toward 2-4 focused keywords, with
  a guardrail against low-signal and repeated searches), `listConvoSummary`,
  `listConvoFullTranscript`, `grepConvoSnippets`.
- *Documentation*: `listDocs`, `readDoc(paths)`, `grepDocs(patterns)` (both take lists so
  lookups batch into one step), `readSkill` - the agent answers "how do I" questions from the
  published docs corpus and cites the page.
- *Project settings*: `getProjectSettings`, `proposeProjectUpdate`,
  `proposeCustomVerificationTopic` - the agent never writes settings; proposals render as
  review cards the host applies or rejects.
- *Chats*: `listProjectChats`, `readChat` - earlier chats in the project, excluding other
  members' private ones.
- *Live status*: `getLiveConversationStatus` - the same snapshot as the host Monitor page
  (shared `gather_project_monitor`).
- *Support*: `reachOutToDembrane` - writes a `support_request` outbox row; the prompt forbids
  promising follow-up and requires honest failure reporting.
- *Memory*: `readMemory`, `remember(scope, content, memory_key)` - one `agent_memory`
  collection with `workspace | project | user` scopes (user scope is the only one that may
  hold personal detail). Writes upsert on `memory_key`. Hosts view + delete (never edit)
  via `/v2/bff/memory/*` and the settings surfaces.
- *Progress*: `sendProgressUpdate` - emit a progress event so the UI can show what the agent
  is doing mid-run.

The first user message carries `Project Name`, `Workspace Context` (the host-written
`workspace.context` field), and `Project Context` as standing guidance. The graph guards
against runaway loops (counting tool calls since the last assistant update, nudging the model
to answer from gathered evidence rather than searching forever), and the prompt bans exposing
internal machinery (tool names, JSON) to the host.

## The lease-based turn runtime

Agentic runs are long and resumable, so the backend owns the lifecycle and uses *Redis leases*
to make sure a turn is processed exactly once. The runtime primitives are in
`echo/server/dembrane/agentic_runtime.py`; the worker that drives a run is
`echo/server/dembrane/agentic_worker.py` (`process_agentic_run`).

Keys are namespaced under `agentic:run:{run_id}:turn:{turn_seq}:…`:

| Helper | Key | Purpose |
|---|---|---|
| `acquire_turn_lease` / `refresh_turn_lease` / `release_turn_lease` | `…:lease` | A TTL'd lease an owner holds while processing a turn. Acquire is atomic; refresh/release use a Lua check-and-act so only the owner can extend or drop it. |
| `request_cancel` / `is_cancel_requested` / `clear_cancel` | `…:cancel` | Cooperative cancellation - the worker checks `_raise_if_cancelled` between steps and bails cleanly. |
| `publish_live_event` / `subscribe_live_events` / `read_live_event` | `agentic:run:{run_id}` channel | The live event stream over Redis pub/sub, relayed to the client over SSE. |

So a turn's life is: acquire the lease → run the LangGraph step, appending events to
`project_agentic_run_event` and publishing them live → periodically refresh the lease and check
for cancellation → on completion persist the assistant message to the chat and release the
lease. Because the lease has a TTL, a worker that dies frees the turn for another to pick up,
without double-processing.

> [!NOTE]
> The durable record (`project_agentic_run_event`) and the live pub/sub stream carry the same
> events. The DB rows let a client that reconnects rebuild history; the pub/sub stream gives a
> connected client low-latency updates. Don't rely on pub/sub alone - a missed message must be
> recoverable from the event rows.

## How a run flows

1. The dashboard opens an agentic chat; the backend creates a `project_agentic_run`.
2. A turn is enqueued; the agentic worker acquires the *turn lease* and starts driving the LangGraph.
3. The agent calls tools (`listProjectConversations`, `findConvosByKeywords`, transcript pulls), each tool result and progress update appended as a `project_agentic_run_event` and published live.
4. The worker refreshes the lease while it works and checks for cancellation between steps.
5. On finish, the assistant message is persisted to `project_chat_message` and the lease released.
6. The client renders the stream over SSE, backed by the Redis channel.

## Models

The agent runs on Gemini (its `_build_llm` constructs a `ChatGoogleGenerativeAI`; set
`GEMINI_API_KEY`). The main backend's chat goes through the LiteLLM Router groups - `TEXT_FAST`
for streaming, `MULTI_MODAL_PRO` for richer turns. See
[the processing pipeline](./processing-pipeline.md#the-llm-layer-litellm-router).

## Tiers

Built-in chat-with-analysis (the Gemini path) is *Changemaker+*. *Innovator* replaces the
built-in analysis with bring-your-own-LLM via MCP - connect ChatGPT/Claude - which is *coming
soon* (gated on MCP shipping). Free-tier chat is gated. See
[tiers & billing](../../features/tiers-and-billing.md) and
[MCP & bring-your-own-LLM](../developer-external/mcp-and-byo-llm.md).

---

*Related*

- [Architecture](./architecture.md)
- [The processing pipeline](./processing-pipeline.md)
- [The data model](./data-model.md)
- [Chat & Ask (feature)](../../features/chat-and-ask.md)
