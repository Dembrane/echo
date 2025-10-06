import asyncio
from time import time
from typing import List, Optional, Annotated
from logging import getLogger
from datetime import datetime

from fastapi import Form, APIRouter, UploadFile, HTTPException
from pydantic import BaseModel

from dembrane.s3 import get_sanitized_s3_key, get_file_size_bytes_from_s3
from dembrane.utils import generate_uuid
from dembrane.config import STORAGE_S3_BUCKET, STORAGE_S3_ENDPOINT
from dembrane.service import project_service, conversation_service
from dembrane.directus import directus
from dembrane.service.project import ProjectNotFoundException
from dembrane.service.conversation import (
    ConversationServiceException,
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
    is_project_notification_subscription_allowed: bool

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


class GetUploadUrlRequest(BaseModel):
    filename: str
    content_type: str
    conversation_id: str


class ConfirmUploadRequest(BaseModel):
    chunk_id: str
    file_url: str
    timestamp: datetime
    source: str = "PORTAL_AUDIO"


# Simple in-memory rate limiter
# NOTE: This is process-local and won't be shared across workers/pods.
# With API_WORKERS=2 and horizontal scaling, the effective limit becomes
# 10 × workers × pods instead of strict 10 req/min.
# 
# DECISION (2025-10-03): We accept this risk because:
# - Users are authenticated municipal employees (paid customers)
# - Normal usage: 6-10 req/min (well under distributed limit)
# - Still catches frontend bugs and accidental infinite loops
# - Can upgrade to Redis-based rate limiting (slowap) if abuse is detected

_rate_limit_cache: dict[str, list[float]] = {}
_RATE_LIMIT_WINDOW = 60  # 1 minute
_RATE_LIMIT_MAX_REQUESTS = 10  # 10 requests per minute per conversation


def check_rate_limit(conversation_id: str) -> bool:
    """
    Check if conversation has exceeded rate limit for presigned URL generation.
    Returns True if within limit, False if exceeded.
    """
    now = time()
    
    # Clean old entries
    if conversation_id in _rate_limit_cache:
        _rate_limit_cache[conversation_id] = [
            t for t in _rate_limit_cache[conversation_id] 
            if now - t < _RATE_LIMIT_WINDOW
        ]
    else:
        _rate_limit_cache[conversation_id] = []
    
    # Check limit
    if len(_rate_limit_cache[conversation_id]) >= _RATE_LIMIT_MAX_REQUESTS:
        return False
    
    # Add current request
    _rate_limit_cache[conversation_id].append(now)
    return True


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

    except ConversationServiceException as e:
        raise HTTPException(
            status_code=400, detail=str(e)
        ) from e
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
) -> dict:
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
    "/conversations/{conversation_id}/get-upload-url",
    response_model=dict,
)
async def get_chunk_upload_url(
    conversation_id: str,
    body: GetUploadUrlRequest,
) -> dict:
    """
    Generate a presigned URL for direct S3 upload.
    
    This endpoint is fast (<100ms) as it only generates a URL,
    no file transfer happens through the API.
    
    Rate limit: 10 requests per minute per conversation.
    """
    logger.info(f"Presigned URL requested for conversation {conversation_id}, filename: {body.filename}")
    
    try:
        # Rate limiting
        if not check_rate_limit(conversation_id):
            logger.warning(f"Rate limit exceeded for conversation {conversation_id}")
            raise HTTPException(
                status_code=429,
                detail="Too many upload requests. Please wait before uploading more files."
            )
        
        # Verify conversation exists and is open
        conversation = conversation_service.get_by_id_or_raise(conversation_id)
        project = project_service.get_by_id_or_raise(conversation["project_id"])
        
        if not project.get("is_conversation_allowed", False):
            logger.warning(f"Conversation {conversation_id} not open for participation")
            raise HTTPException(
                status_code=403, 
                detail="Conversation not open for participation"
            )
        
        # Generate chunk ID
        chunk_id = generate_uuid()
        
        # Sanitize filename to prevent path traversal
        safe_filename = get_sanitized_s3_key(body.filename)
        
        # Create S3 key with sanitized filename
        file_key = f"conversation/{conversation_id}/chunks/{chunk_id}-{safe_filename}"
        
        logger.info(f"Generated S3 key: {file_key}")
        
        # Generate presigned POST
        from dembrane.s3 import generate_presigned_post
        
        presigned_data = generate_presigned_post(
            file_name=file_key,
            content_type=body.content_type,
            size_limit_mb=2048,  # 2GB limit
            expires_in_seconds=3600,  # 1 hour
        )
        
        # Construct final file URL
        file_url = f"{STORAGE_S3_ENDPOINT}/{STORAGE_S3_BUCKET}/{file_key}"
        
        logger.info(f"Presigned URL generated successfully for chunk {chunk_id}")
        
        return {
            "chunk_id": chunk_id,
            "upload_url": presigned_data["url"],
            "fields": presigned_data["fields"],
            "file_url": file_url,
        }
        
    except ConversationNotFoundException as e:
        logger.error(f"Conversation not found: {conversation_id}")
        raise HTTPException(status_code=404, detail="Conversation not found") from e
    except ConversationNotOpenForParticipationException as e:
        logger.error(f"Conversation not open: {conversation_id}")
        raise HTTPException(
            status_code=403, 
            detail="Conversation not open for participation"
        ) from e
    except Exception as e:
        logger.error(f"Error generating presigned URL: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail="Failed to generate upload URL"
        ) from e


