# Echo Agent Service

Isolated CopilotKit/LangGraph runtime for Agentic Chat.

## Why This Service Exists

- Keeps agent execution out of the frontend runtime.
- Avoids dependency conflicts with `echo/server`.
- Supports long-running execution and backend-owned run lifecycle.

## Local Run

```bash
cd echo/agent
cp .env.sample .env
# set GEMINI_API_KEY in .env
uv sync
uv run uvicorn main:app --host 0.0.0.0 --port 8001 --reload
```

## Docker Run

```bash
cd echo/agent
docker build -t echo-agent:local .
docker run --rm -p 8001:8001 --env-file .env echo-agent:local
```

## Endpoints

- `GET /health`
- `POST /copilotkit/{project_id}`

## Tool taxonomy

Tools defined in `agent.py` fall into three buckets:

- **UI tools** render a card in the chat timeline. The `UI_TOOLS` frozenset in
  `agent.py` is the source of truth: `navigateTo`, `proposeCanvas`,
  `proposeGoal`, `proposeProjectUpdate`, `noteInsight`, `sendProgressUpdate`.
  Each of these also carries a "renders a card in the chat UI" docstring line.
- **Read tools** fetch project data or product knowledge for the model only:
  `findConversationsByKeywords`, `listConversationSummary`,
  `listConversationFullTranscript`, `grepConversationSnippets`,
  `listProjectConversations`, `getProjectSettings`, `getProjectTags`,
  `getPortalLink`, `listDocs`, `readDoc`, `grepDocs`, `readSkill`,
  `listProjectChats`, `readChat`, `getLiveConversationStatus`, `readMemory`,
  `readGoal`, `listMethodologies`, `listCanvases`, `get_project_scope`.
- **Write tools** change durable state: `editProjectTags`, `editCanvas`,
  `addToCanvas`, `removeFromCanvas`, `pauseCanvasLoop`, `resumeCanvasLoop`,
  `stopCanvasLoop`, `remember`, `reachOutToDembraneSupport`, `noteInsight`
  (which is also a UI tool).

### Renamed tools (wave 32)

Some tools were renamed for host-visible clarity. Persisted run histories still
carry the OLD names, so `TOOL_NAME_RENAMES` in `agent.py` normalizes old -> new
at the history-replay boundary (Vertex 400s on an unknown function name). The
old names are never registered as visible tools.

| old | new |
| --- | --- |
| `findConvosByKeywords` | `findConversationsByKeywords` |
| `listConvoSummary` | `listConversationSummary` |
| `listConvoFullTranscript` | `listConversationFullTranscript` |
| `grepConvoSnippets` | `grepConversationSnippets` |
| `reachOutToDembrane` | `reachOutToDembraneSupport` |
| `recordInsight` | `noteInsight` |

## Notes

- This service is intentionally scoped to one purpose: agentic chat execution.
- Auth, persistence, and notifications should be owned by `echo/server` gateway routes.
