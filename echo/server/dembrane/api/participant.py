from typing import List, Optional, Annotated
from logging import getLogger
from datetime import datetime

from fastapi import Form, APIRouter, UploadFile, HTTPException
from pydantic import BaseModel

from dembrane.schemas import (
    ProjectTagSchema,
)
from dembrane.service import project_service, conversation_service
from dembrane.directus import directus
from dembrane.service.project import ProjectNotFoundException
from dembrane.service.conversation import (
    ConversationNotFoundException,
    ConversationNotOpenForParticipationException,
)

logger = getLogger("api.participant")

ParticipantRouter = APIRouter(tags=["participant"])


class PublicProjectTagSchema(BaseModel):
    id: str
    text: str


class PublicProjectSchema(BaseModel):
    id: str
    language: str

    tags: Optional[List[PublicProjectTagSchema]] = []

    is_conversation_allowed: bool
    is_get_reply_enabled: bool

    # onboarding
    default_conversation_tutorial_slug: Optional[str] = None
    conversation_ask_for_participant_name_label: Optional[str] = None
    default_conversation_ask_for_participant_name: Optional[bool] = True

    # portal content
    default_conversation_title: Optional[str] = None
    default_conversation_description: Optional[str] = None
    default_conversation_finish_text: Optional[str] = None


class PublicConversationChunkSchema(BaseModel):
    id: str
    conversation_id: str
    path: Optional[str] = None
    transcript: Optional[str] = None
    timestamp: datetime
    source: str


class PublicConversationSchema(BaseModel):
    id: str
    project_id: str

    title: Optional[str] = None
    description: Optional[str] = None

    participant_email: Optional[str] = None
    participant_name: Optional[str] = None


class InitiateConversationRequestBodySchema(BaseModel):
    name: str
    pin: str  # FIXME: not used
    conversation_id: Optional[str] = None
    email: Optional[str] = None
    user_agent: Optional[str] = None
    tag_id_list: Optional[List[str]] = []
    source: Optional[str] = None


@ParticipantRouter.post(
    "/projects/{project_id}/conversations/initiate",
    tags=["conversation"],
    response_model=PublicConversationSchema,
)
async def initiate_conversation(
    body: InitiateConversationRequestBodySchema,
    project_id: str,
) -> dict:
    try:
        conversation = conversation_service.create(
            project_id=project_id,
            participant_name=body.name,
            participant_email=body.email,
            participant_user_agent=body.user_agent,
            project_tag_id_list=body.tag_id_list,
            source=body.source,
        )

        return conversation
    except ConversationNotOpenForParticipationException as e:
        raise HTTPException(
            status_code=403, detail="Conversation not open for participation"
        ) from e


@ParticipantRouter.get("/projects/{project_id}", response_model=PublicProjectSchema)
async def get_project(
    project_id: str,
) -> dict:
    try:
        project = project_service.get_by_id_or_raise(project_id, with_tags=True)

        if project.get("is_conversation_allowed", False) is False:
            raise HTTPException(status_code=403, detail="Conversation not open for participation")

        return project

    except ProjectNotFoundException as e:
        raise HTTPException(status_code=404, detail="Project not found") from e


@ParticipantRouter.get(
    "/projects/{project_id}/conversations/{conversation_id}",
    response_model=PublicConversationSchema,
)
async def get_conversation(
    project_id: str,
    conversation_id: str,
) -> dict:
    try:
        project = project_service.get_by_id_or_raise(project_id)
        conversation = conversation_service.get_by_id_or_raise(conversation_id, with_tags=True)

        if project.get("is_conversation_allowed", False) is False:
            raise HTTPException(status_code=403, detail="Conversation not open for participation")

        return conversation
    except (ProjectNotFoundException, ConversationNotFoundException) as e:
        raise HTTPException(status_code=404, detail="Conversation not found") from e


