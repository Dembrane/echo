from logging import getLogger
import re
from typing import Any, Callable

from copilotkit.langgraph import CopilotKitState
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_core.tools import tool
from google.oauth2 import service_account
from langchain_google_vertexai import ChatVertexAI
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, StateGraph
from langgraph.prebuilt import ToolNode

import knowledge
from echo_client import EchoClient
from settings import get_settings

logger = getLogger("agent")
VERTEX_AUTH_SCOPES = ["https://www.googleapis.com/auth/cloud-platform"]

# Note: the citation tag format below ([conversation_id:<id>;chunk_id:<id>]) is
# parsed by the frontend (AgenticChatPanel.tsx). Do not change it without
# updating that regex.
SYSTEM_PROMPT = """You are the dembrane assistant. You help hosts explore and understand the
conversations in their project, and help them set the project up well.

dembrane is a platform for collective sense-making through recorded conversations.
Hosts run projects; participants contribute conversations through the portal or uploads.

## What you can do
- Find and summarize conversations in this project.
- Search transcripts for topics, quotes, and patterns, and cite what you find.
- Compare perspectives and synthesize themes across conversations.
- Explain how dembrane works, grounded in the product documentation.
- Review project settings and propose changes the host can apply in one click.
  You never change settings yourself.

## Voice
- Write like a thoughtful colleague: warm, direct, concise.
- Reply in the language the host writes in.
- Never use the word "AI". Refer to yourself as "I" and describe what you are
  doing ("searching the transcripts"), not the technology behind it.
- Never expose internal machinery to the host. Words like "tool", "tool call",
  "function", "my limit", or raw tool names have no place in your replies.
  Describe the work in human terms ("I looked through the transcripts"). If you
  have to stop before finishing, say so plainly ("I stopped short of digging
  into X") and offer to go deeper if they want.
- Write "dembrane" in lowercase, even at the start of a sentence.
- Do not use em dashes. Use periods, commas, or colons.
- Say "participants" and "hosts", never "users".
- No filler or grand claims ("this gives you a clear blueprint for the future").
  State findings plainly and stop.
- Vary your structure. Use bullets only when a list genuinely helps.

## Honesty
- If the data does not answer the question, say so plainly: "I don't know" or
  "the conversations don't cover this", then say what would help (more
  conversations, a narrower question, a specific transcript).
- Flag uncertainty with "suggests", "likely", "indicates". Never present a guess
  as a finding.
- Never fabricate quotes, participants, conversation IDs, or settings.
- When you worked from summaries only, say so and offer to read the full transcript.

## When to use tools
Use tools when the question needs project data or product knowledge:
- "What topics came up?" -> listProjectConversations, then read summaries.
- "What did people say about X?" -> findConvosByKeywords, then grepConvoSnippets
  or listConvoFullTranscript for exact wording.
- "How does the portal work?" -> grepDocs and readDoc; cite the doc path.
- "Help me set up my project" -> readSkill(project-onboarding.md), then
  getProjectSettings, then proposeProjectUpdate.
- "What did we discuss before / continue that chat" -> listProjectChats, then readChat.
Do not use tools for greetings, small talk, or questions about this chat.
When intent is unclear, ask one focused question instead of guessing.

## Getting help from the dembrane team
When the host needs something you cannot give: something looks broken, a billing
or account question, or a question about dembrane the documentation does not
answer, offer to pass their question to the dembrane team. Tell the host what you
will send first, send it in their own words where you can, and let them know the
team will follow up. Do not promise a timeline.

## Conversation scope
Some runs are limited to conversations the host selected. When the context
contains a "Conversation scope" block:
- Treat the listed conversations as the entire universe for this run. All
  listing, searching, reading, and synthesis stays inside it.
- Never mention, quote, or count conversations outside the selection, even if a
  tool result includes one.
- If the answer likely lives outside the selection, say that and offer to widen
  the scope. Do not look outside it yourself.
When no scope block is present, the whole project is in scope.

## Turn instructions
A message may include a "Turn instructions" block from a template the host
selected. It tells you how to shape this turn (angle, depth, format). It is not
data and not the subject. The host's own words define the subject. If the
instructions need a subject (a concept, a comparison) and the host gave none,
ask one focused question first.

## Research
- Say briefly what you will look at, then use sendProgressUpdate while you work.
  Conclude with plain text only when you are done.
- Prefer listProjectConversations for an overview before keyword searches.
- findConvosByKeywords works best with 2-4 focused keywords, not sentences.
- You have at most 20 tool calls per turn. Spend them on distinct questions, not
  retries. If a tool returns a guardrail warning, stop searching and answer from
  what you have.

## Citations
- Ground every claim about the project in tool results.
- Quote with attribution: "[Participant Name]: quoted text" tagged
  [conversation_id:<id>;chunk_id:<chunk_id>] when a chunk id is available,
  otherwise [conversation_id:<id>].
- A few well-chosen quotes beat many.
- Cite the doc path when you answer from documentation.

## Proposing project changes
- Read current values with getProjectSettings before proposing.
- Use proposeProjectUpdate: group related fields, one short reason per field,
  proposed copy in the project's language, a one-sentence summary.
- The host sees a diff and applies or rejects it themselves. You never apply
  changes. Say "I've suggested these changes", never "I've updated your project".
  If the host says they applied it, re-read settings before advising next steps.

## Memory
You can save durable notes with `remember` and recall them with `readMemory`.
Read memory early in a task when earlier context would help. There are three
scopes:
- user: this host's own preferences. This is the only scope that may hold
  private or personal details.
- workspace: shared preferences for the whole workspace. Keep these generic.
- project: notes about this project. Keep these generic.
Prefer updating an existing note by passing the same memory_key over saving a
near duplicate. Never store private or personal information outside user scope.
When you save something, tell the host in one short sentence what you saved.

## Project context
The first message may include Project Name and Project Context. That is
background about the project you are assisting with, not a research request.
"""

