import json
import asyncio
from typing import List, Optional, AsyncGenerator
from logging import getLogger

from fastapi import Request, APIRouter
from pydantic import BaseModel
from litellm.utils import token_counter
from fastapi.responses import RedirectResponse, StreamingResponse
from fastapi.exceptions import HTTPException
from litellm.exceptions import ContentPolicyViolationError

from dembrane.s3 import get_signed_url
from dembrane.llms import MODELS, get_completion_kwargs
from dembrane.utils import CacheWithExpiration, generate_uuid, get_utc_timestamp
from dembrane.service import project_service, conversation_service
from dembrane.directus import directus
from dembrane.audio_utils import (
    sanitize_filename_component,
    merge_multiple_audio_files_and_save_to_s3,
)
from dembrane.reply_utils import generate_reply_for_conversation
from dembrane.api.stateless import (
    generate_summary,
    generate_conversation_title,
    generate_conversation_tag_ids,
)
from dembrane.async_helpers import safe_gather, run_in_thread_pool
from dembrane.stream_status import stream_with_status
from dembrane.api.exceptions import (
    NoContentFoundException,
    ConversationNotFoundException,
)
from dembrane.api.dependency_auth import DependencyDirectusSession
from dembrane.service.conversation import ConversationService

logger = getLogger("api.conversation")
ConversationRouter = APIRouter(tags=["conversation"])


def _list_project_tags_for_assignment(project_id: str) -> list[dict[str, str]]:
    rows = directus.get_items(
        "project_tag",
        {
            "query": {
                "filter": {"project_id": {"_eq": project_id}},
                "fields": ["id", "text", "sort"],
                "sort": ["sort"],
                "limit": -1,
            }
        },
    )
    if not isinstance(rows, list):
        return []

    tags: list[dict[str, str]] = []
    for row in rows:
        tag_id = row.get("id")
        text = row.get("text")
        if isinstance(tag_id, str) and isinstance(text, str) and text.strip():
            tags.append({"id": tag_id, "text": text.strip()})
    return tags


def _get_current_conversation_tag_ids(conversation_id: str) -> set[str]:
    rows = directus.get_items(
        "conversation_project_tag",
        {
            "query": {
                "filter": {"conversation_id": {"_eq": conversation_id}},
                "fields": ["id", "project_tag_id.id"],
                "limit": -1,
            }
        },
    )
    if not isinstance(rows, list):
        return set()

    tag_ids: set[str] = set()
    for row in rows:
        tag_id = row.get("project_tag_id")
        if isinstance(tag_id, dict):
            tag_id = tag_id.get("id")
        if isinstance(tag_id, str):
            tag_ids.add(tag_id)
    return tag_ids


def _add_conversation_tags(conversation_id: str, tag_ids: list[str]) -> list[str]:
    current_tag_ids = _get_current_conversation_tag_ids(conversation_id)
    added: list[str] = []
    for tag_id in tag_ids:
        if tag_id in current_tag_ids:
            continue
        try:
            directus.create_item(
                "conversation_project_tag",
                {
                    "conversation_id": conversation_id,
                    "project_tag_id": tag_id,
                },
            )
            added.append(tag_id)
            current_tag_ids.add(tag_id)
        except Exception:  # noqa: BLE001
            logger.exception(
                "conversation_project_tag create failed conv=%s tag=%s",
                conversation_id,
                tag_id,
            )
    return added


async def _invalidate_usage_cache_for_conversation(conversation_id: str) -> None:
    """Bust workspace + org usage cache. No-op on any missing link."""
    from dembrane.cache_utils import invalidate_workspace_and_org_usage
    from dembrane.directus_async import async_directus

    # Single round-trip via Directus relational expansion — avoids
    # walking conversation -> project -> workspace as 3 separate GETs.
    conv = await async_directus.get_item(
        "conversation",
        conversation_id,
        params={"fields": "project_id.workspace_id.id,project_id.workspace_id.org_id"},
    )
    project = (conv or {}).get("project_id") if isinstance(conv, dict) else None
    workspace = (project or {}).get("workspace_id") if isinstance(project, dict) else None
    if not isinstance(workspace, dict):
        return
    workspace_id = workspace.get("id")
    if not workspace_id:
        return
    await invalidate_workspace_and_org_usage(workspace_id, workspace.get("org_id"))


