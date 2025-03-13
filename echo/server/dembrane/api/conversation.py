import os
from typing import List, Optional, AsyncGenerator
from logging import getLogger

from fastapi import Request, APIRouter
from pydantic import BaseModel
from sqlalchemy.orm import noload, selectinload
from fastapi.responses import RedirectResponse, StreamingResponse
from fastapi.exceptions import HTTPException

from dembrane.s3 import get_signed_url
from dembrane.utils import CacheWithExpiration, get_utc_timestamp
from dembrane.database import (
    ConversationModel,
    ConversationChunkModel,
    DependencyInjectDatabase,
)
from dembrane.directus import directus
from dembrane.audio_utils import (
    get_mime_type_from_file_path,
    merge_multiple_audio_files_and_save_to_s3,
)
from dembrane.quote_utils import count_tokens
from dembrane.reply_utils import generate_reply_for_conversation
from dembrane.api.exceptions import (
    NoContentFoundException,
    ConversationNotFoundException,
)
from dembrane.api.dependency_auth import DependencyDirectusSession

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


async def stream_audio(
    file_paths: List[str], start: int = 0, end: Optional[int] = None
) -> AsyncGenerator[bytes, None]:
    current_position = 0

    for file_path in file_paths:
        if end is not None and current_position >= end:
            break  # End of the requested range

        with open(file_path, "rb") as f:
            file_size = os.path.getsize(file_path)

            # Calculate the start and end positions within this file
            file_start = max(0, start - current_position)
            file_end = min(file_size, end - current_position + 1) if end is not None else file_size

            if file_start < file_size:
                f.seek(file_start)
                while file_start < file_end:
                    chunk_size = min(1024 * 1024, file_end - file_start)  # Read in chunks
                    chunk = f.read(chunk_size)
                    if not chunk:
                        break
                    yield chunk
                    file_start += len(chunk)

            current_position += file_size


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

    if conversation is None:
        raise HTTPException(status_code=404, detail="Conversation not found")

    if not auth.is_admin and conversation[0]["project_id"]["directus_user_id"] != auth.user_id:
        raise HTTPException(
            status_code=403, detail="You are not authorized to access this conversation"
        )


@ConversationRouter.get("/{conversation_id}/content", response_model=None)
async def get_conversation_content(
    request: Request,
    conversation_id: str,
    auth: DependencyDirectusSession,
    force_merge: bool = False,
) -> StreamingResponse | RedirectResponse:
    raise_if_conversation_not_found_or_not_authorized(conversation_id, auth)

    # ordered by timestamp
    chunks = directus.get_items(
        "conversation_chunk",
        {
            "query": {
                "filter": {"conversation_id": {"_eq": conversation_id}},
                "sort": "-timestamp",
                "fields": ["path"],
            },
        },
    )

    if not chunks or len(chunks) == 0:
        raise ConversationNotFoundException

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
        logger.debug(f"Using merged audio path: {conversation['merged_audio_path']}")
        return RedirectResponse(get_signed_url(conversation["merged_audio_path"]))

    file_paths = [chunk["path"] for chunk in chunks if chunk["path"]]

    is_s3_impl = all(path.startswith("http") for path in file_paths)

    if is_s3_impl:
        logger.info(f"Merging {len(file_paths)} audio files for conversation {conversation_id}")

        merged_path = merge_multiple_audio_files_and_save_to_s3(
            file_paths, f"audio-conversations/{conversation_id}-{get_utc_timestamp()}.ogg"
        )

        logger.debug(f"Merged audio path: {merged_path}")
        directus.update_item(
            "conversation",
            conversation_id,
            {
                "merged_audio_path": merged_path,
            },
        )

        return RedirectResponse(get_signed_url(merged_path))

    # how does this work when there are multiple files with different types?
    mime_type = get_mime_type_from_file_path(file_paths[0])

    range_header = request.headers.get("Range")
    if range_header:
        start_str, end_str = range_header.replace("bytes=", "").split("-")
        start = int(start_str)
        end = int(end_str) if end_str else None

        file_size = sum(os.path.getsize(path) for path in file_paths)
        if end is None:
            end = file_size - 1

        return StreamingResponse(
            stream_audio(file_paths, start, end),
            media_type=mime_type,
            headers={
                "Content-Range": f"bytes {start}-{end}/{file_size}",
                "Accept-Ranges": "bytes",
                "Content-Length": str(end - start + 1),
            },
            status_code=206,
        )

    return StreamingResponse(stream_audio(file_paths), media_type=mime_type)


@ConversationRouter.get("/{conversation_id}/chunks/{chunk_id}/content", response_model=None)
async def get_conversation_chunk_content(
    request: Request,
    conversation_id: str,
    chunk_id: str,
    auth: DependencyDirectusSession,
) -> StreamingResponse | RedirectResponse:
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

    logger.info(f"Chunk path: {chunk['path']}")

    # If the chunk is a s3 URL, stream the audio from the URL
    if chunk["path"].startswith("http"):
        logger.info("Streaming audio from S3")
        return RedirectResponse(get_signed_url(chunk["path"]))

    file_paths = [chunk["path"]]
    mime_type = get_mime_type_from_file_path(file_paths[0])

    range_header = request.headers.get("Range")
    if range_header:
        start_str, end_str = range_header.replace("bytes=", "").split("-")
        start = int(start_str)
        end = int(end_str) if end_str else None

        file_size = sum(os.path.getsize(path) for path in file_paths)
        if end is None:
            end = file_size - 1

        logger.debug(f"mime_type: {mime_type}")

        return StreamingResponse(
            stream_audio(file_paths, start, end),
            media_type=mime_type,
            headers={
                "Content-Range": f"bytes {start}-{end}/{file_size}",
                "Accept-Ranges": "bytes",
                "Content-Length": str(end - start + 1),
            },
            status_code=206,
        )

    logger.debug(f"mime_type: {mime_type}")
    return StreamingResponse(stream_audio(file_paths), media_type=mime_type)


@ConversationRouter.get("/{conversation_id}/transcript")
async def get_conversation_transcript(
    conversation_id: str, db: DependencyInjectDatabase, auth: DependencyDirectusSession
) -> str:
    raise_if_conversation_not_found_or_not_authorized(conversation_id, auth)

    conversation_chunks = await get_conversation_chunks(conversation_id, db)
    transcript = []

    for chunk in conversation_chunks:
        if chunk.transcript:
            transcript.append(chunk.transcript)

    return "\n".join(transcript)


# Initialize the cache
token_count_cache = CacheWithExpiration(ttl=500)


@ConversationRouter.get("/{conversation_id}/token-count")
async def get_conversation_token_count(
    conversation_id: str,
    db: DependencyInjectDatabase,
    auth: DependencyDirectusSession,
) -> int:
    raise_if_conversation_not_found_or_not_authorized(conversation_id, auth)

    # Try to get the token count from the cache
    cached_count = await token_count_cache.get(conversation_id)
    if cached_count is not None:
        return cached_count

    # If not in cache, calculate the token count
    transcript = await get_conversation_transcript(conversation_id, db, auth)
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
) -> dict:
    reply = generate_reply_for_conversation(conversation_id, body.language)
    return reply
