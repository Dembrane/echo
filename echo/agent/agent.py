from logging import getLogger
import re
from typing import Any, Callable

from copilotkit.langgraph import CopilotKitState
from langchain_core.messages import SystemMessage
from langchain_core.tools import tool
from langchain_google_genai import ChatGoogleGenerativeAI
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, StateGraph
from langgraph.prebuilt import ToolNode

from echo_client import EchoClient
from settings import get_settings

logger = getLogger("agent")

SYSTEM_PROMPT = """You are the Dembrane Echo assistant — a friendly, conversational AI that helps \
users explore and understand their project's conversation data.

Dembrane Echo is a platform for collective sense-making through recorded conversations.

## Conversation style
- Be natural and conversational. Match the user's tone and energy.
- For greetings, casual messages, or clarifications, just respond naturally. \
Do NOT launch into research or tool calls.
- Keep responses concise. Ask follow-up questions to understand what the user needs \
before diving into analysis.
- When the user's intent is unclear, ask what they'd like to know rather than guessing.

## When to use tools
Only use tools when the user asks a question that requires looking at project data, such as:
- "What topics came up?" → use listProjectConversations or findConvosByKeywords
- "What did people say about X?" → search and retrieve transcripts
- "Summarize this project" → list conversations, read summaries

Do NOT use tools for greetings, small talk, or meta-questions about how you work.

## Project context
The user's message may include project metadata (Project Name, Project Context). \
Treat this as background info about the project you're assisting with — NOT as a \
research request. Focus on what the user is actually asking in their message.

## Research guidelines (when doing research)
- Start by telling the user your plan briefly before making tool calls.
- Prefer `listProjectConversations` to get an overview before keyword searches.
- For `findConvosByKeywords`, prefer 2-4 focused keywords over long sentence-style queries.
- Avoid repetitive low-signal searches. Maximum 6 tool calls per turn.
- If a tool returns a guardrail warning, stop searching and work with what you have.
- After gathering evidence, give a clear, direct answer.

## Citation policy (when citing project data)
- Ground claims in tool results. Include 2-5 short verbatim quotes when available, \
tagged as [conversation_id:<id>].
- If direct quotes are unavailable, say so.
- Never fabricate quotes, sources, or conversation IDs.
"""


def _build_llm() -> ChatGoogleGenerativeAI:
    settings = get_settings()
    if not settings.gemini_api_key:
        raise ValueError("GEMINI_API_KEY is required")

    return ChatGoogleGenerativeAI(
        model=settings.llm_model,
        google_api_key=settings.gemini_api_key,
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

    def _build_snippet(
        *,
        line: str,
        offset: int,
        needle_length: int,
        context_window: int = 80,
    ) -> str:
        start = max(0, offset - context_window)
        end = min(len(line), offset + needle_length + context_window)
        snippet = line[start:end].strip()
        if not snippet:
            snippet = line.strip()
        if start > 0 and snippet:
            snippet = f"...{snippet}"
        if end < len(line) and snippet:
            snippet = f"{snippet}..."
        return snippet

    def _grep_transcript_snippets(
        *,
        transcript: str,
        query: str,
        limit: int,
    ) -> list[dict[str, Any]]:
        normalized_query = query.strip().lower()
        if not normalized_query:
            return []

        matches: list[dict[str, Any]] = []
        lines = transcript.splitlines() or [transcript]

        for line_index, line in enumerate(lines):
            if not isinstance(line, str):
                continue

            lowered = line.lower()
            search_offset = 0
            while True:
                match_offset = lowered.find(normalized_query, search_offset)
                if match_offset < 0:
                    break

                matches.append(
                    {
                        "line_index": line_index,
                        "offset": match_offset,
                        "snippet": _build_snippet(
                            line=line,
                            offset=match_offset,
                            needle_length=len(normalized_query),
                        ),
                    }
                )
                if len(matches) >= limit:
                    return matches

                search_offset = match_offset + max(1, len(normalized_query))

        return matches

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
            transcript = await client.get_conversation_transcript(conversation_id)
        finally:
            await client.close()

        matches = _grep_transcript_snippets(
            transcript=transcript,
            query=normalized_query,
            limit=normalized_limit,
        )
        return {
            "project_id": project_id,
            "conversation_id": conversation_id,
            "participant_name": conversation.get("participant_name"),
            "query": normalized_query,
            "count": len(matches),
            "matches": matches,
        }

    tools = [
        get_project_scope,
        findConvosByKeywords,
        listProjectConversations,
        listConvoSummary,
        listConvoFullTranscript,
        grepConvoSnippets,
    ]
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

    async def call_model(state: dict) -> dict:
        messages = state.get("messages", [])
        # Build invocation list with system prompt, but don't persist duplicates
        if not messages or not isinstance(messages[0], SystemMessage):
            invocation_messages = [SystemMessage(content=SYSTEM_PROMPT)] + messages
        else:
            invocation_messages = messages
        response = await llm_with_tools.ainvoke(invocation_messages)
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
    return workflow.compile(checkpointer=MemorySaver())