async def get_conversation(
    conversation_id: str,
    load_chunks: bool = True,
    with_tags: bool = True,
    service: Optional[ConversationService] = None,
) -> dict:
    svc = service or conversation_service
    conversation = await run_in_thread_pool(
        svc.get_by_id_or_raise,
        conversation_id,
        with_tags,
        load_chunks,
    )

    return conversation


async def get_conversation_chunks(
    conversation_id: str,
    service: Optional[ConversationService] = None,
) -> List[dict]:
    svc = service or conversation_service
    await get_conversation(conversation_id, load_chunks=False, service=svc)
    chunks = await run_in_thread_pool(svc.list_chunks, conversation_id)

    return chunks


async def generate_health_events(
    request: Request,
    conversation_ids: List[str],  # noqa: ARG001
    project_ids: List[str],  # noqa: ARG001
    client_info: str,
    interval_seconds: int = 45,
) -> AsyncGenerator[str, None]:
    ping_count = 0
    last_health_data = None

    try:
        while True:
            # Check if the client is disconnected
            if await request.is_disconnected():
                logger.info(f"Client {client_info} disconnected - stopping health stream")
                break

            ping_count += 1

            # Send ping every 45 seconds
            yield f"event: ping\ndata: {ping_count}\n\n"

            # Extract only conversation_issue for the single conversation_id if only one is passed
            if len(conversation_ids) == 1:
                conversation_issue = None

                # Create simplified response with just the conversation_issue
                simplified_data = {"conversation_issue": conversation_issue}

                # Only send if changed
                if simplified_data != last_health_data:
                    yield f"event: health_update\ndata: {json.dumps(simplified_data)}\n\n"
                    last_health_data = simplified_data
            else:
                logger.warning(
                    "Multiple conversation IDs passed to health stream, only one is supported"
                )
                raise HTTPException(status_code=400, detail="Only one conversation ID is supported")

            # Log every 10th ping
            if ping_count % 10 == 0:
                logger.debug(f"Health stream ping #{ping_count} sent to {client_info}")

            await asyncio.sleep(interval_seconds)

    except asyncio.CancelledError:
        logger.info(f"Client disconnected during health stream to {client_info}")
        raise
    except ConnectionError as e:
        logger.error(f"Connection error during stream to {client_info}: {e}")
        raise
    except Exception as e:
        logger.error(f"Unexpected error in health stream to {client_info}: {e}", exc_info=True)
        # Send error event before closing
        try:
            error_data = {
                "error": "Internal server error",
                "timestamp": asyncio.get_event_loop().time(),
            }
            yield f"event: error\ndata: {json.dumps(error_data)}\n\n"
        except:  # noqa: E722
            pass
    finally:
        logger.info(f"Health stream to {client_info} ended after {ping_count} pings")


async def raise_if_conversation_not_found_or_not_authorized(
    conversation_id: str,
    auth: DependencyDirectusSession,
    require: Optional[str] = None,
) -> None:
    # v2 access gate, shared with the BFF layer (resolve_conversation_access
    # already enforces conversation:read; `require` adds a stricter policy
    # for mutations). Directus row ACL is admin-only post-lockdown, so all
    # data reads/writes after this gate MUST use the admin client; a
    # user-token client 403s on every collection.
    from dembrane.directus_async import async_directus
    from dembrane.api.v2.bff._access import resolve_conversation_access

    # Staff admins bypass the app-layer model (they may have no app_user
    # row); still 404 on missing or soft-deleted conversations.
    if auth.is_admin:
        conversation = await async_directus.get_item("conversation", conversation_id)
        if not conversation or conversation.get("deleted_at"):
            raise HTTPException(status_code=404, detail="Conversation not found")
        return

    access, _ = await resolve_conversation_access(conversation_id, auth)
    if require:
        access.require(require)


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


