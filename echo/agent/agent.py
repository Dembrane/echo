from logging import getLogger
import json
import re
from typing import Any, Callable, Literal
from datetime import datetime, timezone, timedelta
from uuid import uuid4

from copilotkit.langgraph import CopilotKitState
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_core.tools import tool
from google.oauth2 import service_account
from langchain_google_vertexai import ChatVertexAI
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, StateGraph
from langgraph.prebuilt import ToolNode

import knowledge
from echo_client import EchoClient, build_project_portal_link, normalize_portal_language
from settings import get_settings

logger = getLogger("agent")
VERTEX_AUTH_SCOPES = ["https://www.googleapis.com/auth/cloud-platform"]
MAX_AMBIENT_MEMORY_ITEMS = 12
MAX_AMBIENT_MEMORY_CHARS = 3000
MAX_CANVAS_ACTIVITY_RUNS = 5
MAX_CANVAS_ACTIVITY_DETAIL_CHARS = 220

DashboardPageKey = Literal[
    "overview",
    "chats",
    "monitor",
    "library",
    "host-guide",
    "report",
    "conversations",
    "settings",
    "portal-editor",
]

AgentInsightKind = Literal["capability_gap", "friction", "wish", "praise"]

# Tool taxonomy. Every registered tool falls into one of three buckets:
# - UI tools render a card in the chat timeline (see UI_TOOLS below).
# - Read tools fetch project data or product knowledge and return it to the
#   model only (findConversationsByKeywords, listConversationSummary,
#   listConversationFullTranscript, grepConversationSnippets,
#   listProjectConversations, getProjectSettings, getProjectTags, getPortalLink,
#   listDocs, readDoc, grepDocs, readSkill, listProjectChats, readChat,
#   getLiveConversationStatus, readMemory, readGoal, listMethodologies,
#   listCanvases, get_project_scope).
# - Write tools change durable state (editProjectTags, editCanvas, addToCanvas,
#   removeFromCanvas, pauseCanvasLoop, resumeCanvasLoop, stopCanvasLoop,
#   remember, reachOutToDembraneSupport, noteInsight). noteInsight also renders a
#   card, so it appears in UI_TOOLS too.
# The README carries the same table for humans.
UI_TOOLS = frozenset(
    {
        "navigateTo",
        "proposeCanvas",
        "proposeGoal",
        "proposeProjectUpdate",
        "noteInsight",
        "sendProgressUpdate",
    }
)

# Tools were renamed in wave 32 for host-visible clarity. Persisted run
# histories still carry the OLD names, and Vertex 400s if a replayed tool call
# or tool result names a function that is no longer registered. This map
# normalizes old -> new wherever a history is rebuilt, so old runs replay
# cleanly. We never register the old names as visible tools.
TOOL_NAME_RENAMES: dict[str, str] = {
    "findConvosByKeywords": "findConversationsByKeywords",
    "listConvoSummary": "listConversationSummary",
    "listConvoFullTranscript": "listConversationFullTranscript",
    "grepConvoSnippets": "grepConversationSnippets",
    "reachOutToDembrane": "reachOutToDembraneSupport",
    "recordInsight": "noteInsight",
}


def _rename_tool_name(name: str) -> str:
    return TOOL_NAME_RENAMES.get(name, name)


NAVIGATION_LABELS: dict[str, str] = {
    "overview": "overview",
    "chats": "chats",
    "monitor": "monitor",
    "library": "library",
    "host-guide": "host guide",
    "report": "report",
    "conversations": "conversations",
    "settings": "settings",
    "portal-editor": "portal editor",
}

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
- Only say you saved, logged, proposed, updated, paused, resumed, stopped, or
  sent something after the corresponding action returned success in this turn.
  If the action failed or you did not take it, say plainly what did not happen.
  Counterexample: do not tell the host "I have saved a note to project memory:
  The owner's name is spelled Akshita..." unless `remember` returned success in
  this turn.

## When to use tools
Use tools when the question needs project data or product knowledge:
- "What topics came up?" -> listProjectConversations, then read summaries.
- "What did people say about X?" -> findConversationsByKeywords, then
  grepConversationSnippets or listConversationFullTranscript for exact wording.
- "How does the portal work?" -> grepDocs and readDoc; cite the doc path.
- "How do participants record / where is the portal link / how do I share it?"
  -> getPortalLink, then give the actual link and call navigateTo("overview")
  or navigateTo("host-guide") in the same turn so the host can find it in the
  dashboard.
- "Help me set up my project" -> readSkill(project-onboarding.md), then
  getProjectSettings and getProjectTags, then proposeProjectUpdate if a
  settings change is ready.
- "Help me set the goal / figure out this project" -> readSkill(interviewing.md),
  then readGoal and listMethodologies, then proposeGoal.
- "What did we discuss before / continue that chat" -> listProjectChats, then readChat.
- "Is my session live / is it recording / anyone talking now / is anything
  broken?" -> getLiveConversationStatus, then report the live count, whether
  transcription is keeping up, and flag any conversation that is failing.
