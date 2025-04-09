import json
from typing import List, Optional, AsyncGenerator
from logging import getLogger

from fastapi import APIRouter
from pydantic import BaseModel
from sqlalchemy.orm import noload, selectinload
from fastapi.responses import RedirectResponse, StreamingResponse
from fastapi.exceptions import HTTPException

from dembrane.s3 import get_signed_url
from dembrane.utils import CacheWithExpiration, generate_uuid, get_utc_timestamp
from dembrane.database import (
    ConversationModel,
    ConversationChunkModel,
    DependencyInjectDatabase,
)
from dembrane.directus import directus
from dembrane.audio_utils import (
    get_duration_from_s3,
    merge_multiple_audio_files_and_save_to_s3,
)
from dembrane.quote_utils import count_tokens
from dembrane.reply_utils import generate_reply_for_conversation
from dembrane.api.stateless import generate_summary
from dembrane.api.exceptions import (
    NoContentFoundException,
    ConversationNotFoundException,
)
from dembrane.api.dependency_auth import DependencyDirectusSession
from dembrane.processing_status_utils import ProcessingStatus

logger = getLogger("api.conversation")
ConversationRouter = APIRouter(tags=["conversation"])


async def get_conversation(
    conversation_id: str, db: DependencyInjectDatabase, load_chunks: Optional[bool] = True
) -> ConversationModel:
    if load_chunks:
        conversation = (
            db.query(ConversationModel)
            .options(
                selectinload(ConversationModel.tags),
                selectinload(ConversationModel.chunks),
            )
            .filter(
                ConversationModel.id == conversation_id,
            )
            .first()
        )
    else:
        conversation = (
            db.query(ConversationModel)
            .options(
                noload(ConversationModel.chunks),
                selectinload(ConversationModel.tags),
            )
            .filter(
                ConversationModel.id == conversation_id,
            )
            .first()
        )

    if not conversation:
        raise ConversationNotFoundException

    return conversation


async def get_conversation_chunks(
    conversation_id: str, db: DependencyInjectDatabase
) -> List[ConversationChunkModel]:
    conversation = await get_conversation(conversation_id, db, load_chunks=False)

    chunks = (
        db.query(ConversationChunkModel)
        .filter(
            ConversationChunkModel.conversation_id == conversation.id,
        )
        .order_by(ConversationChunkModel.timestamp)
        .all()
    )

    return chunks


def raise_if_conversation_not_found_or_not_authorized(
    conversation_id: str, auth: DependencyDirectusSession
) -> None:
    conversation = directus.get_items(
        "conversation",
        {
            "query": {
                "filter": {"id": {"_eq": conversation_id}},
                "fields": ["project_id.directus_user_id"],
            }
        },
    )

    if conversation is None or len(conversation) == 0:
        raise HTTPException(status_code=404, detail="Conversation not found")

    if not auth.is_admin and conversation[0]["project_id"]["directus_user_id"] != auth.user_id:
        raise HTTPException(
            status_code=403, detail="You are not authorized to access this conversation"
        )


def return_url_or_redirect(
    url: str, signed: bool, return_url: bool
) -> StreamingResponse | RedirectResponse | str:
    revised_url = get_signed_url(url)
    if revised_url.startswith("http://minio:9000"):
        logger.warning(
            "Merged audio path is using minio:9000, trying to replace with localhost:9000"
        )
        revised_url = revised_url.replace("http://minio:9000", "http://localhost:9000")

    if return_url:
        if not signed:
            return url
        return revised_url

    return RedirectResponse(revised_url)


