from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional
from datetime import datetime

import litellm
from fastapi import APIRouter, HTTPException
from pydantic import Field, BaseModel, validator

from dembrane.utils import generate_uuid
from dembrane.config import GCP_SA_JSON
from dembrane.prompts import render_prompt
from dembrane.directus import directus
from dembrane.transcribe import _get_audio_file_object
from dembrane.async_helpers import run_in_thread_pool
from dembrane.api.exceptions import ProjectNotFoundException, ConversationNotFoundException
from dembrane.api.dependency_auth import DependencyDirectusSession

logger = logging.getLogger("api.verify")

VerifyRouter = APIRouter(tags=["verify"])

DEFAULT_LANG = "en-US"


class VerificationTopicSeed(BaseModel):
    key: str
    prompt: str
    icon: str
    label: str
    sort: int


DEFAULT_VERIFICATION_TOPICS: List[VerificationTopicSeed] = [
    VerificationTopicSeed(
        key="agreements",
        icon=":white_check_mark:",
        label="What we actually agreed on",
        sort=1,
        prompt=(
            "Extract the concrete agreements and shared understandings from this conversation. "
            "Focus on points where multiple participants explicitly or implicitly aligned. "
            "Include both major decisions and small points of consensus. Present these as clear, "
            "unambiguous statements that all participants would recognize as accurate. Distinguish "
            "between firm agreements and tentative consensus. If participants used different words "
            "to express the same idea, synthesize into shared language. Format as a living document "
            "of mutual understanding. Output character should be diplomatic but precise, like meeting "
            "minutes with soul."
        ),
    ),
    VerificationTopicSeed(
        key="gems",
        icon=":mag:",
        label="Hidden gems",
        sort=2,
        prompt=(
            "Identify the valuable insights that emerged unexpectedly or were mentioned briefly but "
            "contain significant potential. Look for: throwaway comments that solve problems, questions "
            "that reframe the entire discussion, metaphors that clarify complex ideas, connections between "
            "seemingly unrelated points, and wisdom hiding in personal anecdotes. Present these as discoveries "
            "worth preserving, explaining why each gem matters. These are the insights people might forget but "
            "shouldn't. Output character should be excited and precise."
        ),
    ),
    VerificationTopicSeed(
        key="truths",
        icon=":eyes:",
        label="Painful truths",
        sort=3,
        prompt=(
            "Surface the uncomfortable realities acknowledged in this conversation - the elephants in the room that "
            "got named, the difficult facts accepted, the challenging feedback given or received. Include systemic "
            "problems identified, personal blind spots revealed, and market realities confronted. Present these with "
            "compassion but without sugar-coating. Frame them as shared recognitions that took courage to voice. "
            "These truths are painful but necessary for genuine progress. Output character should be gentle but "
            "unflinching."
        ),
    ),
    VerificationTopicSeed(
        key="moments",
        icon=":rocket:",
        label="Breakthrough moments",
        sort=4,
        prompt=(
            "Capture the moments when thinking shifted, new possibilities emerged, or collective understanding jumped "
            "to a new level. Identify: sudden realizations, creative solutions, perspective shifts, moments when "
            "complexity became simple, and ideas that energized the group. Show both the breakthrough itself and what "
            "made it possible. These are the moments when the conversation transcended its starting point. Output "
            "character should be energetic and forward-looking."
        ),
    ),
    VerificationTopicSeed(
        key="actions",
        icon=":arrow_upper_right:",
        label="What we think should happen",
        sort=5,
        prompt=(
            "Synthesize the group's emerging sense of direction and next steps. Include: explicit recommendations made, "
            "implicit preferences expressed, priorities that emerged through discussion, and logical next actions even "
            "if not explicitly stated. Distinguish between unanimous direction and majority leanings. Present as "
            "provisional navigation rather than fixed commands. This is the group's best current thinking about the "
            "path forward. Output character should be pragmatic but inspirational."
        ),
    ),
    VerificationTopicSeed(
        key="disagreements",
        icon=":warning:",
        label="Moments we agreed to disagree",
        sort=6,
        prompt=(
            "Document the points of productive tension where different perspectives remained distinct but respected. "
            "Include: fundamental differences in approach, varying priorities, different risk tolerances, and contrasting "
            "interpretations of data. Frame these not as failures to agree but as valuable diversity of thought. Show how "
            "each perspective has merit. These disagreements are features, not bugs - they prevent premature convergence "
            "and keep important tensions alive. Output character should be respectful and balanced."
        ),
    ),
]


