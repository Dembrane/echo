from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional
from datetime import datetime

import litellm
from fastapi import APIRouter, HTTPException
from pydantic import Field, BaseModel

from dembrane.llms import MODELS, get_completion_kwargs
from dembrane.utils import generate_uuid
from dembrane.prompts import render_prompt
from dembrane.directus import directus
from dembrane.settings import get_settings
from dembrane.transcribe import _get_audio_file_object
from dembrane.async_helpers import run_in_thread_pool
from dembrane.api.exceptions import ProjectNotFoundException, ConversationNotFoundException

logger = logging.getLogger("api.verify")

settings = get_settings()
GCP_SA_JSON = settings.transcription.gcp_sa_json

VerifyRouter = APIRouter(tags=["verify"])


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
    topic_list: List[str]
    conversation_id: str


class ConversationArtifactResponse(BaseModel):
    id: str
    key: Optional[str] = None
    content: str
    conversation_id: str
    approved_at: Optional[str] = None
    date_created: Optional[str] = None
    read_aloud_stream_url: str


class GenerateArtifactsResponse(BaseModel):
    artifact_list: List[ConversationArtifactResponse]


class UpdateVerificationTopicsRequest(BaseModel):
    topic_list: List[str] = Field(default_factory=list)


class UseConversationPayload(BaseModel):
    conversation_id: str = Field(..., alias="conversationId")
    timestamp: datetime

    class Config:
        allow_population_by_field_name = True


class UpdateArtifactRequest(BaseModel):
    use_conversation: Optional[UseConversationPayload] = Field(None, alias="useConversation")
    content: Optional[str] = None
    approved_at: Optional[str] = Field(None, alias="approvedAt")

    class Config:
        allow_population_by_field_name = True


def _parse_directus_datetime(value: Optional[str]) -> Optional[datetime]:
    if value is None:
        return None
    try:
        # Directus returns ISO strings that may end with 'Z'
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        logger.warning("Unable to parse datetime value '%s'", value)
        return None


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
) -> GetVerificationTopicsResponse:
    project = await _get_project(project_id)
    topics = await _get_verification_topics_for_project(project_id)
    selected_topics = _parse_selected_topics(project.get("selected_verification_key_list"), topics)

    return GetVerificationTopicsResponse(selected_topics=selected_topics, available_topics=topics)