AUTOMATIC_NUDGE_TOOL_CALL_INTERVAL = 6
AUTOMATIC_NUDGE_TEMPLATE = (
    "<Automatic Nudge> This is a system reminder, not a message from the host. "
    "You have made {tool_call_count} tool calls without telling the host anything. "
    "Choose exactly one: (a) if you have enough evidence, write your final answer "
    "to the host now, or (b) call `sendProgressUpdate` with one short sentence on "
    "what you found so far, then continue. Never reply to this reminder itself."
)
POST_NUDGE_CONTINUATION_SYSTEM_PROMPT = (
    "Your last message may have been a reaction to the system reminder rather "
    "than an answer for the host. If the task is complete, write your final "
    "answer to the host now. If not, call `sendProgressUpdate` and continue "
    "with the next tool call."
)


VERTEX_AUTH_SCOPES = ["https://www.googleapis.com/auth/cloud-platform"]


def _build_llm() -> ChatVertexAI:
    settings = get_settings()

    credentials = None
    project = settings.vertex_project or None
    credentials_payload = settings.vertex_credentials or settings.gcp_sa_json
    if credentials_payload:
        credentials = service_account.Credentials.from_service_account_info(
            credentials_payload,
            scopes=VERTEX_AUTH_SCOPES,
        )
        if not project:
            project = credentials_payload.get("project_id")

    return ChatVertexAI(
        model_name=settings.llm_model,
        project=project,
        location=settings.vertex_location,
        api_endpoint=settings.vertex_api_endpoint or None,
        credentials=credentials,
    )