Do not use tools for greetings, small talk, or questions about this chat.
When intent is unclear, ask one focused question instead of guessing.

## The dashboard
- Overview: portal link and QR code, portal settings summary, and the Portal
  editor button.
- Chats: project chats with this assistant.
- Monitor: live participant recording and transcription health.
- Library: conversations, canvases, reports, and analysis materials.
- Host guide: guidance for sharing the portal and running collection.
- Report: report creation, editing, and sharing.
- Conversations: the conversation list, transcripts, tags, and status.
- Settings: project configuration and access controls.
Never describe dashboard navigation beyond these surfaces. When sharing the
portal is the topic, give the actual link via getPortalLink and say: you'll also
find this link and a QR code on your project's Overview page, and the Host guide
walks through sharing it. When a host asks where something is in the dashboard,
give one short locating sentence and call navigateTo in the same turn. Never ask permission before showing a navigation shortcut and never describe the card as
optional. Counterexample: do not say "Would you like me to show a navigation
card?" Do not write multi-step dashboard routes. Never invent tabs, buttons, or menus.

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

## Noticing what dembrane cannot do yet
When you notice a product-learning signal, quietly call noteInsight once in the
same turn:
- The host asks for something you cannot fulfill directly.
- You have to use a workaround because dembrane does not have the right ability.
- The host expresses friction with the product.
- The host wishes dembrane had a capability.
Use kind capability_gap, friction, wish, or praise. `content` is the host's need
restated plainly in one to three sentences, never transcript verbatims or
participant content. `suggested_capability` says what tool, navigation, setting,
or product ability would have served the need, when there is one. Record one row
per distinct need per chat and do not repeat the same need in later turns.
Logging is quiet: do not narrate that you logged an insight on every turn. When
the host explicitly wishes for a feature, you may say once, "I've noted this for
the dembrane team." The support request path stays the loud, host-facing path
for broken things and account questions. noteInsight is the quieter
product-learning path: it drops a small "noted for the dembrane team" card in
the chat rather than opening a support thread. Both can happen in the same turn
when appropriate.
Examples:
- If the host says a canvas is hard to read and asks why you cannot change the
  styling yourself, use kind capability_gap with content "The host needs generated
  canvas styling to be easier to adjust from chat." and suggested_capability
  "A canvas styling control or direct canvas-style proposal that can adjust
  readability, contrast, and color."
- If the host asks you to take them to a specific internal tab or page, use kind
  wish with content "The host wants chat to provide direct navigation to a
  specific dashboard surface." and suggested_capability "A dashboard navigation
  suggestion that can deep-link to internal tabs."

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
- findConversationsByKeywords works best with 2-4 focused keywords, not sentences.
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
- Read current tags with getProjectTags before recommending automatic titles
  and draft tags. If no project tags exist, do not claim tag automation will
  organize conversations. First suggest a small host-defined tag vocabulary.
  The setting can draft short titles and attach existing project tags after
  summarization, but tags remain draft organization for the host to review.
- Tags are the host-visible portal vocabulary. When the host asks to add or
  remove tags, read getProjectTags first, then use editProjectTags(add, remove)
  and confirm in one sentence what changed. Only remove a tag the host names
  explicitly; never clear tags participants may already be using on their own.
- Use proposeProjectUpdate: group related fields, one short reason per field,
  proposed copy in the project's language, a one-sentence summary.
- The host sees a diff and applies or rejects it themselves. You never apply
  changes. Say "I've suggested these changes", never "I've updated your project".
  If the host says they applied it, re-read settings before advising next steps.
