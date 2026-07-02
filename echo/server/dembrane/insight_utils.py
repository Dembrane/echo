"""Anonymized usage-insight summarizer for agentic chats.

A periodic sweep (dembrane.tasks.task_capture_chat_insights) feeds the ordered
messages of an idle agentic chat into `generate_chat_insight`, which asks the
small/fast model to describe, in one or two anonymized sentences, what the host
was trying to do or where they got stuck, and to classify the interaction.

The summary CONTENT must never carry PII: no names, no verbatim quotes, no ids,
no numbers that could identify a specific person or project. Origin ids
(workspace/project/chat/user) are kept on the usage_insight row itself, not in
the summary text.
"""

import json
import logging
from typing import Optional

from dembrane.llms import MODELS, arouter_completion

logger = logging.getLogger("insight_utils")

# How long a chat must sit untouched before the sweep treats it as "ended" and
# eligible for a fresh insight, and how many idle chats one sweep processes.
INSIGHT_IDLE_MINUTES = 20
INSIGHT_SWEEP_BATCH = 25

# The classifier's allowed labels. Mirrors the usage_insight.insight_type choices.
INSIGHT_TYPES = ("intent", "friction", "feature_request", "success", "other")


def _build_insight_prompt(messages: list[dict], language: str) -> str:
    """Build the strict-JSON insight prompt from an ordered message list.

    Kept as a standalone builder so the anonymization guardrails can be asserted
    in tests without calling the model.
    """
    lines: list[str] = []
    for message in messages:
        role = message.get("message_from")
        text = (message.get("text") or "").strip()
        if not text:
            continue
        # "user" turns are the host; label the other side generically. Never
        # surface the word "AI" (brand voice).
        speaker = "host" if role == "user" else "assistant"
        lines.append(f"{speaker}: {text}")

    transcript = "\n".join(lines)

    return (
        "You are analysing one chat between a host and the assistant inside "
        "dembrane, a tool where hosts explore transcripts of conversations with "
        "participants. Read the chat and produce a single anonymized usage "
        "insight.\n"
        "\n"
        "Summarize, in ONE or two sentences, what the host was trying to do or "
        "where they got stuck in this chat. Then classify the interaction into "
        "exactly one insight_type from this list:\n"
        "- intent: the host wanted to accomplish a specific goal or question.\n"
        "- friction: the host struggled, got confused, or could not get what "
        "they needed.\n"
        "- feature_request: the host asked for something the tool does not do.\n"
        "- success: the host clearly achieved what they set out to do.\n"
        "- other: none of the above fit.\n"
        "\n"
        "ANONYMIZATION RULES (critical, the summary must obey every one):\n"
        "- No participant or host names, and no names of any kind.\n"
        "- No verbatim quotes from the chat.\n"
        "- No conversation, project, workspace, or chat ids.\n"
        "- No numbers or specific details that could identify a particular "
        "person or project.\n"
        "- Describe the intent or pattern generically, for example: \"the host "
        "wanted to compare themes across interviews and struggled to narrow the "
        "topic\".\n"
        "\n"
        "BRAND VOICE:\n"
        "- Never use the word \"AI\".\n"
        "- Write \"dembrane\" in lowercase.\n"
        "- Use no em dashes.\n"
        "- Say \"participants\" and \"hosts\", never \"users\".\n"
        "\n"
        f"Write the summary in the language with code \"{language}\".\n"
        "\n"
        "Return STRICT JSON and nothing else, with exactly these keys:\n"
        '{"insight_type": "<one of intent|friction|feature_request|success|'
        'other>", "summary": "<one or two anonymized sentences>"}\n'
        "If the chat is empty or too trivial to summarize, return exactly: "
        "null\n"
        "\n"
        "Chat:\n"
        f"{transcript}\n"
    )


def _parse_insight(raw: Optional[str]) -> Optional[dict]:
    """Defensively parse the model's JSON reply into a validated insight dict."""
    if raw is None:
        return None

    text = raw.strip()
    if not text:
        return None

    # Strip a markdown code fence if the model wrapped its JSON in one.
    if text.startswith("```"):
        text = text.strip("`")
        # Drop a leading language hint like "json\n".
        if "\n" in text:
            text = text.split("\n", 1)[1]
        text = text.strip()

    try:
        parsed = json.loads(text)
    except (json.JSONDecodeError, ValueError):
        logger.warning("Could not parse insight JSON from model output")
        return None

    if not isinstance(parsed, dict):
        # The model may legitimately answer `null` for a trivial chat.
        return None

    insight_type = parsed.get("insight_type")
    summary = parsed.get("summary")

    if insight_type not in INSIGHT_TYPES:
        logger.warning("Insight had unknown insight_type %r; discarding", insight_type)
        return None

    if not isinstance(summary, str) or not summary.strip():
        return None

    return {"insight_type": insight_type, "summary": summary.strip()}


async def generate_chat_insight(
    messages: list[dict], language: str = "en"
) -> Optional[dict]:
    """Summarize an agentic chat into one anonymized usage insight.

    Args:
        messages: ordered list of {message_from, text} for the chat.
        language: ISO 639-1 code for the summary language.

    Returns:
        {"insight_type": <one of intent|friction|feature_request|success|other>,
         "summary": <str>} or None when there is nothing meaningful to capture
        (empty/trivial chat, model declined, or unparseable output).
    """
    # Nothing to summarize if there is no host turn with content.
    has_host_text = any(
        (m.get("message_from") == "user") and (m.get("text") or "").strip()
        for m in messages
    )
    if not has_host_text:
        return None

    prompt = _build_insight_prompt(messages, language)

    response = await arouter_completion(
        MODELS.MULTI_MODAL_FAST,
        messages=[{"role": "user", "content": prompt}],
    )

    content = response.choices[0].message.content
    if content is None:
        logger.warning("No insight generated for chat")
        return None

    return _parse_insight(content)
