from typing import List, Optional, Annotated
from logging import getLogger
from datetime import datetime

from fastapi import Form, APIRouter, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import joinedload

from dembrane.s3 import save_to_s3_from_file_like
from dembrane.tasks import task_finish_conversation_hook, task_process_conversation_chunk
from dembrane.utils import generate_uuid
from dembrane.schemas import (
    ProjectTagSchema,
    ConversationChunkSchema,
)
from dembrane.database import (
    ProjectModel,
    ProjectTagModel,
    ConversationModel,
    ConversationChunkModel,
    DependencyInjectDatabase,
)
from dembrane.directus import directus
from dembrane.api.exceptions import (
    ProjectNotFoundException,
    ConversationNotFoundException,
    ConversationInvalidPinException,
    ConversationNotOpenForParticipationException,
)

logger = getLogger("api.participant")

ParticipantRouter = APIRouter(tags=["participant"])


class PublicProjectSchema(BaseModel):
    id: str
    language: str
    pin: str

    tags: Optional[List[ProjectTagSchema]] = []

    is_conversation_allowed: bool
    default_conversation_title: Optional[str] = None
    default_conversation_description: Optional[str] = None
    default_conversation_finish_text: Optional[str] = None


class PublicConversationChunkSchema(BaseModel):
    id: str
    conversation_id: str
    transcript: Optional[str] = None
    timestamp: datetime


class PublicConversationSchema(BaseModel):
    id: str
    project_id: str

    title: Optional[str] = None
    description: Optional[str] = None

    participant_email: Optional[str] = None
    participant_name: Optional[str] = None

    tags: Optional[List[ProjectTagSchema]] = []
    chunks: Optional[List[ConversationChunkSchema]] = []  # noqa: F821


class InitiateConversationRequestBodySchema(BaseModel):
    name: str
    pin: str
    conversation_id: Optional[str] = None
    email: Optional[str] = None
    user_agent: Optional[str] = None
    tag_id_list: Optional[List[str]] = []


@ParticipantRouter.post(
    "/projects/{project_id}/conversations/initiate",
    response_model=PublicConversationSchema,
    tags=["conversation"],
)
async def initiate_conversation(
    body: InitiateConversationRequestBodySchema,
    project_id: str,
    db: DependencyInjectDatabase,
) -> ConversationModel:
    project = db.query(ProjectModel).filter(ProjectModel.id == project_id).first()

    if not project or project.pin != body.pin:
        raise ConversationInvalidPinException

    if project.is_conversation_allowed is False:
        raise ConversationNotOpenForParticipationException

    if body.conversation_id:
        conversation = (
            db.query(ConversationModel)
            .filter(
                ConversationModel.project_id == project.id,
                ConversationModel.id == body.conversation_id,
            )
            .first()
        )

        # Rejoin a conversation
        if conversation:
            logger.info(f"Conversation already exists: {conversation.id}")

            conversation.participant_name = body.name
            if body.user_agent:
                conversation.participant_user_agent = body.user_agent
            if body.email:
                conversation.participant_email = body.email

            if body.tag_id_list is not None and len(body.tag_id_list) > 0:
                tags = (
                    db.query(ProjectTagModel).filter(ProjectTagModel.id.in_(body.tag_id_list)).all()
                )
                conversation.tags = tags

            db.commit()
            return conversation

    # Create a new conversation
    new_conversation = ConversationModel(
        id=generate_uuid(),
        project_id=project.id,
        participant_name=body.name,
        participant_email=body.email if body.email else None,
        participant_user_agent=body.user_agent if body.user_agent else None,
    )

    if body.tag_id_list is not None and len(body.tag_id_list) > 0:
        tags = db.query(ProjectTagModel).filter(ProjectTagModel.id.in_(body.tag_id_list)).all()
        new_conversation.tags = tags

    db.add(new_conversation)
    db.commit()

    return new_conversation


@ParticipantRouter.get("/projects/{project_id}", response_model=PublicProjectSchema)
async def get_project(
    project_id: str,
    db: DependencyInjectDatabase,
) -> ProjectModel:
    project = (
        db.query(ProjectModel)
        .options(joinedload(ProjectModel.tags))
        .filter(
            ProjectModel.id == project_id,
        )
        .first()
    )
    if not project:
        raise ProjectNotFoundException

    return project