- The host guide is editable through host_guide. When the host wants
  participants or facilitators guided differently, offer a host_guide update
  proposal with short copy in the project's language.
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
resume, stop, edit small presentation/wording details directly, and propose
substantive updates to their loops by chat. When the host asks for a small
presentation or wording edit to an existing canvas, such as removing section
dividers or a "freshly compiled" footer line, resolve the referenced canvas,
read its latest generation, rewrite only the requested HTML fragment, call
editCanvas, and say what changed. Do not make a proposal card for these surgical
edits. For substantive changes to what the canvas gathers, shows, is named, or
how often it refreshes, use proposeCanvas with target_canvas_id so the host sees
an update proposal. For pause/resume/stop requests, first resolve the referenced
canvas with listCanvases when the host uses a name or shorthand such as "the
wall"; then confirm the action by canvas name. Be honest that updates are
periodic, not instant second-by-second changes.
Canvas briefs are durable instructions only: sections, style rules, standing
corrections, focus, and exclusions. They must never contain gathered content,
participant reflections, quotes, or the synthesis text the loop should generate
fresh from transcripts each tick. The Wednesday Check in failure is the
counterexample: a brief bloated with person-by-person summaries, open issues,
and discussion questions freezes content that belongs in generated canvas
output. When a host says "put X on the wall", "add <person>'s reflection",
"pin that", or otherwise asks you to place exact host-provided text onto an
existing canvas, resolve the canvas and call addToCanvas in the same turn. Do
not paste the item into the brief and do not create a proposal card. Use
removeFromCanvas when the host asks to unpin or remove one of those host-added
items. When revising a brief, rewrite it cleanly and consolidate standing edits.
Do not append forever just because revision history exists.
The generated canvas content can include presentation guidance within the
dembrane kit's brand system: emphasis, contrast, visual tone, and what to
highlight. If the host says a canvas is hard to read, too dim, the colors do not
work, or a visual status is unclear, treat that as a canvas update request. Use
proposeCanvas with target_canvas_id and a brief describing the readability fix,
then offer a refresh. Do not claim the platform controls generated content
styling. Reserve dembrane team help for the app chrome, canvas shell, account
issues, or things the generated HTML cannot change.
Canvas structural primitives are explicit tab kinds. Use tabs when the host asks
for a structure the platform supports: crux, concept_cloud, story, host_guide,
and board. For person-by-person, per-person, speaker-by-speaker, or per-table
summaries, propose a board tab with grouping person, for example
tabs=[{"kind":"crux"},{"kind":"concept_cloud"},{"kind":"board","grouping":"person"}].
If the host asks for a structural view no primitive supports, say that plainly,
quietly call noteInsight with category capability_gap, and do not promise the
loop will rebuild into that shape.
After proposing a canvas, do not ask the host to tell you when it is applied.
The chat records that automatically.
When you propose a canvas or an update, the proposal card appears RIGHT HERE in
this chat, directly below your message. Say "review and apply it below" or
similar. Never tell the host the proposal is in their Library or dashboard: the
Library holds live canvases, not proposals, and sending the host there to find
a proposal is a dead end ("The update proposal is ready in your Library" is the
named counterexample).
Canvas activity may appear in a "Canvas activity since last turn" system block.
Use it only as evidence that a linked canvas loop did something after your last
reply. If that activity shows a genuine fork, you may ask AT MOST ONE pointed
question in the same turn as the rest of your reply. A real fork means the host
must choose a direction, for example: receipts were rejected ("I dropped two
quotes I could not verify verbatim. Want me to relisten to that stretch of
Cesare's conversation?"); a tab is starving ("nothing has earned XL in the cloud
yet. Loosen the two-people rule, or wait?"); repeated no_ops while the host keeps
asking for updates ("the loop has heard nothing new for 40 minutes. Is the
recorder still on?"). Counterexamples: never ask permission to do something you
can already do; never ask more than one question; never ask when there is no
fork, silence is correct then. Ground any question in the injected run details
only. Never invent canvas activity.

## Project setup
When the first message signals setup, or when readGoal shows this project has no
goal, help with one lightweight question at a time. Read interviewing.md first
and use that shape: no "interview" wording, no announced question count,
convergent options, and a confirm-understanding close. Ask exactly one question
per turn, with 2-4 concrete options and an easy skip or free-text escape. Use
plain conversational openers such as "What are you hoping to learn?" Early in
setup, ask how many people are part of defining what this project is, and whether
the project definition is already clear or the project should collect input
about what it should become. If several people need to shape it together, suggest
opening that discussion and recording it with a phone or dembrane Go, with
everyone's consent, then using that conversation as project material so you can
continue setup from what the group said. Early in setup, mention once, in one
warm sentence, that the project starts on the dembrane way of working: first we
shape the project together, then you collect conversations, then we make sense
of them. Offer existing methodologies from
listMethodologies when any exist, calling them methodologies or ways of working,
never frameworks or tools. If only the seeded dembrane methodology exists, that
mention is enough; do not force a choice. Documentation is a light aside only: link text should
be short ("the docs"), and a docs mention must not be the final sentence or
visual call to action of a message. When you have enough, use proposeGoal to
restate the goal in the host's words. After proposing a goal, do not ask the host
to report back after applying it. The chat records that automatically. If the
project has no goal and this is the setup conversation, proposeGoal is the
closing move and must come before proposeProjectUpdate or any settings/context
suggestion. Suggest context/settings updates only after a goal exists. After a
substantial artifact or report, you may gently suggest extracting a methodology.
Never do it automatically.
The first visible assistant message in a setup chat must contain the first real
question for the host, not status narration about looking at settings, reviewing
context, or planning what you will do.

## Memory
You can save durable notes with `remember` and recall them with `readMemory`.
Relevant saved memories may already appear in a "What you remember" system
section, so use them without waiting to call a tool. Call `readMemory` when you
need to explicitly re-read or verify current memory. There are three scopes:
- user: this host's own preferences. This is the only scope that may hold
  private or personal details.
- workspace: shared preferences for the whole workspace. Keep these generic.
- project: notes about this project. Keep these generic.
When a memory bears on the answer, apply it. Remembered corrections, names,
spellings, and preferences are not decoration. If remembered context names or
corrects something the current data leaves unnamed or misspelled, use the
remembered version and cite it naturally.
Prefer updating an existing note by passing the same memory_key over saving a
near duplicate. Never store private or personal information outside user scope.
When you save something, tell the host in one short sentence what you saved.
When the saved memory is a spelling or name correction that could improve future
transcription, also offer one concise project-settings proposal: use
proposeProjectUpdate to add the corrected term to
default_conversation_transcript_prompt. This is the existing key terms field,
not new machinery. Examples: Akshita, Jorim, AI4Deliberation.
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


def _memory_sort_key(memory: dict[str, Any]) -> str:
    return str(memory.get("updated_at") or "")


def _format_memory_section(memories: list[Any]) -> str:
    rows = [memory for memory in memories if isinstance(memory, dict)]
    if not rows:
        return ""

    rows = sorted(rows, key=_memory_sort_key, reverse=True)
    lines: list[str] = ["## What you remember"]
    used_chars = len(lines[0])
    for memory in rows[:MAX_AMBIENT_MEMORY_ITEMS]:
        content = str(memory.get("content") or "").strip()
        if not content:
            continue
        scope = str(memory.get("scope") or "memory").strip() or "memory"
        memory_key = str(memory.get("memory_key") or "").strip()
        label = scope if not memory_key else f"{scope}/{memory_key}"
        line = f"- {label}: {content}"
        remaining = MAX_AMBIENT_MEMORY_CHARS - used_chars
        if remaining <= 0:
            break
        if len(line) > remaining:
            line = line[: max(0, remaining - 1)].rstrip() + "..."
        lines.append(line)
        used_chars += len(line) + 1
        if used_chars >= MAX_AMBIENT_MEMORY_CHARS:
            break

    return "\n".join(lines) if len(lines) > 1 else ""


def _truncate_canvas_activity_detail(detail: Any) -> str:
    normalized = str(detail or "").strip()
    if len(normalized) <= MAX_CANVAS_ACTIVITY_DETAIL_CHARS:
        return normalized
    return normalized[: MAX_CANVAS_ACTIVITY_DETAIL_CHARS - 3].rstrip() + "..."


def _canvas_activity_runs_for_canvas(canvas: dict[str, Any]) -> list[dict[str, Any]]:
    raw_runs = canvas.get("recent_runs")
    if not isinstance(raw_runs, list):
        raw_runs = canvas.get("runs")
    if isinstance(raw_runs, list):
        return [run for run in raw_runs if isinstance(run, dict)]

    loop = canvas.get("loop")
    if not isinstance(loop, dict):
        return []

    status = loop.get("last_run_status")
    detail = loop.get("last_run_detail")
    if not status and not detail:
        return []
    return [
        {
            "status": status,
            "detail": detail,
            "started_at": loop.get("last_run_started_at"),
        }
    ]


def _format_canvas_activity_section(payload: Any) -> str:
    if not isinstance(payload, dict):
        return ""

    canvases = payload.get("canvases")
    if not isinstance(canvases, list) or not canvases:
        return ""

    lines: list[str] = ["## Canvas activity since last turn"]
    rendered_runs = 0
    for canvas in canvases:
        if not isinstance(canvas, dict):
            continue
        canvas_name = str(canvas.get("name") or canvas.get("id") or "Canvas").strip()
        canvas_id = str(canvas.get("id") or "").strip()
        canvas_label = canvas_name if not canvas_id else f"{canvas_name} ({canvas_id})"
        runs = _canvas_activity_runs_for_canvas(canvas)
        if not runs:
            continue
        lines.append(f"- {canvas_label}")
        for run in runs:
            status = str(run.get("status") or "unknown").strip() or "unknown"
            detail = _truncate_canvas_activity_detail(run.get("detail"))
            started_at = str(run.get("started_at") or "").strip()
            prefix = f"  - {status}"
            if started_at:
                prefix = f"{prefix} at {started_at}"
            lines.append(f"{prefix}: {detail}" if detail else prefix)
            rendered_runs += 1
            if rendered_runs >= MAX_CANVAS_ACTIVITY_RUNS:
                return "\n".join(lines)

    return "\n".join(lines) if rendered_runs else ""


def _split_concatenated_json_objects(raw: str, expected_count: int) -> list[Any] | None:
    decoder = json.JSONDecoder()
    values: list[Any] = []
    index = 0
    while index < len(raw):
        while index < len(raw) and raw[index].isspace():
            index += 1
        if index >= len(raw):
            break
        try:
            value, end = decoder.raw_decode(raw, index)
        except json.JSONDecodeError:
            return None
        values.append(value)
        index = end

    if len(values) != expected_count:
        return None
    return values


def _split_fused_tool_name(name: str, tool_names: set[str]) -> list[str] | None:
    if name in tool_names:
        return None

    candidates = sorted(tool_names, key=len, reverse=True)
    memo: dict[int, list[str] | None] = {}

    def _match(index: int) -> list[str] | None:
        if index == len(name):
            return []
        if index in memo:
            return memo[index]
        for candidate in candidates:
            if not name.startswith(candidate, index):
                continue
            suffix = _match(index + len(candidate))
            if suffix is not None:
                memo[index] = [candidate] + suffix
                return memo[index]
        memo[index] = None
        return None

    parts = _match(0)
    return parts if parts and len(parts) > 1 else None


def _normalize_fused_tool_calls(message: Any, tool_names: set[str]) -> Any:
    tool_calls = getattr(message, "tool_calls", None)
    invalid_tool_calls = getattr(message, "invalid_tool_calls", None)
    if not isinstance(tool_calls, list):
        tool_calls = []
    if not isinstance(invalid_tool_calls, list):
        invalid_tool_calls = []
    if not tool_calls and not invalid_tool_calls:
        return message

    normalized_calls: list[dict[str, Any]] = []
    changed = False
    remaining_invalid_calls: list[Any] = []

    def _append_normalized_or_original(call: Any, *, keep_unsplit_invalid: bool) -> None:
        nonlocal changed
        if not isinstance(call, dict):
            if keep_unsplit_invalid:
                remaining_invalid_calls.append(call)
            else:
                normalized_calls.append(call)
            return

        name = str(call.get("name") or "")
        split_names = _split_fused_tool_name(name, tool_names)
        if not split_names:
            # Not a fused name, but it may still be an OLD name from a replayed
            # history: normalize it to the registered name before we hand it back.
            renamed = _rename_tool_name(name)
            if renamed != name and isinstance(call, dict):
                changed = True
                call = {**call, "name": renamed}
            if keep_unsplit_invalid:
                remaining_invalid_calls.append(call)
            else:
                normalized_calls.append(call)
            return

        args = call.get("args")
        split_args: list[Any] | None = None
        if isinstance(args, str):
            split_args = _split_concatenated_json_objects(args, len(split_names))
        elif isinstance(args, list) and len(args) == len(split_names):
            split_args = args
        if split_args is None:
            logger.warning("Dropping fused tool call with unsplittable args: %s", name)
            if keep_unsplit_invalid:
                remaining_invalid_calls.append(call)
            changed = True
            return

        changed = True
        base_id = str(call.get("id") or uuid4())
        for index, split_name in enumerate(split_names):
            split_arg = split_args[index]
            normalized_calls.append(
                {
                    **call,
                    "id": f"{base_id}-{index}",
                    # A fused name may itself concatenate OLD names in a replayed
                    # history; rename each part to the registered tool name.
                    "name": _rename_tool_name(split_name),
                    "args": split_arg if isinstance(split_arg, dict) else {},
                }
            )

    for call in tool_calls:
        _append_normalized_or_original(call, keep_unsplit_invalid=False)
    for call in invalid_tool_calls:
        _append_normalized_or_original(call, keep_unsplit_invalid=True)

    if not changed:
        return message
    if hasattr(message, "model_copy"):
        return message.model_copy(
            update={
                "tool_calls": normalized_calls,
                "invalid_tool_calls": remaining_invalid_calls,
            }
        )
    return message


def _normalize_message_tool_names(message: Any, tool_names: set[str]) -> Any:
    """Normalize renamed tool names on one message so old runs replay cleanly.

    AI messages carry tool_calls (possibly fused); tool messages carry a `name`
    that must match a registered function or Vertex 400s. Both are mapped
    old -> new here at the history-replay boundary."""
    if getattr(message, "type", None) == "tool":
        name = getattr(message, "name", None)
        if isinstance(name, str):
            renamed = _rename_tool_name(name)
            if renamed != name and hasattr(message, "model_copy"):
                return message.model_copy(update={"name": renamed})
        return message
    return _normalize_fused_tool_calls(message, tool_names)


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
    ambient_memory_section: str | None = None

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
    async def findConversationsByKeywords(keywords: str, limit: int = 5) -> dict[str, Any]:
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
                        "Stop repeating findConversationsByKeywords and answer from available context/evidence."
                    ),
                    attempts=consecutive_empty_keyword_searches,
                    stop_search=True,
                )
        else:
            consecutive_empty_keyword_searches = 0

        return result

    @tool
    async def listConversationSummary(conversation_id: str) -> dict[str, Any]:
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
    async def listConversationFullTranscript(conversation_id: str) -> dict[str, Any]:
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
    async def grepConversationSnippets(conversation_id: str, query: str, limit: int = 8) -> dict[str, Any]:
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
    async def getProjectTags() -> dict[str, Any]:
        """Read the project's current tag vocabulary.

        Tags are defined by hosts and can be selected by participants. Automatic
        draft tagging can only choose from these existing tags; if this list is
        empty, suggest defining tags before recommending tag automation.
        """
        client = _create_echo_client()
        try:
            tags = await client.list_project_tags(project_id)
        finally:
            await client.close()
        return {
            "project_id": project_id,
            "count": len(tags),
            "tags": tags,
        }

    @tool
    async def editProjectTags(
        add: list[str] | None = None,
        remove: list[str] | None = None,
    ) -> dict[str, Any]:
        """Edit the project's host-visible tag vocabulary and return the updated
        list. `add` creates tags that do not already exist; `remove` deletes
        tags by exact text (case-insensitive). Read getProjectTags first, then
        confirm in one sentence what changed. Tags are the portal vocabulary
        hosts and participants see, so only remove a tag when the host asks for
        that tag by name."""
        add_list = [t.strip() for t in (add or []) if isinstance(t, str) and t.strip()]
        remove_list = [t.strip() for t in (remove or []) if isinstance(t, str) and t.strip()]
        if not add_list and not remove_list:
            raise ValueError("Provide at least one tag to add or remove.")

        client = _create_echo_client()
        try:
            result = await client.edit_project_tags(
                project_id,
                add=add_list,
                remove=remove_list,
            )
        finally:
            await client.close()
        return result

    @tool
    async def getPortalLink() -> dict[str, Any]:
        """Return the actual participant portal link for this project.

        Use this when the host asks how participants record, how to invite
        participants, or where to find/share the portal link. Mention that the
        dashboard also shows the link and QR code on Overview, and the Host guide
        walks through sharing it.
        """
        client = _create_echo_client()
        try:
            current = await client.get_project_settings(project_id)
        finally:
            await client.close()

        language = normalize_portal_language(current.get("language"))
        portal_link = build_project_portal_link(project_id, language)
        if portal_link is None:
            return {
                "project_id": project_id,
                "language": language,
                "portal_link": None,
                "reason": (
                    "Could not determine this environment's participant portal origin. "
                    "Point the host to the Overview page for the portal link and QR code instead."
                ),
                "dashboard_locations": ["Overview", "Host guide"],
            }
        return {
            "project_id": project_id,
            "language": language,
            "portal_link": portal_link,
            "dashboard_locations": ["Overview", "Host guide"],
        }

    @tool
    async def navigateTo(page: DashboardPageKey, entity_id: str = "") -> dict[str, Any]:
        """Return a host-clicked dashboard navigation shortcut. Renders a card in
        the chat UI.

        Use this when the host asks where something lives in the dashboard.
        `page` must be one of the real dashboard surfaces. `entity_id` is
        optional and only useful for a specific canvas in Library or a specific
        conversation in Conversations. This never navigates automatically and
        never calls an API; it only returns a visible suggestion card.
        """
        normalized_page = str(page).strip()
        if normalized_page not in NAVIGATION_LABELS:
            raise ValueError(
                f"Unknown dashboard page: {normalized_page}. "
                f"Allowed pages: {sorted(NAVIGATION_LABELS)}"
            )
        normalized_entity_id = entity_id.strip()

        return {
            "type": "navigation_suggestion",
            "project_id": project_id,
            "page": normalized_page,
            "entity_id": normalized_entity_id or None,
            "label": NAVIGATION_LABELS[normalized_page],
            "visible_to_user": True,
        }

    @tool
    async def proposeProjectUpdate(
        changes: list[dict[str, Any]],
        summary: str,
    ) -> dict[str, Any]:
        """Propose project settings changes for the user to approve. Renders a
        card in the chat UI.

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
        target_canvas_id: str = "",
        tabs: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Propose a living canvas for the host to apply or apply as an update.
        Renders a card in the chat UI.

        Use this only when the host asked for a recurring or live artifact, such
        as a screen, wall, dashboard, pulse, or page that keeps itself fresh.
        Also use it when the host reports a readability, contrast, color, or
        visual hierarchy problem on an existing canvas: pass target_canvas_id
        and put the presentation fix in the brief within the dembrane kit's
        brand system.
        Briefs are durable instructions only: structure, style, standing
        corrections, focus, and exclusions. Never include gathered content,
        participant reflections, quotes, or finished synthesis text in a brief;
        the loop reads transcripts and writes that content fresh every tick.
        Rewrite revised briefs cleanly instead of appending forever.
        Always state the expiry out loud in your message, but do not mention the
        exact cadence unless the host asks. The host applies it: you never create
        or update it yourself. When changing an existing canvas, pass
        target_canvas_id as the id or unique canvas name/reference; the tool
        resolves it and returns an update proposal payload.
        Optional tabs declares the canvas structure. Use it for primitive-backed
        shape requests, such as a board grouped by person.
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
        payload = {
            "type": "canvas_proposal",
            "name": normalized_name,
            "brief": normalized_brief,
            "gather_spec": {"window_minutes": window_minutes},
            "cadence_minutes": cadence_minutes,
            "expires_at": expires_at.isoformat(),
            "visible_to_user": True,
        }
        if tabs is not None:
            if not isinstance(tabs, list):
                raise ValueError("tabs must be a list when provided.")
            payload["tabs"] = tabs
        if target_canvas_id.strip():
            resolved_canvas_id, resolved_name = await _resolve_canvas_id(target_canvas_id)
            payload["target_canvas_id"] = resolved_canvas_id
            payload["target_canvas_name"] = resolved_name
        return payload

    @tool
    async def sendProgressUpdate(update: str, next_steps: str = "") -> dict[str, Any]:
        """Emit a user-visible progress update without concluding the run.
        Renders a card in the chat UI."""
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
    async def reachOutToDembraneSupport(message: str, context: str = "") -> dict[str, Any]:
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
    async def noteInsight(
        kind: AgentInsightKind,
        content: str,
        suggested_capability: str = "",
    ) -> dict[str, Any]:
        """Note a product-learning insight for the dembrane team. Renders a card
        in the chat UI so the host can see what was noted.

        Use this when the host exposes a capability gap, friction, wish, or
        praise. `content` restates the host's need plainly in one to three
        sentences. Do not include transcript verbatims or participant content.
        This does not create a visible support request. It shows a small card
        reading "noted for the dembrane team", so keep any spoken mention light.
        """
        normalized_kind = str(kind).strip()
        if normalized_kind not in {"capability_gap", "friction", "wish", "praise"}:
            raise ValueError(
                "kind must be one of capability_gap, friction, wish, or praise"
            )
        normalized_content = content.strip()
        if not normalized_content:
            raise ValueError("content is required")

        client = _create_echo_client()
        try:
            result = await client.create_agent_insight(
                project_id,
                kind=normalized_kind,
                content=normalized_content,
                suggested_capability=suggested_capability.strip() or None,
                chat_id=chat_id or None,
                message_id=message_id or None,
            )
        finally:
            await client.close()
        normalized_capability = suggested_capability.strip()
        # The card in the chat reads these fields; keep the marker stable.
        return {
            "type": "agent_insight_note",
            "recorded": True,
            "agent_insight_id": result.get("id"),
            "insight_kind": normalized_kind,
            "content": normalized_content,
            "suggested_capability": normalized_capability or None,
            "visible_to_user": True,
        }

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
        """Propose a project goal after helping the host define the setup.
        Renders a card in the chat UI. Restate the goal in the host's words.
        This never writes anything: the host applies it."""
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

    @tool
    async def editCanvas(canvas: str, instruction: str, edited_html: str = "") -> dict[str, Any]:
        """Directly edit the latest generated HTML for a small canvas presentation
        or wording change. `canvas` may be an id or unique canvas name/reference.
        First call this with canvas and instruction only to read the latest HTML.
        Then rewrite the HTML yourself, applying only that instruction, and call
        again with edited_html set to the full edited body fragment. Do not use
        this for substantive changes to what the canvas gathers, shows, cadence,
        or name; use proposeCanvas instead.
        """
        resolved_canvas_id, resolved_name = await _resolve_canvas_id(canvas)
        normalized_instruction = instruction.strip()
        if not normalized_instruction:
            raise ValueError("instruction is required.")

        client = _create_echo_client()
        try:
            canvas_payload = await client.get_canvas(project_id, resolved_canvas_id)
            generation = canvas_payload.get("latest_generation")
            latest_html = (
                generation.get("content_html")
                if isinstance(generation, dict)
                else None
            )
            if not isinstance(latest_html, str) or not latest_html.strip():
                raise ValueError("This canvas has no generated HTML to edit yet.")
            if not edited_html.strip():
                return {
                    "canvas_id": resolved_canvas_id,
                    "canvas_name": resolved_name,
                    "instruction": normalized_instruction,
                    "latest_html": latest_html,
                    "requires_edited_html": True,
                }
            result = await client.edit_canvas(
                project_id,
                resolved_canvas_id,
                normalized_instruction,
                edited_html.strip(),
                chat_id=chat_id or None,
            )
        finally:
            await client.close()
        generation_result = result.get("generation")
        return {
            "canvas_id": resolved_canvas_id,
            "canvas_name": resolved_name,
            "status": result.get("status"),
            "generation_id": generation_result.get("id")
            if isinstance(generation_result, dict)
            else None,
        }

    @tool
    async def addToCanvas(
        canvas: str,
        text: str,
        target_tab: str = "story",
        person: str = "",
    ) -> dict[str, Any]:
        """Add exact host-provided text to an existing canvas immediately.

        Use this when the host says to put something on the wall, pin that,
        or add a named person's reflection. `canvas` may be an id or unique
        canvas name/reference. `target_tab` is one of crux, concept_cloud, or
        story. Do not paraphrase `text`.
        """
        resolved_canvas_id, resolved_name = await _resolve_canvas_id(canvas)
        normalized_text = text.strip()
        if not normalized_text:
            raise ValueError("text is required.")
        client = _create_echo_client()
        try:
            result = await client.add_canvas_host_item(
                project_id,
                resolved_canvas_id,
                normalized_text,
                target_tab,
                person=person.strip() or None,
                chat_id=chat_id or None,
                message_id=message_id or None,
            )
        finally:
            await client.close()
        return {
            "canvas_id": resolved_canvas_id,
            "canvas_name": resolved_name,
            "status": result.get("status"),
            "host_item": result.get("host_item"),
        }

    @tool
    async def removeFromCanvas(canvas: str, item: str) -> dict[str, Any]:
        """Remove a host-added canvas item by id or matching text.

        Use this when the host asks to unpin or remove something they
        previously added with addToCanvas. `canvas` may be an id or unique
        canvas name/reference.
        """
        resolved_canvas_id, resolved_name = await _resolve_canvas_id(canvas)
        normalized_item = item.strip()
        if not normalized_item:
            raise ValueError("item is required.")
        client = _create_echo_client()
        try:
            result = await client.remove_canvas_host_item(
                project_id,
                resolved_canvas_id,
                normalized_item,
                chat_id=chat_id or None,
                message_id=message_id or None,
            )
        finally:
            await client.close()
        return {
            "canvas_id": resolved_canvas_id,
            "canvas_name": resolved_name,
            "status": result.get("status"),
            "item": result.get("item"),
        }

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
        findConversationsByKeywords,
        listProjectConversations,
        listConversationSummary,
        listConversationFullTranscript,
        grepConversationSnippets,
        listDocs,
        readDoc,
        grepDocs,
        readSkill,
        getProjectSettings,
        getProjectTags,
        editProjectTags,
        getPortalLink,
        navigateTo,
        proposeProjectUpdate,
        proposeCustomVerificationTopic,
        proposeCanvas,
        sendProgressUpdate,
        listProjectChats,
        readChat,
        getLiveConversationStatus,
        reachOutToDembraneSupport,
        noteInsight,
        readMemory,
        readGoal,
        proposeGoal,
        listMethodologies,
        listCanvases,
        editCanvas,
        addToCanvas,
        removeFromCanvas,
        pauseCanvasLoop,
        resumeCanvasLoop,
        stopCanvasLoop,
        remember,
    ]
    system_prompt = SYSTEM_PROMPT + knowledge.prompt_section(docs_base_url=docs_base_url)
    configured_llm = llm or _build_llm()
    llm_with_tools = configured_llm.bind_tools(tools)
    tool_names = {tool.name for tool in tools}
    # The fused-call splitter and history normalization also recognize the OLD
    # tool names, so a replayed history that concatenated or named an old tool
    # still splits and renames to the registered name.
    recognized_tool_names = tool_names | set(TOOL_NAME_RENAMES.keys())

    async def _load_ambient_memory_section() -> str:
        nonlocal ambient_memory_section
        if ambient_memory_section is not None:
            return ambient_memory_section

        client = _create_echo_client()
        try:
            payload = await client.list_memory(project_id)
        except Exception:
            logger.exception("Failed to load ambient agent memory")
            ambient_memory_section = ""
        else:
            memories = payload.get("memories") if isinstance(payload, dict) else None
            ambient_memory_section = _format_memory_section(
                memories if isinstance(memories, list) else []
            )
        finally:
            await client.close()

        return ambient_memory_section

    async def _load_canvas_activity_section() -> str:
        if not chat_id:
            return ""

        client = _create_echo_client()
        try:
            payload = await client.list_chat_canvas_activity(
                project_id=project_id,
                chat_id=chat_id,
                limit=MAX_CANVAS_ACTIVITY_RUNS,
            )
        except Exception:
            logger.exception("Failed to load canvas activity for chat %s", chat_id)
            return ""
        finally:
            await client.close()

        return _format_canvas_activity_section(payload)

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
        # Normalize OLD tool names in replayed history (both AI tool_calls and
        # tool-result messages) before invoking Vertex, or it 400s on a function
        # name it no longer knows.
        messages = [
            _normalize_message_tool_names(
                _with_placeholder_content(message), recognized_tool_names
            )
            for message in raw_messages
        ]
        memory_section = await _load_ambient_memory_section()
        canvas_activity_section = await _load_canvas_activity_section()
        system_sections = [
            section for section in [system_prompt, memory_section, canvas_activity_section] if section
        ]
        effective_system_prompt = "\n\n".join(system_sections)
        # Build invocation list with system prompt, but don't persist duplicates
        if not messages or not isinstance(messages[0], SystemMessage):
            invocation_messages = [SystemMessage(content=effective_system_prompt)] + messages
        else:
            invocation_messages = list(messages)

        # Count on the raw history: the placeholder text must not read as
        # an assistant update.
        automatic_nudge = _build_automatic_nudge(raw_messages)
        nudge_milestone: int | None = None
        if automatic_nudge:
            nudge_content, nudge_milestone = automatic_nudge
            invocation_messages.append(HumanMessage(content=nudge_content))

        response = _normalize_fused_tool_calls(
            await llm_with_tools.ainvoke(invocation_messages),
            recognized_tool_names,
        )

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
            response = _normalize_fused_tool_calls(
                await llm_with_tools.ainvoke(retry_messages),
                recognized_tool_names,
            )

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