@ConversationRouter.get("/{conversation_id}/content", response_model=None)
def get_conversation_content(
    conversation_id: str,
    auth: DependencyDirectusSession,
    force_merge: bool = False,
    return_url: bool = False,
    signed: bool = True,
) -> StreamingResponse | RedirectResponse | str:
    raise_if_conversation_not_found_or_not_authorized(conversation_id, auth)

    logger.debug(
        f"Getting content for conversation {conversation_id}, force_merge={force_merge}, return_url={return_url}"
    )

    # First, get all conversation chunks with more information for debugging
    chunks = directus.get_items(
        "conversation_chunk",
        {
            "query": {
                "filter": {"conversation_id": {"_eq": conversation_id}},
                "sort": "timestamp",
                "fields": ["id", "path", "timestamp"],
                "limit": 1000,
            },
        },
    )

    if not chunks:
        logger.error(f"No chunks found for conversation {conversation_id}")
        raise ConversationNotFoundException

    logger.debug(f"Found {len(chunks)} total chunks for conversation {conversation_id}")

    conversations = directus.get_items(
        "conversation",
        {
            "query": {
                "filter": {"id": {"_eq": conversation_id}},
                "fields": ["merged_audio_path"],
            },
        },
    )

    if not conversations or len(conversations) == 0:
        raise ConversationNotFoundException

    conversation = conversations[0]

    # if we already have a merged audio path, use that
    if (
        not force_merge
        and conversation["merged_audio_path"]
        and conversation["merged_audio_path"].startswith("http")
    ):
        return return_url_or_redirect(
            conversation["merged_audio_path"], signed=signed, return_url=return_url
        )

    # Get all valid file paths and ensure they're proper strings
    file_paths = []
    for chunk in chunks:
        if (
            "path" in chunk
            and chunk["path"]
            and isinstance(chunk["path"], str)
            and chunk["path"].startswith("http")
        ):
            logger.debug(f"adding valid path: {chunk['path']}")
            file_paths.append(chunk["path"])
        else:
            logger.debug(f"skipping chunk with invalid path: {chunk['path']}")

    # Check if we have any valid file paths to merge
    if len(file_paths) == 0:
        logger.error(
            f"No valid file paths found for conversation {conversation_id} after filtering {len(chunks)} chunks"
        )
        raise NoContentFoundException

    logger.debug(
        f"Found {len(file_paths)} valid audio paths to merge for conversation {conversation_id}"
    )

    logger.debug(f"Merging {len(file_paths)} audio files for conversation {conversation_id}")

    try:
        uuid = generate_uuid()

        merged_path = merge_multiple_audio_files_and_save_to_s3(
            file_paths, f"audio-conversations/merged-{conversation_id}-{uuid}.mp3", "mp3"
        )

        logger.debug(f"Successfully merged audio to: {merged_path}")

        duration = -1.0
        try:
            duration = get_duration_from_s3(merged_path)
        except Exception as e:
            logger.error(f"Error getting duration from s3: {str(e)}")

        directus.update_item(
            "conversation",
            conversation_id,
            {
                "merged_audio_path": merged_path,
                "duration": duration,
            },
        )

        return return_url_or_redirect(merged_path, signed=signed, return_url=return_url)

    except Exception as e:
        logger.error(f"Error merging audio files: {str(e)}")
        raise HTTPException(status_code=400, detail=f"Failed to merge audio files: {str(e)}") from e

    raise HTTPException(
        status_code=400,
        detail="Error merging audio files because no valid paths were found",
    )


@ConversationRouter.get("/{conversation_id}/chunks/{chunk_id}/content", response_model=None)
async def get_conversation_chunk_content(
    conversation_id: str,
    chunk_id: str,
    auth: DependencyDirectusSession,
    return_url: bool = False,
    signed: bool = True,
) -> StreamingResponse | RedirectResponse | str:
    raise_if_conversation_not_found_or_not_authorized(conversation_id, auth)

    chunks = directus.get_items(
        "conversation_chunk",
        {
            "query": {
                "filter": {"id": {"_eq": chunk_id}, "conversation_id": {"_eq": conversation_id}},
                "fields": ["path"],
            }
        },
    )

    if not chunks or len(chunks) == 0:
        raise ConversationNotFoundException

    chunk = chunks[0]

    if not chunk["path"]:
        raise NoContentFoundException

    logger.debug(f"Chunk path: {chunk['path']}")

    # If the chunk is a s3 URL, stream the audio from the URL
    if chunk["path"].startswith("http"):
        return return_url_or_redirect(chunk["path"], signed=signed, return_url=return_url)

    logger.error(f"File is not valid (URL type not implemented): {chunk['path']}")
    raise HTTPException(status_code=400, detail="File is not valid (URL type not implemented)")