@ParticipantRouter.post(
    "/conversations/{conversation_id}/confirm-upload",
    response_model=PublicConversationChunkSchema,
)
async def confirm_chunk_upload(
    conversation_id: str,
    body: ConfirmUploadRequest,
) -> dict:
    """
    Confirm that a file upload completed and create the chunk record.
    
    This should be called after the client successfully uploads to S3
    using the presigned URL.
    
    Includes retry logic for S3 eventual consistency.
    """
    logger.info(f"Confirming upload for chunk {body.chunk_id}, conversation {conversation_id}")
    
    try:
        # Verify file exists in S3 with retry logic (eventual consistency)
        file_key = get_sanitized_s3_key(body.file_url)
        file_size = None
        max_retries = 3
        retry_delays = [0.1, 0.5, 2.0]  # 100ms, 500ms, 2s
        
        for attempt in range(max_retries):
            try:
                file_size = get_file_size_bytes_from_s3(file_key)
                logger.info(f"File verified in S3: {file_key}, size: {file_size} bytes, attempt: {attempt + 1}")
                break
            except Exception as e:
                if attempt < max_retries - 1:
                    delay = retry_delays[attempt]
                    logger.warning(
                        f"File not yet available in S3 (attempt {attempt + 1}/{max_retries}): {file_key}. "
                        f"Retrying in {delay}s. Error: {e}"
                    )
                    await asyncio.sleep(delay)
                else:
                    logger.error(
                        f"File not found in S3 after {max_retries} attempts: {file_key}. "
                        f"Upload may have failed or S3 is experiencing issues. Error: {e}",
                        exc_info=True
                    )
                    raise HTTPException(
                        status_code=400,
                        detail="File not found in S3. Upload may have failed. Please try again."
                    ) from e
        
        # Create chunk record (reuse existing logic)
        chunk = conversation_service.create_chunk(
            conversation_id=conversation_id,
            timestamp=body.timestamp,
            source=body.source,
            file_obj=None,  # No file object - already in S3
            file_url=body.file_url,  # Use the S3 URL directly
            transcript=None,
        )
        
        logger.info(
            f"Chunk created successfully: {body.chunk_id}, "
            f"conversation: {conversation_id}, size: {file_size} bytes"
        )
        
        return chunk
        
    except ConversationNotOpenForParticipationException as e:
        logger.error(f"Conversation not open for participation: {conversation_id}")
        raise HTTPException(
            status_code=403, 
            detail="Conversation not open for participation"
        ) from e
    except ConversationNotFoundException as e:
        logger.error(f"Conversation not found while confirming upload: {conversation_id}")
        raise HTTPException(status_code=404, detail="Conversation not found") from e
    except ConversationServiceException as e:
        logger.error(f"Failed to create chunk: {e}")
        raise HTTPException(
            status_code=400,
            detail=str(e)
        ) from e
    except HTTPException:
        # Re-raise HTTP exceptions as-is
        raise
    except Exception as e:
        logger.error(f"Error confirming upload: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail="Failed to confirm upload"
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