@ConversationRouter.get("/{conversation_id}/counts")
async def get_conversation_counts(
    conversation_id: str,
    auth: DependencyDirectusSession,
) -> dict:
    await raise_if_conversation_not_found_or_not_authorized(conversation_id, auth)

    counts = await run_in_thread_pool(conversation_service.get_chunk_counts, conversation_id)

    return counts


@ConversationRouter.get("/{conversation_id}/content", response_model=None)
async def get_conversation_content(
    conversation_id: str,
    auth: DependencyDirectusSession,
    force_merge: bool = False,
    return_url: bool = False,
    signed: bool = True,
) -> StreamingResponse | RedirectResponse | str:
    await raise_if_conversation_not_found_or_not_authorized(conversation_id, auth)

    logger.debug(
        f"Getting content for conversation {conversation_id}, force_merge={force_merge}, return_url={return_url}"
    )

    # First, get all conversation chunks with more information for debugging
    chunks = await run_in_thread_pool(
        directus.get_items,
        "conversation_chunk",
        {
            "query": {
                "filter": {"conversation_id": {"_eq": conversation_id}},
                "sort": "timestamp",
                "fields": ["id", "path", "timestamp", "error"],
                "limit": 1000,
            },
        },
    )

    if not chunks:
        logger.error(f"No chunks found for conversation {conversation_id}")
        raise ConversationNotFoundException

    # Count chunks with errors for logging
    errored_chunks = [c for c in chunks if c.get("error")]
    if errored_chunks:
        logger.info(
            f"Conversation {conversation_id} has {len(errored_chunks)} chunks with errors "
            f"(will be skipped in merge)"
        )

    logger.debug(f"Found {len(chunks)} total chunks for conversation {conversation_id}")

    conversations = await run_in_thread_pool(
        directus.get_items,
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

        merged_path, duration = await run_in_thread_pool(
            merge_multiple_audio_files_and_save_to_s3,
            file_paths,
            f"audio-conversations/merged-{sanitize_filename_component(conversation_id)}-{uuid}.mp3",
            "mp3",
        )

        logger.debug(f"Successfully merged audio to: {merged_path}, duration: {duration}s")

        await run_in_thread_pool(
            directus.update_item,
            "conversation",
            conversation_id,
            {
                "merged_audio_path": merged_path,
                "duration": duration,
            },
        )

        # New duration → bust usage cache so /w + billing don't wait
        # 30 min (TTL) for the hours to surface.
        try:
            await _invalidate_usage_cache_for_conversation(conversation_id)
        except Exception as exc:
            logger.warning(
                "usage cache invalidation failed for conversation %s: %s",
                conversation_id,
                exc,
            )

        return return_url_or_redirect(merged_path, signed=signed, return_url=return_url)

    except Exception as e:
        logger.error(f"Error merging audio files: {str(e)}")
        raise HTTPException(status_code=400, detail=f"Failed to merge audio files: {str(e)}") from e


@ConversationRouter.get("/{conversation_id}/chunks/{chunk_id}/content", response_model=None)
async def get_conversation_chunk_content(
    conversation_id: str,
    chunk_id: str,
    auth: DependencyDirectusSession,
    return_url: bool = False,
    signed: bool = True,
) -> StreamingResponse | RedirectResponse | str:
    await raise_if_conversation_not_found_or_not_authorized(conversation_id, auth)

    chunks = await run_in_thread_pool(
        directus.get_items,
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
async def get_conversation_transcript(conversation_id: str, auth: DependencyDirectusSession) -> str:
    await raise_if_conversation_not_found_or_not_authorized(conversation_id, auth)

    conversation_chunks = await run_in_thread_pool(
        directus.get_items,
        "conversation_chunk",
        {
            "query": {
                "filter": {"conversation_id": {"_eq": conversation_id}},
                "fields": ["id", "transcript", "error"],
                "sort": "timestamp",
                "limit": 1500,
            },
        },
    )

    if not conversation_chunks or len(conversation_chunks) == 0:
        return ""

    transcript = []
    skipped_count = 0
    errored_count = 0

    for chunk in conversation_chunks:
        if chunk.get("transcript"):
            transcript.append(chunk["transcript"])
        else:
            skipped_count += 1
            if chunk.get("error"):
                errored_count += 1
                logger.debug(
                    f"Skipping chunk {chunk.get('id')} with error: {chunk.get('error')[:100]}"
                )

    if skipped_count > 0:
        logger.info(
            f"Transcript for {conversation_id}: included {len(transcript)}/{len(conversation_chunks)} chunks, "
            f"skipped {skipped_count} ({errored_count} with errors)"
        )

    return "\n".join(transcript)


class ConversationEmailsResponse(BaseModel):
    emails_csv: str
    count: int


@ConversationRouter.get("/{conversation_id}/emails")
async def get_conversation_emails(
    conversation_id: str,
    auth: DependencyDirectusSession,
) -> ConversationEmailsResponse:
    """Get comma-separated list of emails captured for a conversation."""
    await raise_if_conversation_not_found_or_not_authorized(conversation_id, auth)

    participants = await run_in_thread_pool(
        directus.get_items,
        "project_report_notification_participants",
        {
            "query": {
                "filter": {"conversation_id": {"_eq": conversation_id}},
                "fields": ["email"],
                "limit": 1000,
            }
        },
    )

    if not participants:
        return ConversationEmailsResponse(emails_csv="", count=0)

    emails = [p.get("email") for p in participants if p.get("email")]
    return ConversationEmailsResponse(
        emails_csv=",".join(emails),
        count=len(emails),
    )


# Initialize the cache
token_count_cache = CacheWithExpiration(ttl=500)


@ConversationRouter.get("/{conversation_id}/token-count")
async def get_conversation_token_count(
    conversation_id: str,
    auth: DependencyDirectusSession,
) -> int:
    await raise_if_conversation_not_found_or_not_authorized(conversation_id, auth)

    # Try to get the token count from the cache
    cached_count = await token_count_cache.get(conversation_id)
    if cached_count is not None:
        return cached_count

    # If not in cache, calculate the token count
    transcript = await get_conversation_transcript(conversation_id, auth)

    token_count = token_counter(
        messages=[{"role": "user", "content": transcript}],
        model=get_completion_kwargs(MODELS.MULTI_MODAL_PRO)["model"],
    )

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
        try:
            # Stream content chunks
            async for chunk in generate_reply_for_conversation(conversation_id, body.language):
                yield "0:" + json.dumps(chunk) + "\n"
        except ContentPolicyViolationError as e:
            logger.error(f"Content policy violation for conversation {conversation_id}: {str(e)}")
            yield "3:" + json.dumps("CONTENT_POLICY_VIOLATION") + "\n"
        except Exception as e:
            # Handle errors by streaming an error payload
            logger.error(f"Error generating reply for conversation {conversation_id}: {str(e)}")
            yield "3:" + json.dumps("Something went wrong.") + "\n"

    # Wrap with status notifications for high load scenarios
    stream = stream_with_status(generate(), protocol="data")

    return StreamingResponse(
        stream,
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Content-Type": "text/event-stream",
            "X-Accel-Buffering": "no",
        },
    )


# this should ideally be in the service. the async functions are a bit messy at the moment.
@ConversationRouter.post("/{conversation_id}/summarize", response_model=None)
async def summarize_conversation(
    conversation_id: str,
    auth: DependencyDirectusSession,
) -> dict:
    await raise_if_conversation_not_found_or_not_authorized(
        conversation_id, auth, require="project:update"
    )

    # Gate: never (re)generate a summary for a locked conversation. That would
    # surface transcript-derived content past the hours-cap gate (the edit
    # modal's Generate button is also disabled; this is the backstop).
    from dembrane.free_tier import (
        resolve_project_tier,
        conversation_is_locked,
    )
    from dembrane.directus_async import async_directus

    _conv = await async_directus.get_item("conversation", conversation_id)
    _project_id = (_conv or {}).get("project_id")
    if isinstance(_project_id, dict):
        _project_id = _project_id.get("id")
    _tier = await resolve_project_tier(_project_id) if _project_id else None
    if conversation_is_locked(_conv or {}, _tier):
        raise HTTPException(
            status_code=402,
            detail="Conversation is locked. Upgrade to generate a summary.",
        )

    conversation_data_result = await run_in_thread_pool(
        directus.get_items,
        "conversation",
        {
            "query": {
                "filter": {"id": {"_eq": conversation_id}},
                "fields": [
                    "id",
                    "title",
                    "project_id.id",
                    "project_id.language",
                    "project_id.enable_ai_title_and_tags",
                    "project_id.conversation_title_prompt",
                ],
            },
        },
    )

    # If the user has manually set/edited a custom title, pass it down as optional summary context.
    conversation_title = conversation_data_result[0].get("title") if conversation_data_result else None

    awaitable_list = [
        get_conversation_transcript(conversation_id, auth),
        run_in_thread_pool(
            project_service.get_context_for_prompt,
            conversation_data_result[0]["project_id"]["id"],
        ),
        run_in_thread_pool(
            conversation_service.get_verified_artifacts,
            conversation_id,
        ),
    ]

    transcript_str, project_context_str, verified_artifacts = await safe_gather(*awaitable_list)

    if not conversation_data_result or len(conversation_data_result) == 0:
        raise HTTPException(status_code=404, detail="Conversation not found")

    conversation_data = conversation_data_result

    conversation_data = conversation_data[0]

    language = conversation_data["project_id"]["language"]

    if transcript_str == "":
        return {
            "status": "success",
            "message": "Transcript is empty, so no summary was generated",
        }
    else:
        summary = await run_in_thread_pool(
            generate_summary,
            transcript_str,
            language if language else "en",
            project_context_str,
            verified_artifacts,
            conversation_title,
        )

        # Prepare update data with summary
        update_data: dict = {"summary": summary}
        title = None
        assigned_tag_ids: list[str] = []

        # Generate title if AI title generation is enabled for this project
        project_data = conversation_data["project_id"]
        enable_ai_title_and_tags = project_data.get("enable_ai_title_and_tags", False)

        if enable_ai_title_and_tags and summary:
            try:
                # Fetch recent titles for style matching
                existing_titles = await run_in_thread_pool(
                    conversation_service.get_recent_titles_for_project,
                    project_data["id"],
                    10,
                )

                custom_prompt = project_data.get("conversation_title_prompt")

                title = await run_in_thread_pool(
                    generate_conversation_title,
                    summary,
                    language if language else "en",
                    existing_titles,
                    custom_prompt,
                )

                if title:
                    update_data["title"] = title
                    logger.info(f"Generated title for conversation {conversation_id}: {title}")
            except Exception as e:
                logger.error(f"Error generating title for conversation {conversation_id}: {e}")
                # Continue without title if generation fails

            try:
                project_tags = await run_in_thread_pool(
                    _list_project_tags_for_assignment,
                    project_data["id"],
                )
                if project_tags:
                    tag_ids = await run_in_thread_pool(
                        generate_conversation_tag_ids,
                        summary,
                        language if language else "en",
                        project_tags,
                    )
                    if tag_ids:
                        assigned_tag_ids = await run_in_thread_pool(
                            _add_conversation_tags,
                            conversation_id,
                            tag_ids,
                        )
                        if assigned_tag_ids:
                            logger.info(
                                "Assigned draft tags for conversation %s: %s",
                                conversation_id,
                                assigned_tag_ids,
                            )
                else:
                    logger.info(
                        "Skipping draft tag assignment for conversation %s: project has no tags",
                        conversation_id,
                    )
            except Exception as e:
                logger.error(f"Error assigning draft tags for conversation {conversation_id}: {e}")
                # Continue without tags if assignment fails

        await run_in_thread_pool(
            directus.update_item,
            "conversation",
            conversation_id,
            update_data,
        )

        response = {
            "status": "success",
            "message": "Summary generated",
            "summary": summary,
        }
        if title:
            response["title"] = title
        if assigned_tag_ids:
            response["tag_ids"] = assigned_tag_ids
        return response


@ConversationRouter.post("/{conversation_id}/generate-title", response_model=None)
async def generate_title_for_conversation(
    conversation_id: str,
    auth: DependencyDirectusSession,
) -> dict:
    """
    Generate a title for a conversation based on its summary.
    Requires the conversation to have a summary.
    """
    await raise_if_conversation_not_found_or_not_authorized(
        conversation_id, auth, require="project:update"
    )

    # Gate: locked conversations are content-gated (see summarize_conversation).
    from dembrane.free_tier import (
        resolve_project_tier,
        conversation_is_locked,
    )
    from dembrane.directus_async import async_directus

    _conv = await async_directus.get_item("conversation", conversation_id)
    _project_id = (_conv or {}).get("project_id")
    if isinstance(_project_id, dict):
        _project_id = _project_id.get("id")
    _tier = await resolve_project_tier(_project_id) if _project_id else None
    if conversation_is_locked(_conv or {}, _tier):
        raise HTTPException(
            status_code=402,
            detail="Conversation is locked. Upgrade to generate a title.",
        )

    conversation_data_result = await run_in_thread_pool(
        directus.get_items,
        "conversation",
        {
            "query": {
                "filter": {"id": {"_eq": conversation_id}},
                "fields": [
                    "id",
                    "summary",
                    "project_id.id",
                    "project_id.language",
                    "project_id.conversation_title_prompt",
                ],
            },
        },
    )

    if not conversation_data_result or len(conversation_data_result) == 0:
        raise HTTPException(status_code=404, detail="Conversation not found")

    conversation_data = conversation_data_result[0]
    summary = conversation_data.get("summary")

    if not summary:
        raise HTTPException(
            status_code=400, detail="Conversation has no summary. Generate a summary first."
        )

    project_data = conversation_data["project_id"]
    language = project_data.get("language", "en")
    custom_prompt = project_data.get("conversation_title_prompt")

    existing_titles = await run_in_thread_pool(
        conversation_service.get_recent_titles_for_project,
        project_data["id"],
        10,
    )

    title = await run_in_thread_pool(
        generate_conversation_title,
        summary,
        language if language else "en",
        existing_titles,
        custom_prompt,
    )

    if title:
        await run_in_thread_pool(
            directus.update_item,
            "conversation",
            conversation_id,
            {"title": title},
        )

    return {"title": title or ""}


class RetranscribeConversationBodySchema(BaseModel):
    new_conversation_name: str
    use_pii_redaction: bool | None = None
    attach_verified_artifacts: bool | None = None


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
        admin_client = directus

        # Check the caller can mutate this project's conversations
        await raise_if_conversation_not_found_or_not_authorized(
            conversation_id, auth, require="project:update"
        )

        # Get the original conversation details
        conversation = await run_in_thread_pool(
            admin_client.get_items,
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

        # Resolve use_pii_redaction: use explicit value if provided, else fall back to project setting
        use_pii_redaction = body.use_pii_redaction
        if use_pii_redaction is None:
            try:
                project_data = await run_in_thread_pool(
                    admin_client.get_items,
                    "project",
                    {
                        "query": {
                            "filter": {"id": {"_eq": project_id}},
                            "fields": ["anonymize_transcripts"],
                        }
                    },
                )
                if project_data and len(project_data) > 0:
                    use_pii_redaction = bool(project_data[0].get("anonymize_transcripts", False))
                else:
                    use_pii_redaction = False
            except Exception:
                use_pii_redaction = False

        merged_audio_path = await get_conversation_content(
            conversation_id=conversation_id,
            auth=auth,
            force_merge=True,
            return_url=True,
            signed=False,
        )

        # because return_url is True
        assert isinstance(merged_audio_path, str)

        # Duration was already computed and saved by get_conversation_content above
        updated_conversation = await run_in_thread_pool(
            admin_client.get_items,
            "conversation",
            {
                "query": {
                    "filter": {"id": {"_eq": conversation_id}},
                    "fields": ["duration"],
                }
            },
        )
        duration = updated_conversation[0].get("duration") if updated_conversation else None

        # Create a new conversation
        new_conversation_id = generate_uuid()

        await run_in_thread_pool(
            admin_client.create_item,
            "conversation",
            item_data={
                "id": new_conversation_id,
                "duration": duration,
                "source": "CLONE",
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
                "is_anonymized": use_pii_redaction,
                # Clone is complete at creation (one chunk, nothing more coming);
                # finished now so the chunk pipeline finalizes event-driven.
                "is_finished": True,
            },
        )

        try:
            logger.info(f"Creating links from {conversation_id} to {new_conversation_id}")
            link_id = (
                await run_in_thread_pool(
                    admin_client.create_item,
                    "conversation_link",
                    item_data={
                        "source_conversation_id": conversation_id,
                        "target_conversation_id": new_conversation_id,
                        "link_type": "CLONE",
                    },
                )
            )["data"]["id"]
            logger.info(f"Link created: {link_id}")
        except Exception as e:
            logger.error(f"Error creating links: {str(e)}")

        # Copy verified artifacts to the new conversation if requested
        attach_verified_artifacts = (
            body.attach_verified_artifacts if body.attach_verified_artifacts is not None else False
        )
        if attach_verified_artifacts:
            try:
                original_artifacts = await run_in_thread_pool(
                    admin_client.get_items,
                    "conversation_artifact",
                    {
                        "query": {
                            "filter": {
                                "conversation_id": {"_eq": conversation_id},
                                "approved_at": {"_nnull": True},
                            },
                            "fields": [
                                "key",
                                "topic_label",
                                "content",
                                "approved_at",
                                "read_aloud_stream_url",
                            ],
                        }
                    },
                )

                if original_artifacts:
                    for artifact in original_artifacts:
                        await run_in_thread_pool(
                            admin_client.create_item,
                            "conversation_artifact",
                            item_data={
                                "id": generate_uuid(),
                                "conversation_id": new_conversation_id,
                                "key": artifact.get("key"),
                                "topic_label": artifact.get("topic_label"),
                                "content": artifact.get("content"),
                                "approved_at": artifact.get("approved_at"),
                                "read_aloud_stream_url": artifact.get("read_aloud_stream_url")
                                or "",
                            },
                        )
                    logger.info(
                        f"Copied {len(original_artifacts)} verified artifacts from {conversation_id} to {new_conversation_id}"
                    )
            except Exception as e:
                logger.error(f"Error copying verified artifacts: {str(e)}")

        try:
            # Create a new conversation chunk
            chunk_id = generate_uuid()
            timestamp = get_utc_timestamp().isoformat()

            (
                await run_in_thread_pool(
                    admin_client.create_item,
                    "conversation_chunk",
                    item_data={
                        "id": chunk_id,
                        "conversation_id": new_conversation_id,
                        "timestamp": timestamp,
                        "path": merged_audio_path,
                        "source": "CLONE",
                    },
                )
            )["data"]

            logger.debug(f"Queuing transcription for chunk {chunk_id}")
            # Import task locally to avoid circular imports
            from dembrane.tasks import task_process_conversation_chunk

            task_process_conversation_chunk.send(chunk_id, use_pii_redaction=use_pii_redaction)

            # Clone duplicates `duration` into the workspace rollup.
            try:
                await _invalidate_usage_cache_for_conversation(new_conversation_id)
            except Exception as exc:
                logger.warning(
                    "usage cache invalidation failed after retranscribe of %s (clone=%s): %s",
                    conversation_id,
                    new_conversation_id,
                    exc,
                )

            return {
                "status": "success",
                "message": "Retranscription in progress",
                "new_conversation_id": new_conversation_id,
            }
        except Exception as e:
            # Clean up the partially created conversation
            await run_in_thread_pool(admin_client.delete_item, "conversation", new_conversation_id)
            # Log the raw exception server-side, but don't surface str(e)
            # to the client — CodeQL flags it as stack-trace exposure.
            logger.exception("Error during retranscription")
            raise HTTPException(status_code=500, detail="Failed to process audio") from e

    except HTTPException as e:
        status_code = getattr(e, "status_code", 500)
        detail = getattr(e, "detail", "Operation failed")
        logger.error(f"HTTP error during retranscription: {status_code} - {detail}")
        return {
            "status": "error",
            "message": "Operation failed",
            "error_detail": detail,
        }
    except Exception:
        # Don't echo str(e) back to the caller (CodeQL py/stack-trace-exposure).
        logger.exception("Unexpected error during retranscription")
        return {
            "status": "error",
            "message": "Failed to retranscribe conversation",
            "error_detail": "internal error",
        }


@ConversationRouter.delete("/{conversation_id}")
async def delete_conversation(
    conversation_id: str,
    auth: DependencyDirectusSession,
) -> dict:
    """
    Soft-delete a conversation by setting deleted_at.

    S3 audio files are preserved. The conversation data remains in the
    database but is excluded from read queries via deleted_at IS NULL.
    """
    await raise_if_conversation_not_found_or_not_authorized(
        conversation_id, auth, require="conversation:delete"
    )
    try:
        await run_in_thread_pool(conversation_service.delete, conversation_id)

        try:
            await _invalidate_usage_cache_for_conversation(conversation_id)
        except Exception as exc:
            logger.warning(
                "usage cache invalidation failed after deleting conversation %s: %s",
                conversation_id,
                exc,
            )

        return {"status": "success", "message": "Conversation deleted successfully"}
    except Exception as e:
        logger.exception(f"Error deleting conversation {conversation_id}: {e}")
        raise HTTPException(
            status_code=500, detail=f"Failed to delete conversation: {str(e)}"
        ) from e


@ConversationRouter.get("/health/stream")
async def stream_health_data(
    request: Request,
    conversation_ids: Optional[str] = "",
    project_ids: Optional[str] = "",
) -> StreamingResponse:
    # ensure ids exist and are not empty
    if conversation_ids is None:
        conversation_ids = ""
    if project_ids is None:
        project_ids = ""

    def clean_ids(id_list: Optional[str]) -> List[str]:
        return [id.strip() for id in id_list.split(",") if id and id.strip()] if id_list else []

    conversation_ids_list = clean_ids(conversation_ids)
    project_ids_list = clean_ids(project_ids)

    logger.debug(f"Conversation IDs: {conversation_ids_list}")
    logger.debug(f"Project IDs: {project_ids_list}")

    if not conversation_ids_list and not project_ids_list:
        raise HTTPException(
            status_code=400,
            detail="At least one of conversation_ids or project_ids must be provided",
        )

    # Limit total IDs to prevent abuse
    total_ids = len(conversation_ids_list) + len(project_ids_list)
    if total_ids > 20:
        raise HTTPException(
            status_code=400, detail=f"Too many IDs provided ({total_ids}). Maximum allowed is 20."
        )

    INTERVAL_SECONDS = 45
    client_info = (
        f"{request.client.host}:{request.client.port}" if request.client else "unknown client"
    )

    return StreamingResponse(
        generate_health_events(
            request, conversation_ids_list, project_ids_list, client_info, INTERVAL_SECONDS
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Content-Type": "text/event-stream",
            "X-Accel-Buffering": "no",
        },
    )