@ConversationRouter.get("/{conversation_id}/transcript")
def get_conversation_transcript(
    conversation_id: str, auth: DependencyDirectusSession, include_project_data: bool = False
) -> str:
    raise_if_conversation_not_found_or_not_authorized(conversation_id, auth)

    if include_project_data:
        logger.warning("Not implemented yet")

    conversation_chunks = directus.get_items(
        "conversation_chunk",
        {
            "query": {
                "filter": {"conversation_id": {"_eq": conversation_id}},
                "fields": ["transcript"],
                "sort": "timestamp",
                "limit": 1500,
            },
        },
    )

    if not conversation_chunks or len(conversation_chunks) == 0:
        return ""

    transcript = []

    for chunk in conversation_chunks:
        logger.debug(f"Chunk transcript: {chunk['transcript']}")
        if chunk["transcript"]:
            transcript.append(chunk["transcript"])

    return "\n".join(transcript)


# Initialize the cache
token_count_cache = CacheWithExpiration(ttl=500)


@ConversationRouter.get("/{conversation_id}/token-count")
async def get_conversation_token_count(
    conversation_id: str,
    _db: DependencyInjectDatabase,
    auth: DependencyDirectusSession,
) -> int:
    raise_if_conversation_not_found_or_not_authorized(conversation_id, auth)

    # Try to get the token count from the cache
    cached_count = await token_count_cache.get(conversation_id)
    if cached_count is not None:
        return cached_count

    # If not in cache, calculate the token count
    transcript = get_conversation_transcript(conversation_id, auth)
    token_count = count_tokens(transcript, provider="anthropic")

    # Store the result in the cache
    await token_count_cache.set(conversation_id, token_count)

    return token_count


class GetReplyBodySchema(BaseModel):
    language: str


@ConversationRouter.post("/{conversation_id}/get-reply")
async def get_reply_for_conversation(
    conversation_id: str,
    body: GetReplyBodySchema,
) -> StreamingResponse:
    async def generate() -> AsyncGenerator[str, None]:
        # Stream content chunks
        async for chunk in generate_reply_for_conversation(conversation_id, body.language):
            yield "0:" + json.dumps(chunk) + "\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    )


@ConversationRouter.post("/{conversation_id}/summarize", response_model=None)
def summarize_conversation(
    conversation_id: str,
    auth: DependencyDirectusSession,
) -> dict:
    raise_if_conversation_not_found_or_not_authorized(conversation_id, auth)

    conversation_data = directus.get_items(
        "conversation",
        {
            "query": {
                "filter": {
                    "id": {"_eq": conversation_id},
                },
                "fields": ["id", "project_id.language"],
            },
        },
    )

    if not conversation_data or len(conversation_data) == 0:
        raise HTTPException(status_code=404, detail="Conversation not found")

    conversation_data = conversation_data[0]

    language = conversation_data["project_id"]["language"]

    transcript_str = get_conversation_transcript(conversation_id, auth, include_project_data=True)

    if transcript_str == "":
        return {
            "status": "success",
            "message": "Transcript is empty, so no summary was generated",
        }
    else:
        summary = generate_summary(transcript_str, language if language else "en")

        directus.update_item(
            "conversation",
            conversation_id,
            {
                "summary": summary,
            },
        )

        return {
            "status": "success",
            "message": "Summary generated",
            "summary": summary,
        }