@ParticipantRouter.get(
    "/projects/{project_id}/conversations/{conversation_id}",
    response_model=PublicConversationSchema,
)
async def get_conversation(
    project_id: str,
    conversation_id: str,
    db: DependencyInjectDatabase,
) -> ConversationModel:
    conversation = (
        db.query(ConversationModel)
        .options(joinedload(ConversationModel.tags))
        .filter(
            ConversationModel.project_id == project_id,
            ConversationModel.id == conversation_id,
        )
        .first()
    )

    if not conversation:
        raise ConversationNotFoundException

    return conversation


@ParticipantRouter.get(
    "/projects/{project_id}/conversations/{conversation_id}/chunks",
    response_model=List[PublicConversationChunkSchema],
)
async def get_conversation_chunks(
    project_id: str,
    conversation_id: str,
    db: DependencyInjectDatabase,
) -> List[ConversationChunkModel]:
    project = db.get(ProjectModel, project_id)

    if not project:
        raise ConversationNotFoundException

    conversation = db.get(ConversationModel, conversation_id)

    if not conversation or conversation.project_id != project.id:
        raise ConversationNotFoundException

    chunks = (
        db.query(ConversationChunkModel)
        .filter(ConversationChunkModel.conversation_id == conversation_id)
        .order_by(ConversationChunkModel.timestamp)
        .all()
    )

    return chunks


@ParticipantRouter.delete(
    "/projects/{project_id}/conversations/{conversation_id}/chunks/{chunk_id}",
    response_model=PublicConversationChunkSchema,
)
async def delete_conversation_chunk(
    project_id: str,
    conversation_id: str,
    chunk_id: str,
    db: DependencyInjectDatabase,
) -> ConversationChunkModel:
    conversation = db.get(ConversationModel, conversation_id)

    if not conversation or conversation.project_id != project_id:
        raise ConversationNotFoundException

    chunk = db.get(ConversationChunkModel, chunk_id)

    if not chunk or chunk.conversation_id != conversation_id:
        raise ConversationNotFoundException

    db.delete(chunk)
    db.commit()

    return chunk


class UploadConversationBodySchema(BaseModel):
    timestamp: datetime
    content: str


@ParticipantRouter.post(
    "/conversations/{conversation_id}/upload-text", response_model=PublicConversationChunkSchema
)
async def upload_conversation_text(
    conversation_id: str,
    body: UploadConversationBodySchema,
) -> ConversationChunkModel:
    conversation = directus.get_items(
        "conversation",
        {
            "query": {
                "filter": {"id": {"_eq": conversation_id}},
                "fields": ["id"],
            },
        },
    )

    if not conversation or len(conversation) == 0:
        raise ConversationNotFoundException

    conversation = conversation[0]

    chunk = directus.create_item(
        "conversation_chunk",
        item_data={
            "conversation_id": conversation["id"],
            "timestamp": str(body.timestamp.utcnow()),
            "transcript": body.content,
            "path": None,
            "type": "text",
        },
    )["data"]

    return chunk


@ParticipantRouter.post(
    "/conversations/{conversation_id}/upload-chunk",
    response_model=List[PublicConversationChunkSchema],
)
async def upload_conversation_chunk(
    conversation_id: str,
    chunk: UploadFile,
    timestamp: Annotated[datetime, Form()],
    type: Annotated[str, Form()] = "audio_chunk",
) -> List[dict]:
    conversation = directus.get_items(
        "conversation",
        {
            "query": {
                "filter": {"id": {"_eq": conversation_id}},
                "fields": ["id"],
            },
        },
    )
    logger.debug(f"Conversation: {conversation}")

    if not conversation or len(conversation) == 0:
        raise ConversationNotFoundException

    conversation = conversation[0]

    chunk_id = generate_uuid()

    file_name = f"audio-chunks/{conversation['id']}-{chunk_id}-{chunk.filename}"

    uploaded_file_url = save_to_s3_from_file_like(file_obj=chunk, file_name=file_name, public=False)

    chunk_created = directus.create_item(
        "conversation_chunk",
        item_data={
            "conversation_id": conversation["id"],
            "timestamp": str(timestamp.utcnow()),
            "path": uploaded_file_url,
            "type": type,
            "id": chunk_id,
        },
    )["data"]

    logger.info(f"Add to processing queue: ConversationChunk@{chunk_created['id']}")
    task_process_conversation_chunk.delay(chunk_created["id"])

    return [chunk_created]


@ParticipantRouter.post(
    "/conversations/{conversation_id}/finish",
)
async def run_when_conversation_is_finished(
    conversation_id: str,
) -> str:
    task_finish_conversation_hook.delay(conversation_id)
    return "OK"