class VerificationTopicTranslation(BaseModel):
    label: str


class VerificationTopicMetadata(BaseModel):
    key: str
    prompt: Optional[str] = None
    icon: Optional[str] = None
    sort: Optional[int] = None
    translations: Dict[str, VerificationTopicTranslation] = Field(default_factory=dict)


class GetVerificationTopicsResponse(BaseModel):
    selected_topics: List[str]
    available_topics: List[VerificationTopicMetadata]


class GenerateArtifactsRequest(BaseModel):
    topic_list: List[str] = Field(..., min_items=1)
    conversation_id: str

    @validator("topic_list")
    def validate_topic_list(cls, value: List[str]) -> List[str]:
        cleaned = [item.strip() for item in value if item and item.strip()]
        if not cleaned:
            raise ValueError("topic_list must contain at least one topic key")
        return cleaned


class ConversationArtifactResponse(BaseModel):
    id: str
    key: Optional[str] = None
    content: str
    conversation_id: str
    approved_at: Optional[str] = None
    read_aloud_stream_url: str


class GenerateArtifactsResponse(BaseModel):
    artifact_list: List[ConversationArtifactResponse]


class UpdateVerificationTopicsRequest(BaseModel):
    topic_list: List[str] = Field(default_factory=list)


def _parse_directus_datetime(value: Optional[str]) -> Optional[datetime]:
    if value is None:
        return None
    try:
        # Directus returns ISO strings that may end with 'Z'
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        logger.warning("Unable to parse datetime value '%s'", value)
        return None


async def seed_default_verification_topics() -> None:
    """
    Ensure that the canonical verification topics exist in Directus.
    """

    for topic in DEFAULT_VERIFICATION_TOPICS:
        existing = await run_in_thread_pool(
            directus.get_items,
            "verification_topic",
            {
                "query": {
                    "filter": {
                        "key": {"_eq": topic.key},
                        "project_id": {"_null": True},
                    },
                    "fields": ["key"],
                    "limit": 1,
                }
            },
        )

        if existing:
            continue

        logger.info("Seeding verification topic '%s'", topic.key)
        translations_payload = [
            {
                "languages_code": DEFAULT_LANG,
                "label": topic.label,
            }
        ]

        await run_in_thread_pool(
            directus.create_item,
            "verification_topic",
            item_data={
                "key": topic.key,
                "prompt": topic.prompt,
                "icon": topic.icon,
                "sort": topic.sort,
                "translations": {
                    "create": translations_payload,
                },
            },
        )


async def _get_project(project_id: str) -> dict:
    project_rows = await run_in_thread_pool(
        directus.get_items,
        "project",
        {
            "query": {
                "filter": {"id": {"_eq": project_id}},
                "fields": [
                    "id",
                    "is_verify_enabled",
                    "selected_verification_key_list",
                    "language",
                    "name",
                ],
            }
        },
    )

    if not project_rows:
        raise ProjectNotFoundException

    project = project_rows[0]
    if not project.get("is_verify_enabled", False):
        raise HTTPException(status_code=403, detail="Verify is not enabled for this project")

    return project


