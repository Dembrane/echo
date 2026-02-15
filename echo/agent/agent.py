from logging import getLogger
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

SYSTEM_PROMPT = """You are the Echo Agentic Chat assistant.

Echo is a democratic deliberation engine.

You run in an isolated backend service and must proactively use tools to gather
conversation evidence before answering.

Research workflow (mandatory):
1. Break down user intent into explicit subquestions/subtopics.
2. Derive a strategy for which tools and conversation data to query per subquestion.
3. Adapt your research course when evidence is missing, conflicting, or insufficient.
4. Synthesize a comprehensive final answer that addresses all subquestions.

Evidence and citation policy (mandatory):
- Ground claims in tool results.
- Include 2-5 short verbatim quotes when available and tag each as [conversation_id:<id>].
- If direct quotes are unavailable, state that explicitly.
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

    def _create_echo_client() -> EchoClient:
        if echo_client_factory:
            return echo_client_factory(bearer_token)
        return EchoClient(bearer_token=bearer_token)

    def _normalize_project_conversation(raw: dict[str, Any]) -> dict[str, Any] | None:
        conversation_id = raw.get("id")
        if not isinstance(conversation_id, str) or not conversation_id:
            return None

        conversation_project_id = raw.get("projectId")
        if isinstance(conversation_project_id, dict):
            conversation_project_id = conversation_project_id.get("id")
        if not isinstance(conversation_project_id, str):
            conversation_project_id = raw.get("project_id")
        if isinstance(conversation_project_id, dict):
            conversation_project_id = conversation_project_id.get("id")
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

    def _extract_project_conversations(payload: dict[str, Any]) -> list[dict[str, Any]]:
        raw_conversations = payload.get("conversations", [])
        if not isinstance(raw_conversations, list):
            return []

        conversations: list[dict[str, Any]] = []
        for raw in raw_conversations:
            if not isinstance(raw, dict):
                continue
            normalized = _normalize_project_conversation(raw)
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
        payload = await client.search_home(query=conversation_id, limit=20)
        for candidate in _extract_project_conversations(payload):
            if candidate.get("conversation_id") == conversation_id:
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

            return list(conversations_by_id.values())[:normalized_limit]
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
        conversations = await _search_project_conversations(query=keywords, limit=limit)
        return {
            "project_id": project_id,
            "query": keywords,
            "count": len(conversations),
            "conversations": conversations,
        }

    @tool
    async def listConvoSummary(conversation_id: str) -> dict[str, Any]:
        """Return metadata + summary (nullable) for a single project conversation."""
        conversation = await _resolve_project_conversation(conversation_id)
        return {
            "project_id": project_id,
            "conversation": conversation,
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

    tools = [
        get_project_scope,
        findConvosByKeywords,
        listConvoSummary,
        listConvoFullTranscript,
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
        if not messages or not isinstance(messages[0], SystemMessage):
            messages = [SystemMessage(content=SYSTEM_PROMPT)] + messages
        response = await llm_with_tools.ainvoke(messages)
        return {"messages": messages + [response]}

    workflow = StateGraph(CopilotKitState)
    workflow.add_node("agent", call_model)
    workflow.add_node("tools", ToolNode(tools))

    workflow.set_entry_point("agent")
    workflow.add_conditional_edges("agent", should_continue, {"tools": "tools", END: END})
    workflow.add_edge("tools", "agent")
    return workflow.compile(checkpointer=MemorySaver())