@ParticipantRouter.get(
    "/projects/{project_id}/conversations/{conversation_id}/chunks",
    response_model=List[PublicConversationChunkSchema],
)
async def get_conversation_chunks(
    project_id: str,
    conversation_id: str,
) -> List[dict]:
    try:
        project = project_service.get_by_id_or_raise(project_id)
        conversation = conversation_service.get_by_id_or_raise(conversation_id, with_chunks=True)

        if project.get("is_conversation_allowed", False) is False:
            raise HTTPException(status_code=403, detail="Conversation not open for participation")

        return conversation.get("chunks", [])
    except (ProjectNotFoundException, ConversationNotFoundException) as e:
        raise HTTPException(status_code=404, detail="Conversation not found") from e


@ParticipantRouter.delete(
    "/projects/{project_id}/conversations/{conversation_id}/chunks/{chunk_id}",
)
async def delete_conversation_chunk(
    project_id: str,
    conversation_id: str,
    chunk_id: str,
) -> None:
    try:
        conversation = conversation_service.get_by_id_or_raise(conversation_id)
    except ConversationNotFoundException as e:
        raise HTTPException(status_code=404, detail="Conversation not found") from e

    if project_id != conversation.get("project_id"):
        raise HTTPException(status_code=404, detail="Conversation not found")

    conversation_service.delete_chunk(chunk_id)

    return


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
) -> dict:
    try:
        chunk = conversation_service.create_chunk(
            conversation_id=conversation_id,
            timestamp=body.timestamp,
            transcript=body.content,
            source=body.source or "PORTAL_TEXT",
        )

        return chunk

    except ConversationNotOpenForParticipationException as e:
        raise HTTPException(
            status_code=403, detail="Conversation not open for participation"
        ) from e


@ParticipantRouter.post(
    "/conversations/{conversation_id}/upload-chunk",
    response_model=PublicConversationChunkSchema,
)
async def upload_conversation_chunk(
    conversation_id: str,
    chunk: UploadFile,
    timestamp: Annotated[datetime, Form()],
    source: Annotated[str, Form()] = "PORTAL_AUDIO",
    run_finish_hook: Annotated[bool, Form()] = True,
) -> dict:
    logger.warning("UNUSED: run_finish_hook: %s", run_finish_hook)
    try:
        return conversation_service.create_chunk(
            conversation_id=conversation_id,
            timestamp=timestamp,
            source=source,
            file_obj=chunk,
        )
    except ConversationNotOpenForParticipationException as e:
        raise HTTPException(
            status_code=403, detail="Conversation not open for participation"
        ) from e


@ParticipantRouter.post(
    "/conversations/{conversation_id}/finish",
)
async def run_when_conversation_is_finished(
    conversation_id: str,
) -> str:
    # Import locally to avoid circular imports
    from dembrane.tasks import task_finish_conversation_hook

    task_finish_conversation_hook.send(conversation_id)
    return "OK"


class UnsubscribeParticipantRequest(BaseModel):
    token: str
    email_opt_in: bool


class CheckParticipantRequest(BaseModel):
    email: str
    project_id: str


class NotificationSubscriptionRequest(BaseModel):
    emails: List[str]
    project_id: str
    conversation_id: str


@ParticipantRouter.post("/report/subscribe")
async def subscribe_notifications(data: NotificationSubscriptionRequest) -> dict:
    """
    Subscribe multiple users to project notifications.
    - Skips existing entries that were previously opted-in.
    - Creates a fresh record with email_opt_in = true.
    """
    failed_emails = []

    for email in data.emails:
        try:
            # normalize email
            email = email.lower()

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
                {
                    "email": email,
                    "project_id": data.project_id,
                    "email_opt_in": True,
                    "conversation_id": data.conversation_id,
                },
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


@ParticipantRouter.post("/{project_id}/report/unsubscribe")
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
                {"email_opt_in": payload.email_opt_in},
            )

        return {"success": True}

    except Exception as e:
        logger.error(f"Error updating project contacts: {str(e)}")
        raise HTTPException(status_code=500, detail="Internal Server Error")  # noqa: B904


@ParticipantRouter.get("/report/unsubscribe/eligibility")
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