async def _get_verification_topics_for_project(project_id: str) -> List[VerificationTopicMetadata]:
    topic_rows = await run_in_thread_pool(
        directus.get_items,
        "verification_topic",
        {
            "query": {
                "filter": {
                    "_or": [
                        {"project_id": {"_null": True}},
                        {"project_id": {"_eq": project_id}},
                    ]
                },
                "fields": [
                    "key",
                    "prompt",
                    "icon",
                    "sort",
                    "project_id",
                    "translations.languages_code",
                    "translations.label",
                ],
                "limit": -1,
                "sort": ["sort", "key"],
            }
        },
    )

    topics: List[VerificationTopicMetadata] = []
    for raw_topic in topic_rows:
        translations_map: Dict[str, VerificationTopicTranslation] = {}
        for translation in raw_topic.get("translations", []) or []:
            code = translation.get("languages_code")
            label = translation.get("label")
            if code and label:
                translations_map[code] = VerificationTopicTranslation(label=label)

        topics.append(
            VerificationTopicMetadata(
                key=raw_topic.get("key"),
                prompt=raw_topic.get("prompt"),
                icon=raw_topic.get("icon"),
                sort=raw_topic.get("sort"),
                translations=translations_map,
            )
        )

    topics.sort(key=lambda topic: (topic.sort or 0, topic.key))
    return topics


def _parse_selected_topics(
    raw_value: Optional[str], all_topics: List[VerificationTopicMetadata]
) -> List[str]:
    if raw_value:
        selected = [topic_key.strip() for topic_key in raw_value.split(",") if topic_key.strip()]
    else:
        selected = []

    available_keys = {topic.key for topic in all_topics if topic.key}
    filtered = [key for key in selected if key in available_keys]

    if filtered:
        return filtered
    return [topic.key for topic in all_topics if topic.key]


@VerifyRouter.get("/topics/{project_id}", response_model=GetVerificationTopicsResponse)
async def get_verification_topics(
    project_id: str,
    auth: DependencyDirectusSession,  # noqa: ARG001 - reserved for future use
) -> GetVerificationTopicsResponse:
    project = await _get_project(project_id)
    topics = await _get_verification_topics_for_project(project_id)
    selected_topics = _parse_selected_topics(project.get("selected_verification_key_list"), topics)

    return GetVerificationTopicsResponse(selected_topics=selected_topics, available_topics=topics)


@VerifyRouter.put("/topics/{project_id}", response_model=GetVerificationTopicsResponse)
async def update_verification_topics(
    project_id: str,
    body: UpdateVerificationTopicsRequest,
    auth: DependencyDirectusSession,  # noqa: ARG001 - reserved for future use
) -> GetVerificationTopicsResponse:
    await _get_project(project_id)
    topics = await _get_verification_topics_for_project(project_id)
    available_keys = [topic.key for topic in topics if topic.key]

    normalized_keys = []
    for key in body.topic_list:
        key = key.strip()
        if key and key in available_keys and key not in normalized_keys:
            normalized_keys.append(key)

    serialized_keys = ",".join(normalized_keys)

    await run_in_thread_pool(
        directus.update_item,
        "project",
        project_id,
        {"selected_verification_key_list": serialized_keys or None},
    )

    refreshed_topics = await _get_verification_topics_for_project(project_id)
    selected_topics = _parse_selected_topics(serialized_keys, refreshed_topics)
    return GetVerificationTopicsResponse(selected_topics=selected_topics, available_topics=refreshed_topics)


async def _get_conversation_with_project(conversation_id: str) -> dict:
    conversation_rows = await run_in_thread_pool(
        directus.get_items,
        "conversation",
        {
            "query": {
                "filter": {"id": {"_eq": conversation_id}},
                "fields": [
                    "id",
                    "participant_name",
                    "participant_email",
                    "project_id.id",
                    "project_id.language",
                    "project_id.name",
                    "project_id.is_verify_enabled",
                ],
            }
        },
    )

    if not conversation_rows:
        raise ConversationNotFoundException

    conversation = conversation_rows[0]
    project = conversation.get("project_id") or {}
    if not project.get("is_verify_enabled", False):
        raise HTTPException(status_code=403, detail="Verify is not enabled for this project")

    return conversation


