from typing import List, Optional, Annotated
from logging import getLogger
from datetime import datetime

from fastapi import Form, APIRouter, UploadFile, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import joinedload

from dembrane.s3 import save_to_s3_from_file_like
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
from dembrane.processing_status_utils import ProcessingStatus

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
    source: Optional[str] = "PORTAL_AUDIO"

class UnsubscribeParticipantRequest(BaseModel):
    token: str
    email_opt_in: bool

class CheckParticipantRequest(BaseModel):
    email: str
    project_id: str

class NotificationSubscriptionRequest(BaseModel):
    emails: List[str]
    project_id: str

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
            if body.source:
                conversation.source = body.source

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
        source=body.source,
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
    source: Optional[str] = "PORTAL_TEXT"


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

    source = body.source or "PORTAL_TEXT"

    chunk = directus.create_item(
        "conversation_chunk",
        item_data={
            "conversation_id": conversation["id"],
            "timestamp": str(body.timestamp.utcnow()),
            "transcript": body.content,
            "source": source,
            "path": None,
        },
    )["data"]

    return chunk


@ParticipantRouter.post(
    "/conversations/{conversation_id}/upload-chunk",
)
async def upload_conversation_chunk(
    conversation_id: str,
    chunk: UploadFile,
    timestamp: Annotated[datetime, Form()],
    source: Annotated[str, Form()] = "PORTAL_AUDIO",
    run_finish_hook: Annotated[bool, Form()] = False,
) -> list[str]:
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
            "timestamp": timestamp.isoformat(),
            "path": uploaded_file_url,
            "id": chunk_id,
            "source": source,
            "processing_status": ProcessingStatus.PENDING.value,
            "processing_message": "Waiting to be transcribed",
        },
    )["data"]

    # Import locally to avoid circular imports
    from dembrane.tasks import task_process_conversation_chunk

    logger.info(
        f"adding task to process conversation chunk {chunk_id}, run_finish_hook: {run_finish_hook}"
    )
    task_process_conversation_chunk.delay(chunk_id, run_finish_hook)

    return [chunk_created["id"]]


@ParticipantRouter.post(
    "/conversations/{conversation_id}/finish",
)
async def run_when_conversation_is_finished(
    conversation_id: str,
) -> str:
    # Import locally to avoid circular imports
    from dembrane.tasks import task_finish_conversation_hook

    task_finish_conversation_hook.delay(conversation_id)
    return "OK"

@ParticipantRouter.patch("/{project_id}/unsubscribe-participant")
async def unsubscribe_participant(
    project_id: str,
    payload: UnsubscribeParticipantRequest,
) -> dict:
    """
    Update email_opt_in for project contacts in Directus securely.
    """
    try:
        # Fetch relevant IDs
        submissions = directus.get_items(
            "project_report_notification_participants",
            {
                "query": {
                    "filter": {
                        "_and": [
                            {"project_id": {"_eq": project_id}},
                            {"email_opt_out_token": {"_eq": payload.token}},
                        ]
                    },
                    "fields": ["id"],
                },
            },
        )
        
        if not submissions or len(submissions) == 0:
            raise HTTPException(status_code=404, detail="No data found")

        ids = [item["id"] for item in submissions]

        # Update email_opt_in status for fetched IDs
        for item_id in ids:
            directus.update_item(
                "project_report_notification_participants", 
                item_id, 
                {"email_opt_in": payload.email_opt_in}
            )
        
        return {"success": True}
    
    except Exception as e:
        logger.error(f"Error updating project contacts: {str(e)}")
        raise HTTPException(status_code=500, detail="Internal Server Error")  # noqa: B904

@ParticipantRouter.post("/check-subscription")
async def check_participant_subscription(payload: CheckParticipantRequest) -> dict:
    """
    Securely check if a participant is subscribed to project notifications.
    """
    logger.debug(f"Checking subscription for {payload.email} in project {payload.project_id}")
    try:
        submissions = directus.get_items(
            "project_report_notification_participants",
            {
                "query": {
                    "filter": {
                        "_and": [
                            {"project_id": {"_eq": payload.project_id}},
                            {"email": {"_eq": payload.email}},
                        ]
                    },
                    "fields": ["email_opt_in"],
                    "limit": 1,
                }
            },
        )

        # participant is new
        if not submissions or len(submissions) == 0:
            return {"eligible": True}

        # participant is opted out
        entry = submissions[0]
        if entry.get("email_opt_in") is False:
            return {"eligible": True}

        # participant is subscribed
        return {"eligible": False}

    except Exception as e:
        logger.error(f"Error checking subscription: {str(e)}")
        raise HTTPException(status_code=500, detail="Internal Server Error")  # noqa: B904


@ParticipantRouter.post("/subscribe-report")
async def subscribe_notifications(data: NotificationSubscriptionRequest) -> dict:
    """
    Subscribe multiple users to project notifications.
    - Skips existing entries that were previously opted-in.
    - Creates a fresh record with email_opt_in = true.
    """
    failed_emails = []

    for email in data.emails:
        try:
            # Check if user already exists
            existing = directus.get_items(
                "project_report_notification_participants",
                {
                    "query": {
                        "filter": {
                            "_and": [
                                {"email": {"_eq": email}},
                                {"project_id": {"_eq": data.project_id}},
                            ]
                        },
                        "limit": 1,
                    }
                },
            )

            if existing:
                participant = existing[0]
                if participant.get("email_opt_in") is True:
                    continue  # Already opted in — skip
                else:
                    # Delete old entry
                    directus.delete_item(
                        "project_report_notification_participants", participant["id"]
                    )

            # Create new entry with opt-in
            directus.create_item(
                "project_report_notification_participants",
                {"email": email, "project_id": data.project_id, "email_opt_in": True},
            )

        except Exception as e:
            logger.error(f"Error processing {email}: {e}")
            failed_emails.append(email)

    if failed_emails:
        raise HTTPException(
            status_code=400,
            detail={"message": "Some emails failed to process", "failed": failed_emails},
        )

    return {"status": "success"}


@ParticipantRouter.get("/check-unsubscribe-eligibility")
async def check_unsubscribe_eligibility(
    token: str,
    project_id: str,
) -> dict:
    """
    Validates whether the given token is eligible to unsubscribe.
    """
    if not token or not project_id:
        raise HTTPException(status_code=400, detail="Invalid or missing unsubscribe link.")

    submissions = directus.get_items(
        "project_report_notification_participants",
        {
            "query": {
                "filter": {
                    "_and": [
                        {"project_id": {"_eq": project_id}},
                        {"email_opt_out_token": {"_eq": token}},
                    ]
                },
                "fields": ["id", "email_opt_in"],
                "limit": 1,
            }
        },
    )

    if not submissions or len(submissions) == 0 or not submissions[0].get("email_opt_in"):
        return {"data": {"eligible": False}}

    return {"data": {"eligible": True}}
