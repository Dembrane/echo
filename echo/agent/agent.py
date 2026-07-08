from logging import getLogger
import re
from typing import Any, Callable
from datetime import datetime, timezone, timedelta

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
- Be warm, direct, and concise. Do not introduce yourself with a role or
  persona ("as your colleague", "as your assistant here"). Skip the preamble
  and just help.
- For a greeting or a broad "what can you do", reply in one or two sentences
  and offer one concrete next step (for example, listing the conversations in
  the project). Do not recite your full capability list unprompted.
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
- "Help me set the goal / figure out this project" -> readSkill(interviewing.md),
  then readGoal and listMethodologies, then proposeGoal.
- "What did we discuss before / continue that chat" -> listProjectChats, then readChat.
- "Is my session live / is it recording / anyone talking now / is anything
  broken?" -> getLiveConversationStatus, then report the live count, whether
  transcription is keeping up, and flag any conversation that is failing.
Do not use tools for greetings, small talk, or questions about this chat.
When intent is unclear, ask one focused question instead of guessing.

## Getting help from the dembrane team
When the host needs something you cannot give: something looks broken, a billing
or account question, or a question about dembrane the documentation does not
answer, offer to log their question with the dembrane team. Tell the host what you
will send first and send it in their own words where you can. Say it has been
logged for the team to review. Never promise that someone will follow up, reply
directly, or act by a certain time; you hand the message over and that is all
you can guarantee. If logging fails, say so plainly and point the host at the
direct routes on the Getting help page (users/host/getting-help.md), especially
emailing support@dembrane.com. Be honest above all: a failed send is never
"sent".

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
- Batch your lookups. readDoc and grepDocs each take a list, so read every page
  you need (or search every pattern) in one step instead of one call at a time.
  When several independent lookups would answer the question, request them
  together rather than sequentially.
- You have at most 20 steps per turn. Spend them on distinct questions, not
  retries. If a step returns a guardrail warning, stop searching and answer from
  what you have.

## Citations
- Ground every claim about the project in tool results.
- Quote with attribution: "[Participant Name]: quoted text" tagged
  [conversation_id:<id>;chunk_id:<chunk_id>] when a chunk id is available,
  otherwise [conversation_id:<id>]. One conversation per tag: never
  conversation_ids, never comma-separated ids inside one tag. To cite several
  conversations, write several tags.
- A few well-chosen quotes beat many.
- Cite the doc path when you answer from documentation.

## Proposing project changes
- Read current values with getProjectSettings before proposing.
- Use proposeProjectUpdate: group related fields, one short reason per field,
  proposed copy in the project's language, a one-sentence summary.
- The host sees a diff and applies or rejects it themselves. You never apply
  changes. Say "I've suggested these changes", never "I've updated your project".
  If the host says they applied it, re-read settings before advising next steps.
- Verify prompts: when the host wants a custom check on each conversation (a
  "verify prompt"), use proposeCustomVerificationTopic with a short label and the
  instruction to run, in the project's language. Mention that verification has
  to be enabled for it to run, and offer a proposeProjectUpdate to switch
  is_verify_enabled on if getProjectSettings shows it off.

## Canvases
A canvas is a living page in the project Library. It regenerates on a loop until
its expiry. Propose one when the host asks for a recurring or live artifact,
such as a wall, pulse, dashboard, or page that keeps itself fresh. Always say the
expiry plainly. Do not volunteer exact cadence or interval minutes unless the
host asks for that detail; say it keeps itself fresh or updates on the next
refresh. The host applies the proposal, and you can list canvases or pause,
resume, and stop their loops by chat. For pause/resume/stop requests, first
resolve the referenced canvas with listCanvases when the host uses a name or
shorthand such as "the wall"; then confirm the action by canvas name. Be honest
that updates are periodic, not instant second-by-second changes.

## Project setup
When the first message signals setup, or when readGoal shows this project has no
goal, offer a short interview. Read interviewing.md first and use that shape:
convergent options, at most five questions, and a confirm-understanding close.
Offer existing methodologies from listMethodologies when any exist. Keep it
escapable: "you can skip this and come back any time, or read the docs". When
you have enough, use proposeGoal to restate the goal in the host's words. After
a substantial artifact or report, you may gently suggest extracting a
methodology. Never do it automatically.

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
Memories are visible to hosts in their settings, and hosts can delete them
there. If a host asks to change or remove a memory, point them there as well.