class RetranscribeConversationBodySchema(BaseModel):
    new_conversation_name: str


@ConversationRouter.post("/{conversation_id}/retranscribe")
async def retranscribe_conversation(
    conversation_id: str,
    body: RetranscribeConversationBodySchema,
    auth: DependencyDirectusSession,
) -> dict:
    """
    Retranscribe an existing conversation.

    This function:
    1. Creates a new conversation based on the original one
    2. Creates a conversation chunk referencing the original audio
    3. Queues the transcription task

    Args:
        conversation_id: ID of the original conversation to retranscribe
        body: Contains new_conversation_name
        auth: Authentication session to verify ownership

    Returns:
        Dictionary with status info and the new conversation ID
    """
    try:
        # Check if the user owns the conversation
        raise_if_conversation_not_found_or_not_authorized(conversation_id, auth)

        # Get the original conversation details
        conversation = directus.get_items(
            "conversation",
            {
                "query": {
                    "filter": {"id": {"_eq": conversation_id}},
                    "fields": [
                        "id",
                        "project_id",
                        "participant_name",
                        "participant_email",
                        "participant_user_agent",
                        "merged_audio_path",
                    ],
                }
            },
        )

        if not conversation or len(conversation) == 0:
            raise ConversationNotFoundException

        original_conversation = conversation[0]
        project_id = original_conversation["project_id"]

        merged_audio_path = get_conversation_content(
            conversation_id=conversation_id,
            auth=auth,
            force_merge=True,
            return_url=True,
            signed=False,
        )

        # Create a new conversation
        new_conversation_id = generate_uuid()
        directus.create_item(
            "conversation",
            item_data={
                "id": new_conversation_id,
                "project_id": project_id,
                "participant_name": (
                    body.new_conversation_name
                    if body.new_conversation_name
                    else original_conversation["participant_name"] + " (retranscribed)"
                ),
                "participant_email": original_conversation["participant_email"]
                if original_conversation["participant_email"]
                else None,
                "participant_user_agent": original_conversation["participant_user_agent"]
                if original_conversation["participant_user_agent"]
                else None,
                "merged_audio_path": merged_audio_path,
            },
        )["data"]

        try:
            # Create a new conversation chunk
            chunk_id = generate_uuid()
            timestamp = get_utc_timestamp().isoformat()

            directus.create_item(
                "conversation_chunk",
                item_data={
                    "id": chunk_id,
                    "conversation_id": new_conversation_id,
                    "timestamp": timestamp,
                    "path": merged_audio_path,
                    "source": "CLONE",
                    "processing_status": ProcessingStatus.PENDING.value,
                    "processing_message": "Waiting to be transcribed",
                },
            )["data"]

            logger.debug(f"Queuing transcription for chunk {chunk_id}")
            # Import task locally to avoid circular imports
            from dembrane.tasks import task_process_conversation_chunk

            task_process_conversation_chunk.delay(chunk_id, run_finish_hook=False)

            return {
                "status": "success",
                "message": "Retranscription in progress",
                "new_conversation_id": new_conversation_id,
            }
        except Exception as e:
            # Clean up the partially created conversation
            directus.delete_item("conversation", new_conversation_id)
            logger.error(f"Error during retranscription: {str(e)}")
            raise HTTPException(status_code=500, detail=f"Failed to process audio: {str(e)}") from e

    except HTTPException as e:
        # Handle HTTP exceptions
        status_code = getattr(e, "status_code", 500)
        detail = getattr(e, "detail", str(e))

        logger.error(f"HTTP error during retranscription: {status_code} - {detail}")
        return {
            "status": "error",
            "message": "Operation failed",
            "error_detail": detail,
        }
    except Exception as e:
        logger.exception(f"Unexpected error during retranscription: {e}")
        return {
            "status": "error",
            "message": "Failed to retranscribe conversation",
            "error_detail": str(e),
        }