async def _get_conversation_artifacts(conversation_id: str) -> List[dict]:
    artifacts = await run_in_thread_pool(
        directus.get_items,
        "conversation_artifact",
        {
            "query": {
                "filter": {"conversation_id": {"_eq": conversation_id}},
                "fields": [
                    "id",
                    "key",
                    "content",
                    "date_created",
                    "approved_at",
                    "read_aloud_stream_url",
                ],
                "limit": -1,
                "sort": ["date_created"],
            }
        },
    )
    return artifacts or []


def _format_previous_artifacts(artifacts: List[dict]) -> str:
    if not artifacts:
        return "Previous artifacts: None\n"

    lines = ["Previous artifacts:"]
    for artifact in artifacts:
        created = artifact.get("date_created") or "unknown"
        key = artifact.get("key") or "unknown key"
        content = artifact.get("content") or ""
        lines.append(f"- [{created}] ({key}) {content}")
    lines.append("")
    return "\n".join(lines)


async def _get_conversation_chunks(conversation_id: str) -> List[dict]:
    chunk_rows = await run_in_thread_pool(
        directus.get_items,
        "conversation_chunk",
        {
            "query": {
                "filter": {"conversation_id": {"_eq": conversation_id}},
                "fields": ["id", "timestamp", "transcript", "path"],
                "sort": "timestamp",
                "limit": 1500,
            }
        },
    )

    chunks: List[dict] = []
    for row in chunk_rows or []:
        chunks.append(
            {
                "id": row.get("id"),
                "timestamp": _parse_directus_datetime(row.get("timestamp")),
                "transcript": row.get("transcript"),
                "path": row.get("path"),
            }
        )

    return chunks


def _build_transcript_text(chunks: List[dict]) -> str:
    transcripts: List[str] = []
    for chunk in chunks:
        transcript = (chunk.get("transcript") or "").strip()
        if transcript:
            transcripts.append(transcript)
    return "\n".join(transcripts)


def _select_audio_chunks(
    chunks: List[dict],
    last_artifact_time: Optional[datetime],
) -> List[dict]:
    selected: List[dict] = []
    for chunk in chunks:
        transcript = (chunk.get("transcript") or "").strip()
        if transcript:
            continue

        timestamp = chunk.get("timestamp")
        if last_artifact_time and isinstance(timestamp, datetime):
            if timestamp <= last_artifact_time:
                continue

        if chunk.get("path"):
            selected.append(chunk)

    return selected


def _format_audio_summary(audio_chunks: List[dict]) -> str:
    if not audio_chunks:
        return "Audio attachments: None."

    lines = ["Audio attachments for chunks without transcripts after the last artifact:"]
    for chunk in audio_chunks:
        timestamp = chunk.get("timestamp")
        ts_value = timestamp.isoformat() if isinstance(timestamp, datetime) else "unknown"
        lines.append(f"- chunk_id={chunk.get('id')} timestamp={ts_value}")
    return "\n".join(lines)


def _build_user_message_content(
    conversation: dict,
    artifacts: List[dict],
    transcript_text: str,
    audio_summary: str,
) -> str:
    project = conversation.get("project_id") or {}
    parts = [
        f"Project: {project.get('name') or project.get('id')}",
        f"Conversation ID: {conversation.get('id')}",
    ]

    participant_name = conversation.get("participant_name")
    if participant_name:
        parts.append(f"Participant name: {participant_name}")
    participant_email = conversation.get("participant_email")
    if participant_email:
        parts.append(f"Participant email: {participant_email}")

    parts.append("")  # spacer
    parts.append(_format_previous_artifacts(artifacts))
    parts.append("Conversation transcript:")
    if transcript_text:
        parts.append(transcript_text)
    else:
        parts.append("No transcript available.")
    parts.append("")
    parts.append(audio_summary)
    return "\n".join(parts)


def _extract_response_text(response: Any) -> str:
    """
    Normalize LiteLLM response content into a plain string.
    """
    choice = response.choices[0].message
    content = choice.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        texts = [item.get("text", "") for item in content if isinstance(item, dict)]
        return "\n".join(filter(None, texts))
    raise ValueError("Unexpected response format from completion call")