## Project context
The first message may include Project Name, Workspace Context, Project Context,
and Project Goal. Workspace and project context are written by hosts as standing
guidance and background for you. The project goal is the current versioned
intent for reports and artifacts. Follow them, but they are not a research
request. Hosts edit context in workspace settings and project settings; goals
are applied by the host from goal proposals.
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
    docs_base_url: str = "",
    chat_id: str = "",
    app_user_id: str = "",
    message_id: str = "",
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
    def readDoc(paths: list[str], offset: int = 1, limit: int = 200) -> dict[str, Any]:
        """Read one or more documentation pages (line-numbered). Pass several
        paths at once to read them in a single step instead of one call each.
        offset/limit page within each page: use a single path when you need to
        deep-page one long page."""
        normalized = [p for p in (paths or []) if isinstance(p, str) and p.strip()]
        if not normalized:
            raise ValueError("Provide at least one doc path in `paths`.")
        return {
            "docs": [
                {"path": path, "content": knowledge.read_doc(path, offset=offset, limit=limit)}
                for path in normalized
            ]
        }

    @tool
    def grepDocs(patterns: list[str]) -> dict[str, Any]:
        """Search the documentation corpus for regexes or phrases. Pass several
        patterns at once to search them all in a single step instead of one
        call per pattern."""
        normalized = [p for p in (patterns or []) if isinstance(p, str) and p.strip()]
        if not normalized:
            raise ValueError("Provide at least one pattern in `patterns`.")
        return {
            "results": [
                {"pattern": pattern, "matches": knowledge.grep_docs(pattern)}
                for pattern in normalized
            ]
        }

    @tool
    def readSkill(path: str) -> str:
        """Read the full body of a skill from the skill catalog."""
        return knowledge.read_skill(path)

    @tool
    async def getProjectSettings() -> dict[str, Any]:
        """Read the project's current editable settings (portal, language, context).

        Fields reading "default" are unset: dembrane's built-in behavior applies
        (users/host/portal-editor.md describes what each default does). Report
        them as "default", never as empty or missing. To keep a default, do not
        propose that field."""
        client = _create_echo_client()
        try:
            current = await client.get_project_settings(project_id)
        finally:
            await client.close()
        # Hosts think in defaults, not empty database fields.
        return {
            key: (
                "default"
                if value is None or (isinstance(value, str) and not value.strip())
                else value
            )
            for key, value in current.items()
        }

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
    async def proposeCustomVerificationTopic(
        label: str,
        prompt: str,
        reason: str = "",
    ) -> dict[str, Any]:
        """Propose a custom verification topic (a "verify prompt") for the host
        to apply in one click.

        A verification topic checks each conversation against an instruction you
        write. `label` is the short host-facing name; `prompt` is the instruction
        the check runs (write it in the project's language). Use this when the
        host wants a bespoke verification, not one of the built-in topics. This
        never writes anything: the host reviews and applies it. Note in your
        reply that verification must be enabled for the check to run, and offer a
        proposeProjectUpdate to turn it on if it is off.
        """
        normalized_label = label.strip()
        normalized_prompt = prompt.strip()
        if not normalized_label:
            raise ValueError("A short label for the verification topic is required.")
        if not normalized_prompt:
            raise ValueError("The verification prompt (the instruction to check) is required.")

        return {
            "kind": "custom_verification_topic_suggestion",
            "project_id": project_id,
            "label": normalized_label,
            "prompt": normalized_prompt,
            "reason": reason.strip(),
            "visible_to_user": True,
        }

    @tool
    async def proposeCanvas(
        name: str,
        brief: str,
        gather_window_minutes: int = 60,
        cadence_minutes: int = 5,
        expires_in_hours: int = 8,
    ) -> dict[str, Any]:
        """Propose a living canvas for the host to apply.

        Use this only when the host asked for a recurring or live artifact, such
        as a screen, wall, dashboard, pulse, or page that keeps itself fresh.
        Always state the expiry out loud in your message, but do not mention the
        exact cadence unless the host asks. The host applies it: you never create
        it yourself.
        """
        normalized_name = name.strip()
        normalized_brief = brief.strip()
        if not normalized_name:
            raise ValueError("A canvas name is required.")
        if not normalized_brief:
            raise ValueError("A canvas brief is required.")
        if cadence_minutes < 2:
            raise ValueError("cadence_minutes must be at least 2.")
        if expires_in_hours > 168:
            raise ValueError("expires_in_hours must be at most 168.")
        if expires_in_hours <= 0:
            raise ValueError("expires_in_hours must be positive.")

        window_minutes = max(1, min(int(gather_window_minutes or 60), 60 * 24 * 14))
        expires_at = datetime.now(timezone.utc) + timedelta(hours=expires_in_hours)
        return {
            "type": "canvas_proposal",
            "name": normalized_name,
            "brief": normalized_brief,
            "gather_spec": {"window_minutes": window_minutes},
            "cadence_minutes": cadence_minutes,
            "expires_at": expires_at.isoformat(),
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
    async def getLiveConversationStatus() -> dict[str, Any]:
        """Check which conversations are recording right now, how transcription
        is keeping up, and whether any are failing. Use this when the host asks
        if their session is live, if recording is working, how many people are
        talking, or whether anything is broken. Returns a summary (counts of
        live / transcribing / failing) plus per-conversation status."""
        client = _create_echo_client()
        try:
            monitor = await client.get_project_monitor(project_id)
        finally:
            await client.close()
        return monitor

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
        """Log a question or problem with the dembrane team on the host's behalf. Use this when the host needs help you cannot give: something looks broken, a billing or account question, or a question about dembrane the documentation does not answer. `message` is what the host wants to ask, in their own words where you can. `context` is a short note about what they were doing. Tell the host what you are sending before you send it. Afterwards say it is logged for the team to review; never promise a direct follow-up or a timeline."""
        client = _create_echo_client()
        try:
            result = await client.create_support_request(
                project_id,
                message=message,
                page_context=context or None,
                chat_id=chat_id or None,
                app_user_id=app_user_id or None,
                message_id=message_id or None,
            )
        except Exception:
            # Honesty over reassurance: never pretend a failed send worked.
            return {
                "sent": False,
                "error": (
                    "The request could not be logged. Tell the host plainly that "
                    "it did not go through, and give them the direct alternatives "
                    "from the Getting help page (docs: users/host/getting-help.md), "
                    "including emailing support@dembrane.com with the details."
                ),
            }
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
    async def readGoal() -> dict[str, Any]:
        """Read the current project goal and recent goal revision history."""
        client = _create_echo_client()
        try:
            payload = await client.get_project_goal(project_id)
        finally:
            await client.close()
        return dict(payload)

    @tool
    async def proposeGoal(content: str) -> dict[str, Any]:
        """Propose a project goal after interviewing the host. Restate the goal
        in the host's words. This never writes anything: the host applies it."""
        normalized_content = content.strip()
        if not normalized_content:
            raise ValueError("content is required")
        return {
            "type": "goal_proposal",
            "content": normalized_content,
            "project_id": project_id,
            "visible_to_user": True,
        }

    @tool
    async def listMethodologies() -> dict[str, Any]:
        """List methodologies the host can choose from for this project setup."""
        client = _create_echo_client()
        try:
            payload = await client.list_methodologies(project_id)
        finally:
            await client.close()
        methodologies = payload.get("methodologies") if isinstance(payload, dict) else None
        return {"methodologies": methodologies if isinstance(methodologies, list) else []}

    @tool
    async def listCanvases() -> dict[str, Any]:
        """List the project's canvases and their loop status."""
        client = _create_echo_client()
        try:
            canvases = await client.list_canvases(project_id)
        finally:
            await client.close()
        return {"canvases": canvases}

    async def _resolve_canvas_id(reference: str) -> tuple[str, str | None]:
        normalized_reference = reference.strip()
        if not normalized_reference:
            raise ValueError("canvas_id is required.")
        client = _create_echo_client()
        try:
            canvases = await client.list_canvases(project_id)
        finally:
            await client.close()
        if not canvases:
            return normalized_reference, None

        for canvas in canvases:
            canvas_id = str(canvas.get("id") or "")
            if canvas_id == normalized_reference:
                return canvas_id, canvas.get("name")

        reference_lower = normalized_reference.lower()
        named = [
            canvas
            for canvas in canvases
            if str(canvas.get("name") or "").strip().lower() == reference_lower
        ]
        if not named:
            named = [
                canvas
                for canvas in canvases
                if reference_lower in str(canvas.get("name") or "").strip().lower()
            ]
        if len(named) == 1:
            canvas = named[0]
            return str(canvas["id"]), canvas.get("name")
        if len(named) > 1:
            names = ", ".join(str(canvas.get("name") or canvas.get("id")) for canvas in named)
            raise ValueError(f"Multiple canvases match {normalized_reference!r}: {names}.")
        raise ValueError(f"No canvas matches {normalized_reference!r}. Use listCanvases first.")

    async def _canvas_loop_action(canvas_id: str, action: str) -> dict[str, Any]:
        resolved_canvas_id, resolved_name = await _resolve_canvas_id(canvas_id)
        client = _create_echo_client()
        try:
            loop = await client.update_canvas_loop(project_id, resolved_canvas_id, action)
        finally:
            await client.close()
        return {"canvas_id": resolved_canvas_id, "canvas_name": resolved_name, "loop": loop}

    @tool
    async def pauseCanvasLoop(canvas_id: str) -> dict[str, Any]:
        """Pause a canvas loop. canvas_id may be an id or unique canvas name/reference."""
        return await _canvas_loop_action(canvas_id, "pause")

    @tool
    async def resumeCanvasLoop(canvas_id: str) -> dict[str, Any]:
        """Resume a paused canvas loop if it has not ended. canvas_id may be an id or unique canvas name/reference."""
        return await _canvas_loop_action(canvas_id, "resume")

    @tool
    async def stopCanvasLoop(canvas_id: str) -> dict[str, Any]:
        """Stop a canvas loop permanently. Confirm with the host first because
        stopping is terminal. canvas_id may be an id or unique canvas name/reference."""
        return await _canvas_loop_action(canvas_id, "stop")

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
        proposeCustomVerificationTopic,
        proposeCanvas,
        sendProgressUpdate,
        listProjectChats,
        readChat,
        getLiveConversationStatus,
        reachOutToDembrane,
        readMemory,
        readGoal,
        proposeGoal,
        listMethodologies,
        listCanvases,
        pauseCanvasLoop,
        resumeCanvasLoop,
        stopCanvasLoop,
        remember,
    ]
    system_prompt = SYSTEM_PROMPT + knowledge.prompt_section(docs_base_url=docs_base_url)
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