@VerifyRouter.put("/topics/{project_id}", response_model=GetVerificationTopicsResponse)
async def update_verification_topics(
    project_id: str,
    body: UpdateVerificationTopicsRequest,
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
    return GetVerificationTopicsResponse(
        selected_topics=selected_topics, available_topics=refreshed_topics
    )


@VerifyRouter.get("/artifacts/{conversation_id}", response_model=List[ConversationArtifactResponse])
async def list_verification_artifacts(
    conversation_id: str,
) -> List[ConversationArtifactResponse]:
    await _get_conversation_with_project(conversation_id)
    artifacts = await _get_conversation_artifacts(conversation_id)

    def _sort_key(item: dict) -> tuple[bool, str]:
        approved = item.get("approved_at")
        created = item.get("date_created")
        if approved:
            return (False, approved)
        if created:
            return (True, created)
        return (True, "")

    artifacts.sort(key=_sort_key, reverse=True)

    response: List[ConversationArtifactResponse] = []
    for artifact in artifacts:
        response.append(
            ConversationArtifactResponse(
                id=artifact.get("id") or "",
                key=artifact.get("key"),
                content=artifact.get("content") or "",
                conversation_id=artifact.get("conversation_id") or conversation_id,
                approved_at=artifact.get("approved_at"),
                date_created=artifact.get("date_created"),
                read_aloud_stream_url=artifact.get("read_aloud_stream_url") or "",
            )
        )

    return response


async def _get_artifact_or_404(artifact_id: str) -> dict:
    artifact_rows = await run_in_thread_pool(
        directus.get_items,
        "conversation_artifact",
        {
            "query": {
                "filter": {"id": {"_eq": artifact_id}},
                "fields": [
                    "id",
                    "conversation_id",
                    "content",
                    "key",
                    "date_created",
                    "approved_at",
                    "read_aloud_stream_url",
                ],
                "limit": 1,
            }
        },
    )

    if not artifact_rows:
        raise HTTPException(status_code=404, detail="Artifact not found")

    return artifact_rows[0]


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


def _build_feedback_text(chunks: List[dict], reference_time: datetime) -> str:
    feedback_segments: List[str] = []
    for chunk in chunks:
        timestamp = chunk.get("timestamp")
        if timestamp and isinstance(timestamp, datetime) and timestamp > reference_time:
            transcript = (chunk.get("transcript") or "").strip()
            if transcript:
                feedback_segments.append(f"[{timestamp.isoformat()}] {transcript}")
    return "\n".join(feedback_segments)


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

    completion_kwargs = get_completion_kwargs(MODELS.MULTI_MODAL_PRO)

    try:
        response = litellm.completion(
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
            **completion_kwargs,
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
        id=artifact_record.get("id") or "",
        key=artifact_record.get("key"),
        content=artifact_record.get("content", ""),
        conversation_id=artifact_record.get("conversation_id", body.conversation_id),
        approved_at=artifact_record.get("approved_at"),
        date_created=artifact_record.get("date_created"),
        read_aloud_stream_url=artifact_record.get("read_aloud_stream_url") or "",
    )

    return GenerateArtifactsResponse(artifact_list=[artifact_response])


@VerifyRouter.put("/artifact/{artifact_id}", response_model=ConversationArtifactResponse)
async def update_verification_artifact(
    artifact_id: str,
    body: UpdateArtifactRequest,
) -> ConversationArtifactResponse:
    # raise HTTPException(status_code=400, detail="No updates provided")
    if not (body.use_conversation or body.content is not None):
        raise HTTPException(status_code=400, detail="No updates provided")

    if body.use_conversation and body.content is not None:
        raise HTTPException(
            status_code=400,
            detail="Provide either useConversation or content, not both",
        )

    artifact = await _get_artifact_or_404(artifact_id)
    conversation_id = artifact.get("conversation_id")

    updates: Dict[str, Any] = {}
    if body.approved_at is not None:
        updates["approved_at"] = body.approved_at

    generated_text = None

    if body.use_conversation:
        if not GCP_SA_JSON:
            raise HTTPException(status_code=500, detail="GCP credentials are not configured")

        reference_conversation_id = body.use_conversation.conversation_id
        reference_timestamp = body.use_conversation.timestamp

        chunks = await _get_conversation_chunks(reference_conversation_id)

        conversation_transcript = _build_transcript_text(chunks)
        feedback_text = _build_feedback_text(chunks, reference_timestamp)
        audio_chunks = _select_audio_chunks(chunks, reference_timestamp)

        if not feedback_text and not audio_chunks:
            raise HTTPException(
                status_code=400,
                detail="No new feedback found since provided timestamp",
            )

        system_prompt = render_prompt(
            "revise_artifact",
            "en",
            {
                "transcript": conversation_transcript or "No transcript available.",
                "outcome": artifact.get("content") or "",
                "feedback": feedback_text or "No textual feedback available.",
            },
        )

        message_content: List[Dict[str, Any]] = [
            {
                "type": "text",
                "text": "Please revise the outcome using the feedback provided. Audio clips accompany segments without transcripts.",
            }
        ]

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
                except Exception as exc:  # pragma: no cover - logging side effect
                    logger.warning("Failed to attach audio chunk %s: %s", chunk_id, exc)

        revision_completion_kwargs = get_completion_kwargs(MODELS.MULTI_MODAL_PRO)

        try:
            response = litellm.completion(
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
                **revision_completion_kwargs,
            )
        except Exception as exc:  # pragma: no cover - external failure
            logger.error("Gemini revision failed: %s", exc, exc_info=True)
            raise HTTPException(
                status_code=500, detail="Failed to revise verification artifact"
            ) from exc

        generated_text = _extract_response_text(response)
        updates["content"] = generated_text
    elif body.content is not None:
        updates["content"] = body.content

    if not updates:
        raise HTTPException(status_code=400, detail="No valid fields to update")

    updated_artifact = await run_in_thread_pool(
        directus.update_item,
        "conversation_artifact",
        artifact_id,
        updates,
    )

    updated_data = updated_artifact.get("data", {})

    return ConversationArtifactResponse(
        id=updated_data.get("id", artifact_id),
        key=updated_data.get("key"),
        content=updated_data.get("content")
        or updates.get("content")
        or artifact.get("content")
        or "",
        conversation_id=updated_data.get("conversation_id") or conversation_id or "",
        approved_at=updated_data.get("approved_at") or updates.get("approved_at"),
        date_created=updated_data.get("date_created") or artifact.get("date_created"),
        read_aloud_stream_url=updated_data.get("read_aloud_stream_url")
        or artifact.get("read_aloud_stream_url")
        or "",
    )