async def _create_conversation_artifact(
    conversation_id: str,
    key: str,
    content: str,
) -> dict:
    artifact_payload = {
        "id": generate_uuid(),
        "conversation_id": conversation_id,
        "key": key,
        "content": content,
        "read_aloud_stream_url": "",
    }

    created = await run_in_thread_pool(
        directus.create_item,
        "conversation_artifact",
        item_data=artifact_payload,
    )
    return created.get("data", artifact_payload)


@VerifyRouter.post("/generate", response_model=GenerateArtifactsResponse)
async def generate_verification_artifacts(
    body: GenerateArtifactsRequest,
    auth: DependencyDirectusSession,  # noqa: ARG001 - reserved for future use
) -> GenerateArtifactsResponse:
    if not GCP_SA_JSON:
        raise HTTPException(status_code=500, detail="GCP credentials are not configured")

    conversation = await _get_conversation_with_project(body.conversation_id)
    project_id = (conversation.get("project_id") or {}).get("id")
    if not project_id:
        raise HTTPException(status_code=400, detail="Conversation is missing project information")

    topics = await _get_verification_topics_for_project(project_id)
    topic_map = {topic.key: topic for topic in topics if topic.key}

    target_topic_key = body.topic_list[0]
    target_topic = topic_map.get(target_topic_key)
    if not target_topic or not target_topic.prompt:
        raise HTTPException(
            status_code=400, detail=f"Verification topic '{target_topic_key}' not found"
        )

    artifacts = await _get_conversation_artifacts(body.conversation_id)
    last_artifact_time = None
    if artifacts:
        last_artifact_time = _parse_directus_datetime(artifacts[-1].get("date_created"))

    chunks = await _get_conversation_chunks(body.conversation_id)
    transcript_text = _build_transcript_text(chunks)
    audio_chunks = _select_audio_chunks(chunks, last_artifact_time)
    audio_summary = _format_audio_summary(audio_chunks)

    user_text = _build_user_message_content(conversation, artifacts, transcript_text, audio_summary)
    message_content = [{"type": "text", "text": user_text}]

    for chunk in audio_chunks:
        timestamp = chunk.get("timestamp")
        ts_value = timestamp.isoformat() if isinstance(timestamp, datetime) else "unknown"
        chunk_id = chunk.get("id")
        message_content.append(
            {
                "type": "text",
                "text": f"Audio chunk {chunk_id} captured at {ts_value}",
            }
        )
        path = chunk.get("path")
        if path:
            try:
                message_content.append(_get_audio_file_object(path))
            except Exception as exc:
                logger.warning("Failed to attach audio chunk %s: %s", chunk_id, exc)

    system_prompt = render_prompt(
        "generate_artifact",
        "en",
        {
            "prompt": target_topic.prompt,
        },
    )

    try:
        response = litellm.completion(
            model="vertex_ai/gemini-2.5-flash",
            vertex_credentials=GCP_SA_JSON,
            messages=[
                {
                    "role": "system",
                    "content": [
                        {
                            "type": "text",
                            "text": system_prompt,
                        }
                    ],
                },
                {
                    "role": "user",
                    "content": message_content,
                },
            ],
        )
    except Exception as exc:
        logger.error("Gemini completion failed: %s", exc, exc_info=True)
        raise HTTPException(
            status_code=500, detail="Failed to generate verification artifact"
        ) from exc

    generated_text = _extract_response_text(response)
    artifact_record = await _create_conversation_artifact(
        body.conversation_id, target_topic_key, generated_text
    )

    artifact_response = ConversationArtifactResponse(
        id=artifact_record.get("id"),
        key=artifact_record.get("key"),
        content=artifact_record.get("content", ""),
        conversation_id=artifact_record.get("conversation_id", body.conversation_id),
        approved_at=artifact_record.get("approved_at"),
        read_aloud_stream_url=artifact_record.get("read_aloud_stream_url") or "",
    )

    return GenerateArtifactsResponse(artifact_list=[artifact_response])