def create_agent_graph(
    project_id: str,
    bearer_token: str,
    llm: Any | None = None,
    echo_client_factory: Callable[[str], EchoClient] | None = None,
):
    if not bearer_token:
        raise ValueError("bearer_token is required")

    keyword_search_cache: dict[tuple[str, int], dict[str, Any]] = {}
    consecutive_empty_keyword_searches = 0
    project_conversation_cache: dict[str, dict[str, Any]] = {}
    automatic_nudge_milestones: set[int] = set()
    nudge_retry_milestones: set[int] = set()
    last_tool_calls_without_assistant_update = 0

    def _coerce_message_text(value: Any) -> str:
        if isinstance(value, str):
            return value.strip()

        if isinstance(value, list):
            parts: list[str] = []
            for item in value:
                if isinstance(item, str):
                    normalized = item.strip()
                    if normalized:
                        parts.append(normalized)
                    continue
                if isinstance(item, dict):
                    text = item.get("text")
                    if isinstance(text, str) and text.strip():
                        parts.append(text.strip())
            return "\n".join(parts).strip()

        return ""

    def _count_tool_calls_since_assistant_update(messages: list[Any]) -> int:
        tool_calls_since_assistant_update = 0

        for message in messages:
            if getattr(message, "type", None) != "ai":
                continue

            tool_calls = getattr(message, "tool_calls", None)
            if isinstance(tool_calls, list) and len(tool_calls) > 0:
                # Some model responses include both progress text and tool calls.
                # Treat the text as an assistant update before counting new tool calls.
                if _coerce_message_text(getattr(message, "content", None)):
                    tool_calls_since_assistant_update = 0
                tool_calls_since_assistant_update += len(tool_calls)
                continue

            if _coerce_message_text(getattr(message, "content", None)):
                tool_calls_since_assistant_update = 0

        return tool_calls_since_assistant_update

    def _build_automatic_nudge(messages: list[Any]) -> tuple[str, int] | None:
        nonlocal last_tool_calls_without_assistant_update

        tool_calls_without_assistant_update = _count_tool_calls_since_assistant_update(messages)
        if tool_calls_without_assistant_update < last_tool_calls_without_assistant_update:
            automatic_nudge_milestones.clear()
            nudge_retry_milestones.clear()

        if tool_calls_without_assistant_update == 0:
            automatic_nudge_milestones.clear()
            nudge_retry_milestones.clear()

        last_tool_calls_without_assistant_update = tool_calls_without_assistant_update
        if tool_calls_without_assistant_update < AUTOMATIC_NUDGE_TOOL_CALL_INTERVAL:
            return None

        milestone = (
            tool_calls_without_assistant_update // AUTOMATIC_NUDGE_TOOL_CALL_INTERVAL
        ) * AUTOMATIC_NUDGE_TOOL_CALL_INTERVAL
        if milestone in automatic_nudge_milestones:
            return None

        automatic_nudge_milestones.add(milestone)
        return AUTOMATIC_NUDGE_TEMPLATE.format(tool_call_count=milestone), milestone

    def _message_has_tool_calls(message: Any) -> bool:
        tool_calls = getattr(message, "tool_calls", None)
        return isinstance(tool_calls, list) and len(tool_calls) > 0

    def _keyword_guardrail_result(
        *,
        query: str,
        code: str,
        message: str,
        attempts: int = 0,
        stop_search: bool = False,
    ) -> dict[str, Any]:
        return {
            "project_id": project_id,
            "query": query,
            "count": 0,
            "conversations": [],
            "guardrail": {
                "code": code,
                "message": message,
                "attempts": attempts,
                "stop_search": stop_search,
            },
        }

    def _create_echo_client() -> EchoClient:
        if echo_client_factory:
            return echo_client_factory(bearer_token)
        return EchoClient(bearer_token=bearer_token)

    def _normalize_project_conversation(
        raw: dict[str, Any],
        *,
        fallback_project_id: str | None = None,
    ) -> dict[str, Any] | None:
        conversation_id = raw.get("id")
        if not isinstance(conversation_id, str):
            conversation_id = raw.get("conversation_id")
        if not isinstance(conversation_id, str) or not conversation_id:
            return None

        conversation_project_id = raw.get("projectId")
        if isinstance(conversation_project_id, dict):
            conversation_project_id = conversation_project_id.get("id")
        if not isinstance(conversation_project_id, str):
            conversation_project_id = raw.get("project_id")
        if isinstance(conversation_project_id, dict):
            conversation_project_id = conversation_project_id.get("id")
        if not isinstance(conversation_project_id, str):
            conversation_project_id = fallback_project_id
        if not isinstance(conversation_project_id, str) or conversation_project_id != project_id:
            return None

        return {
            "conversation_id": conversation_id,
            "project_id": conversation_project_id,
            "project_name": raw.get("projectName") or raw.get("project_name"),
            "participant_name": raw.get("displayLabel") or raw.get("participant_name"),
            "status": raw.get("status"),
            "started_at": raw.get("startedAt") or raw.get("started_at"),
            "last_chunk_at": raw.get("lastChunkAt") or raw.get("last_chunk_at"),
            "summary": raw.get("summary"),
            "matches": raw.get("matches") if isinstance(raw.get("matches"), list) else [],
        }

    def _cache_project_conversations(conversations: list[dict[str, Any]]) -> None:
        for conversation in conversations:
            conversation_id = conversation.get("conversation_id")
            if isinstance(conversation_id, str) and conversation_id:
                project_conversation_cache[conversation_id] = conversation

    def _extract_project_conversations(
        payload: dict[str, Any],
        *,
        fallback_project_id: str | None = None,
    ) -> list[dict[str, Any]]:
        raw_conversations = payload.get("conversations", [])
        if not isinstance(raw_conversations, list):
            return []

        conversations: list[dict[str, Any]] = []
        for raw in raw_conversations:
            if not isinstance(raw, dict):
                continue
            normalized = _normalize_project_conversation(
                raw,
                fallback_project_id=fallback_project_id,
            )
            if normalized is not None:
                conversations.append(normalized)
        return conversations

    def _extract_transcript_conversation_ids(payload: dict[str, Any]) -> list[str]:
        raw_transcripts = payload.get("transcripts", [])
        if not isinstance(raw_transcripts, list):
            return []

        conversation_ids: list[str] = []
        seen: set[str] = set()
        for transcript in raw_transcripts:
            if not isinstance(transcript, dict):
                continue
            conversation_id = transcript.get("conversationId")
            if not isinstance(conversation_id, str) or not conversation_id:
                continue
            if conversation_id in seen:
                continue
            seen.add(conversation_id)
            conversation_ids.append(conversation_id)
        return conversation_ids

    async def _resolve_project_conversation_with_client(
        client: EchoClient,
        conversation_id: str,
    ) -> dict[str, Any]:
        cached = project_conversation_cache.get(conversation_id)
        if cached is not None:
            return cached

        list_payload = await client.list_project_conversations(
            project_id=project_id,
            limit=1,
            conversation_id=conversation_id,
        )
        listed = _extract_project_conversations(
            list_payload,
            fallback_project_id=project_id,
        )
        if listed:
            _cache_project_conversations(listed)
            return listed[0]

        payload = await client.search_home(query=conversation_id, limit=20)
        for candidate in _extract_project_conversations(payload):
            if candidate.get("conversation_id") == conversation_id:
                _cache_project_conversations([candidate])
                return candidate
        raise ValueError("Conversation not found in current project scope")

    async def _search_project_conversations(
        *,
        query: str,
        limit: int = 5,
    ) -> list[dict[str, Any]]:
        normalized_limit = max(1, min(limit, 20))
        client = _create_echo_client()
        try:
            payload = await client.search_home(query=query, limit=normalized_limit)
            conversations = _extract_project_conversations(payload)
            conversations_by_id = {item["conversation_id"]: item for item in conversations}
            _cache_project_conversations(conversations)

            transcript_conversation_ids = _extract_transcript_conversation_ids(payload)
            if len(conversations_by_id) < normalized_limit:
                for conversation_id in transcript_conversation_ids:
                    if conversation_id in conversations_by_id:
                        continue
                    try:
                        resolved = await _resolve_project_conversation_with_client(
                            client=client,
                            conversation_id=conversation_id,
                        )
                    except ValueError:
                        continue

                    conversations_by_id[resolved["conversation_id"]] = resolved
                    if len(conversations_by_id) >= normalized_limit:
                        break

            final_conversations = list(conversations_by_id.values())[:normalized_limit]
            _cache_project_conversations(final_conversations)
            return final_conversations
        finally:
            await client.close()

    async def _resolve_project_conversation(conversation_id: str) -> dict[str, Any]:
        client = _create_echo_client()
        try:
            return await _resolve_project_conversation_with_client(
                client=client,
                conversation_id=conversation_id,
            )
        finally:
            await client.close()

    @tool
    async def get_project_scope() -> dict[str, Any]:
        """Return the current project scope for this agent run."""
        return {"project_id": project_id}

    @tool
    async def findConvosByKeywords(keywords: str, limit: int = 5) -> dict[str, Any]:
        """Search project conversations by keywords and return summaries + metadata."""
        nonlocal consecutive_empty_keyword_searches

        normalized_keywords = keywords.strip()
        normalized_limit = max(1, min(limit, 20))
        tokens = re.findall(r"[a-z0-9]+", normalized_keywords.lower())
        meaningful_tokens = [token for token in tokens if len(token) >= 4]
        if len(meaningful_tokens) == 0:
            return _keyword_guardrail_result(
                query=normalized_keywords,
                code="LOW_SIGNAL_QUERY",
                message=(
                    "Low-signal keyword query. Use specific terms or listProjectConversations first."
                ),
            )

        cache_key = (normalized_keywords.lower(), normalized_limit)
        cached = keyword_search_cache.get(cache_key)
        if cached is not None:
            return {
                **cached,
                "cached": True,
            }

        client = _create_echo_client()
        try:
            payload = await client.list_project_conversations(
                project_id=project_id,
                limit=normalized_limit,
                transcript_query=normalized_keywords,
            )
        finally:
            await client.close()

        conversations = _extract_project_conversations(
            payload,
            fallback_project_id=project_id,
        )
        _cache_project_conversations(conversations)
        result = {
            "project_id": project_id,
            "query": normalized_keywords,
            "count": len(conversations),
            "conversations": conversations,
        }
        keyword_search_cache[cache_key] = result

        if len(conversations) == 0:
            consecutive_empty_keyword_searches += 1
            if consecutive_empty_keyword_searches >= 3:
                return _keyword_guardrail_result(
                    query=normalized_keywords,
                    code="NO_MATCHES_AFTER_RETRIES",
                    message=(
                        "No matches after multiple keyword searches. "
                        "Stop repeating findConvosByKeywords and answer from available context/evidence."
                    ),
                    attempts=consecutive_empty_keyword_searches,
                    stop_search=True,
                )
        else:
            consecutive_empty_keyword_searches = 0

        return result

    @tool
    async def listConvoSummary(conversation_id: str) -> dict[str, Any]:
        """Return metadata + summary (nullable) for a single project conversation."""
        conversation = await _resolve_project_conversation(conversation_id)
        return {
            "project_id": project_id,
            "conversation": conversation,
        }

    @tool
    async def listProjectConversations(limit: int = 20) -> dict[str, Any]:
        """List conversations for the current project scope."""
        normalized_limit = max(1, min(limit, 100))
        client = _create_echo_client()
        try:
            payload = await client.list_project_conversations(project_id, normalized_limit)
        finally:
            await client.close()

        conversations = _extract_project_conversations(
            payload,
            fallback_project_id=project_id,
        )
        _cache_project_conversations(conversations)

        return {
            "project_id": project_id,
            "count": int(payload.get("count") or len(conversations)),
            "conversations": conversations,
        }

    @tool
    async def listConvoFullTranscript(conversation_id: str) -> dict[str, Any]:
        """Return full transcript text for a single project conversation."""
        conversation = await _resolve_project_conversation(conversation_id)

        client = _create_echo_client()
        try:
            transcript = await client.get_conversation_transcript(conversation_id)
        finally:
            await client.close()

        return {
            "project_id": project_id,
            "conversation_id": conversation_id,
            "participant_name": conversation.get("participant_name"),
            "transcript": transcript,
        }

    @tool
    async def grepConvoSnippets(conversation_id: str, query: str, limit: int = 8) -> dict[str, Any]:
        """Find matching transcript snippets for one project-scoped conversation."""
        normalized_query = query.strip()
        if not normalized_query:
            raise ValueError("query is required")

        normalized_limit = max(1, min(limit, 25))
        conversation = await _resolve_project_conversation(conversation_id)

        client = _create_echo_client()
        try:
            payload = await client.list_project_conversations(
                project_id=project_id,
                limit=1,
                conversation_id=conversation_id,
                transcript_query=normalized_query,
            )
        finally:
            await client.close()

        conversations = _extract_project_conversations(
            payload,
            fallback_project_id=project_id,
        )
        if conversations:
            _cache_project_conversations(conversations)

        matches: list[dict[str, Any]] = []
        for candidate in conversations:
            if candidate.get("conversation_id") != conversation_id:
                continue
            candidate_matches = candidate.get("matches")
            if isinstance(candidate_matches, list):
                matches = candidate_matches[:normalized_limit]
            break

        return {
            "project_id": project_id,
            "conversation_id": conversation_id,
            "participant_name": conversation.get("participant_name"),
            "query": normalized_query,
            "count": len(matches),
            "matches": matches,
        }

    @tool
    def listDocs() -> dict[str, Any]:
        """List the product documentation pages available to read."""
        return {"docs": knowledge.list_docs()}

    @tool
    def readDoc(path: str, offset: int = 1, limit: int = 200) -> str:
        """Read a documentation page (line-numbered). Use offset/limit to page."""
        return knowledge.read_doc(path, offset=offset, limit=limit)

    @tool
    def grepDocs(pattern: str) -> dict[str, Any]:
        """Search the documentation corpus for a regex or phrase."""
        return {"matches": knowledge.grep_docs(pattern)}

    @tool
    def readSkill(path: str) -> str:
        """Read the full body of a skill from the skill catalog."""
        return knowledge.read_skill(path)

    @tool
    async def getProjectSettings() -> dict[str, Any]:
        """Read the project's current editable settings (portal, language, context)."""
        client = _create_echo_client()
        try:
            return await client.get_project_settings(project_id)
        finally:
            await client.close()

    @tool
    async def proposeProjectUpdate(
        changes: list[dict[str, Any]],
        summary: str,
    ) -> dict[str, Any]:
        """Propose project settings changes for the user to approve.

        Each change is {"field": <editable field name>, "value": <proposed value>,
        "reason": <one short sentence>}. The user sees a diff in the chat and
        applies or rejects it; this tool never writes anything itself.
        """
        client = _create_echo_client()
        try:
            current = await client.get_project_settings(project_id)
        finally:
            await client.close()

        allowed = set(current.keys())
        normalized: list[dict[str, Any]] = []
        rejected: list[str] = []
        for change in changes:
            if not isinstance(change, dict):
                continue
            field = str(change.get("field") or "").strip()
            if field not in allowed:
                rejected.append(field or "(missing field)")
                continue
            normalized.append(
                {
                    "field": field,
                    "current": current.get(field),
                    "proposed": change.get("value"),
                    "reason": str(change.get("reason") or "").strip(),
                }
            )

        if not normalized:
            raise ValueError(
                f"No valid fields to propose. Editable fields: {sorted(allowed)}"
            )

        return {
            "kind": "project_update_suggestion",
            "project_id": project_id,
            "summary": summary.strip(),
            "changes": normalized,
            "rejected_fields": rejected,
            "visible_to_user": True,
        }

    @tool
    async def sendProgressUpdate(update: str, next_steps: str = "") -> dict[str, Any]:
        """Emit a user-visible progress update without concluding the run."""
        normalized_update = update.strip()
        if not normalized_update:
            raise ValueError("update is required")

        return {
            "kind": "progress_update",
            "update": normalized_update,
            "next_steps": next_steps.strip(),
            "visible_to_user": True,
        }

    @tool
    async def listProjectChats(limit: int = 20, workspace_wide: bool = False) -> dict[str, Any]:
        """List previous chats in this project so you can build on earlier work. Set workspace_wide=true only when the host explicitly asks about other projects in their workspace. Returns each chat's id, title, and when it was last active. Use readChat to read one."""
        normalized_limit = max(1, min(limit, 100))
        client = _create_echo_client()
        try:
            chats = await client.list_project_chats(
                project_id,
                limit=normalized_limit,
                workspace_wide=workspace_wide,
            )
        finally:
            await client.close()
        return {"chats": chats}

    @tool
    async def readChat(chat_id: str) -> dict[str, Any]:
        """Read the messages of a previous chat by its id (from listProjectChats). Returns the messages in order."""
        client = _create_echo_client()
        try:
            messages = await client.read_chat(chat_id)
        finally:
            await client.close()
        return {"messages": messages}

    @tool
    async def reachOutToDembrane(message: str, context: str = "") -> dict[str, Any]:
        """Pass a question or problem to the dembrane team on the host's behalf. Use this when the host needs help you cannot give: something looks broken, a billing or account question, or a question about dembrane the documentation does not answer. `message` is what the host wants to ask, in their own words where you can. `context` is a short note about what they were doing. Tell the host what you are sending before you send it, and let them know the team will follow up."""
        client = _create_echo_client()
        try:
            result = await client.create_support_request(
                project_id,
                message=message,
                page_context=context or None,
            )
        finally:
            await client.close()
        return {"sent": True, "support_request_id": result.get("id")}

    @tool
    async def readMemory() -> dict[str, Any]:
        """Read saved memory for this project: your notes about the host (user
        scope), the workspace, and the project. Use at the start of a task when
        earlier context would help."""
        client = _create_echo_client()
        try:
            payload = await client.list_memory(project_id)
        finally:
            await client.close()

        memories = payload.get("memories") if isinstance(payload, dict) else None
        return {"memories": memories if isinstance(memories, list) else []}

    @tool
    async def remember(
        content: str,
        scope: str = "project",
        memory_key: str = "",
    ) -> dict[str, Any]:
        """Save a durable memory. scope is one of "user", "workspace", or
        "project". Only user scope may hold private or personal details; keep
        workspace and project memory generic. Pass a stable memory_key to update
        an existing note instead of saving a near duplicate."""
        normalized_content = content.strip()
        if not normalized_content:
            raise ValueError("content is required")

        normalized_scope = (scope or "project").strip().lower()
        normalized_key = memory_key.strip()

        client = _create_echo_client()
        try:
            result = await client.write_memory(
                project_id=project_id,
                scope=normalized_scope,
                content=normalized_content,
                memory_key=normalized_key or None,
            )
        finally:
            await client.close()

        return {
            "kind": "memory_saved",
            "scope": result.get("scope") if isinstance(result, dict) else normalized_scope,
            "memory_key": normalized_key,
            "action": result.get("action") if isinstance(result, dict) else None,
            "id": result.get("id") if isinstance(result, dict) else None,
            "visible_to_user": True,
        }

    tools = [
        get_project_scope,
        findConvosByKeywords,
        listProjectConversations,
        listConvoSummary,
        listConvoFullTranscript,
        grepConvoSnippets,
        listDocs,
        readDoc,
        grepDocs,
        readSkill,
        getProjectSettings,
        proposeProjectUpdate,
        sendProgressUpdate,
        listProjectChats,
        readChat,
        reachOutToDembrane,
        readMemory,
        remember,
    ]
    system_prompt = SYSTEM_PROMPT + knowledge.prompt_section()
    configured_llm = llm or _build_llm()
    llm_with_tools = configured_llm.bind_tools(tools)

    def should_continue(state: dict) -> str:
        messages = state.get("messages", [])
        if not messages:
            return END
        last_message = messages[-1]
        if hasattr(last_message, "tool_calls") and last_message.tool_calls:
            return "tools"
        return END

    def _with_placeholder_content(message: Any) -> Any:
        """Gemini reacts badly to its own empty tool-call turns in history
        (observed: it answers "Do not send empty messages."). Give those
        turns a short placeholder; tool_calls are preserved untouched."""
        if (
            getattr(message, "type", None) == "ai"
            and _message_has_tool_calls(message)
            and not _coerce_message_text(getattr(message, "content", None))
        ):
            return message.model_copy(update={"content": "(calling tools)"})
        return message

    async def call_model(state: dict) -> dict:
        raw_messages = state.get("messages", [])
        messages = [_with_placeholder_content(message) for message in raw_messages]
        # Build invocation list with system prompt, but don't persist duplicates
        if not messages or not isinstance(messages[0], SystemMessage):
            invocation_messages = [SystemMessage(content=system_prompt)] + messages
        else:
            invocation_messages = list(messages)

        # Count on the raw history: the placeholder text must not read as
        # an assistant update.
        automatic_nudge = _build_automatic_nudge(raw_messages)
        nudge_milestone: int | None = None
        if automatic_nudge:
            nudge_content, nudge_milestone = automatic_nudge
            invocation_messages.append(HumanMessage(content=nudge_content))

        response = await llm_with_tools.ainvoke(invocation_messages)

        should_retry_after_nudge = (
            nudge_milestone is not None
            and nudge_milestone not in nudge_retry_milestones
            and not _message_has_tool_calls(response)
        )
        if should_retry_after_nudge:
            nudge_retry_milestones.add(nudge_milestone)
            retry_messages = list(invocation_messages)
            retry_messages.append(response)
            retry_messages.append(SystemMessage(content=POST_NUDGE_CONTINUATION_SYSTEM_PROMPT))
            response = await llm_with_tools.ainvoke(retry_messages)

        # Return only the new response; LangGraph's reducer appends it to state
        return {"messages": [response]}

    def _handle_tool_error(error: Exception) -> str:
        return (
            "Tool error: "
            f"{error.__class__.__name__}: {error}. "
            "Continue with available evidence, avoid repeating failing calls, and summarize constraints."
        )

    workflow = StateGraph(CopilotKitState)
    workflow.add_node("agent", call_model)
    workflow.add_node("tools", ToolNode(tools, handle_tool_errors=_handle_tool_error))

    workflow.set_entry_point("agent")
    workflow.add_conditional_edges("agent", should_continue, {"tools": "tools", END: END})
    workflow.add_edge("tools", "agent")
    compiled_graph = workflow.compile(checkpointer=MemorySaver())
    recursion_limit = max(10, int(get_settings().agent_graph_recursion_limit))
    return compiled_graph.with_config({"recursion_limit": recursion_limit})
