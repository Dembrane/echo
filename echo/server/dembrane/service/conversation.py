# conversation.py
from typing import TYPE_CHECKING, Any, List, Iterable, Optional, ContextManager
from logging import getLogger
from datetime import datetime
from urllib.parse import urlparse

from fastapi import UploadFile

from dembrane.utils import generate_uuid
from dembrane.directus import (
    DirectusClient,
    DirectusBadRequest,
    DirectusGenericException,
    directus,
    directus_client_context,
)

logger = getLogger("dembrane.service.conversation")

if TYPE_CHECKING:
    from dembrane.service.file import FileService
    from dembrane.service.project import ProjectService

# allows for None to be a sentinel value
_UNSET = object()


def sanitize_url_for_logging(url: str) -> str:
    """Remove sensitive query params and fragments from URL for safe logging."""
    parsed = urlparse(url)
    return f"{parsed.scheme}://{parsed.netloc}{parsed.path}"


class ConversationServiceException(Exception):
    pass


class ConversationNotFoundException(ConversationServiceException):
    pass


class ConversationNotOpenForParticipationException(ConversationServiceException):
    pass


class ConversationChunkNotFoundException(ConversationServiceException):
    pass


class ConversationService:
    def __init__(
        self,
        file_service: Optional["FileService"] = None,
        project_service: Optional["ProjectService"] = None,
        directus_client: Optional[DirectusClient] = None,
    ):
        self._file_service = file_service
        self._project_service = project_service
        self._directus_client = directus_client or directus

    def _client_context(
        self, override_client: Optional[DirectusClient] = None
    ) -> ContextManager[DirectusClient]:
        return directus_client_context(override_client or self._directus_client)

    @property
    def file_service(self) -> "FileService":
        if self._file_service is None:
            from dembrane.service.file import get_file_service

            self._file_service = get_file_service()
        return self._file_service

    @property
    def project_service(self) -> "ProjectService":
        if self._project_service is None:
            from dembrane.service.project import ProjectService

            self._project_service = ProjectService(directus_client=self._directus_client)
        return self._project_service

    def get_by_id_or_raise(
        self,
        conversation_id: str,
        with_tags: bool = False,
        with_chunks: bool = False,
    ) -> dict:
        try:
            with self._client_context() as client:
                fields = ["*"]
                deep = {}

                if with_tags:
                    fields.append("tags.project_tag_id.*")

                if with_chunks:
                    fields.append("chunks.*")
                    deep["chunks"] = {"_sort": "-timestamp", "_limit": 1200}

                conversation = client.get_items(
                    "conversation",
                    {
                        "query": {
                            "filter": {
                                "id": conversation_id,
                            },
                            "fields": fields,
                            "deep": deep,
                        }
                    },
                )

        except (DirectusBadRequest, DirectusGenericException) as e:
            raise ConversationNotFoundException() from e

        try:
            return conversation[0]
        except (KeyError, IndexError) as e:
            raise ConversationNotFoundException() from e

    def list_by_project(
        self,
        project_id: str,
        with_chunks: bool = False,
        with_tags: bool = False,
    ) -> List[dict]:
        return self._list_conversations(
            filter_query={"project_id": {"_eq": project_id}},
            with_chunks=with_chunks,
            with_tags=with_tags,
        )

    def list_by_ids(
        self,
        conversation_id_list: Iterable[str],
        with_chunks: bool = False,
        with_tags: bool = False,
    ) -> List[dict]:
        ids = [conversation_id for conversation_id in conversation_id_list]
        if not ids:
            return []

        return self._list_conversations(
            filter_query={"id": {"_in": ids}},
            with_chunks=with_chunks,
            with_tags=with_tags,
        )

    def list_by_project_with_filters(
        self,
        project_id: str,
        tag_ids: Optional[List[str]] = None,
        verified_only: bool = False,
        search_text: Optional[str] = None,
        sort: str = "-created_at",
        limit: int = 1000,
    ) -> List[dict]:
        """
        List conversations for a project with advanced filtering options.

        Optimized for the chat select_all feature - only fetches minimal required fields:
        - id: to identify conversations
        - participant_name: for display in UI
        - chunks.transcript: to check if conversation has content

        Args:
            project_id: The project ID to filter by
            tag_ids: Optional list of tag IDs to filter by
            verified_only: If True, only return conversations with approved artifacts
            search_text: Optional search text (uses Directus search)
            sort: Sort order (default: most recent first "-created_at")
            limit: Maximum number of conversations to return

        Returns:
            List of conversation dicts with minimal fields for efficiency
        """
        # Build filter query
        filter_query: dict[str, Any] = {
            "project_id": {"_eq": project_id},
        }

        if tag_ids and len(tag_ids) > 0:
            filter_query["tags"] = {
                "_some": {
                    "project_tag_id": {
                        "id": {"_in": tag_ids},
                    },
                },
            }

        if verified_only:
            filter_query["conversation_artifacts"] = {
                "_some": {
                    "approved_at": {
                        "_nnull": True,
                    },
                },
            }

        # Minimal fields - only what's actually used in select_all
        fields: List[str] = [
            "id",
            "participant_name",
            "chunks.transcript",  # Only transcript needed to check if conversation has content
        ]

        deep: dict[str, Any] = {"chunks": {"_sort": "timestamp"}}

        # Build query dict
        query_dict: dict[str, Any] = {
            "filter": filter_query,
            "fields": fields,
            "deep": deep,
            "limit": limit,
            "sort": sort,
        }

        if search_text and search_text.strip():
            query_dict["search"] = search_text

        try:
            with self._client_context() as client:
                conversations: Optional[List[dict]] = client.get_items(
                    "conversation",
                    {"query": query_dict},
                )
        except DirectusBadRequest as e:
            logger.error("Failed to list conversations with filters via Directus: %s", e)
            raise ConversationServiceException() from e

        return conversations or []

    def list_chunks(self, conversation_id: str) -> List[dict]:
        try:
            with self._client_context() as client:
                chunks: Optional[List[dict]] = client.get_items(
                    "conversation_chunk",
                    {
                        "query": {
                            "filter": {"conversation_id": {"_eq": conversation_id}},
                            "fields": [
                                "id",
                                "conversation_id",
                                "timestamp",
                                "transcript",
                                "path",
                                "created_at",
                                "updated_at",
                            ],
                            "sort": "timestamp",
                            "limit": 2000,
                        }
                    },
                )
        except DirectusBadRequest as e:
            logger.error(
                "Failed to list chunks for conversation %s via Directus: %s",
                conversation_id,
                e,
            )
            raise ConversationServiceException() from e

        return chunks or []

    def create(
        self,
        project_id: str,
        participant_name: str,
        participant_email: Optional[str] = None,
        participant_user_agent: Optional[str] = None,
        project_tag_id_list: Optional[List[str]] = None,
        source: Optional[str] = None,
    ) -> dict:
        # FIXME: validate project_tag_id_list
        if project_tag_id_list is None:
            project_tag_id_list = []

        project = self.project_service.get_by_id_or_raise(project_id)

        if project.get("is_conversation_allowed", False) is False:
            raise ConversationNotOpenForParticipationException()

        with self._client_context() as client:
            new_conversation = client.create_item(
                "conversation",
                item_data={
                    "id": generate_uuid(),
                    "project_id": project.get("id"),
                    "participant_name": participant_name,
                    "participant_email": participant_email,
                    "participant_user_agent": participant_user_agent,
                    "source": source,
                    "tags": {
                        "create": [
                            {
                                "project_tag_id": tag_id,
                            }
                            for tag_id in project_tag_id_list
                        ],
                    },
                },
            )["data"]

        return new_conversation

    def update(
        self,
        conversation_id: str,
        participant_name: Any = _UNSET,
        participant_email: Any = _UNSET,
        participant_user_agent: Any = _UNSET,
        summary: Any = _UNSET,
        source: Any = _UNSET,
        is_finished: Any = _UNSET,
        is_all_chunks_transcribed: Any = _UNSET,
    ) -> dict:
        update_data: dict[str, Any] = {}
        if participant_name is not _UNSET:
            update_data["participant_name"] = participant_name
        if participant_email is not _UNSET:
            update_data["participant_email"] = participant_email
        if participant_user_agent is not _UNSET:
            update_data["participant_user_agent"] = participant_user_agent
        if summary is not _UNSET:
            update_data["summary"] = summary
        if source is not _UNSET:
            update_data["source"] = source
        if is_finished is not _UNSET:
            update_data["is_finished"] = is_finished
        if is_all_chunks_transcribed is not _UNSET:
            update_data["is_all_chunks_transcribed"] = is_all_chunks_transcribed

        try:
            with self._client_context() as client:
                updated_conversation = client.update_item(
                    "conversation",
                    conversation_id,
                    update_data,
                )["data"]

            return updated_conversation
        except (DirectusBadRequest, DirectusGenericException) as e:
            raise ConversationNotFoundException() from e

    def delete(
        self,
        conversation_id: str,
    ) -> None:
        with self._client_context() as client:
            conversation = self.get_by_id_or_raise(conversation_id, with_chunks=True)
            for chunk in conversation["chunks"]:
                try:
                    if chunk["path"]:
                        self.file_service.delete(chunk["path"])
                except Exception as e:
                    logger.exception(f"Error deleting chunk {chunk['id']} file: {e}")

            client.delete_item("conversation", conversation_id)

    def get_chunk_by_id_or_raise(
        self,
        chunk_id: str,
    ) -> dict:
        """
        Get a conversation chunk by its ID.

        Args:
            chunk_id: The ID of the chunk. (str)

        Returns:
            The conversation chunk. (dict)

        Raises:
        - ConversationChunkNotFoundException: If the chunk is not found, or the request is malformed.
        - DirectusGenericException -> DirectusServerError: If the request to the Directus server fails.
        """
        try:
            with self._client_context() as client:
                chunk = client.get_items(
                    "conversation_chunk",
                    {
                        "query": {
                            "filter": {"id": chunk_id},
                        },
                    },
                )

            return chunk[0]
        except DirectusBadRequest as e:
            raise ConversationChunkNotFoundException() from e
        except (KeyError, IndexError) as e:
            raise ConversationChunkNotFoundException() from e

    def create_chunk(
        self,
        conversation_id: str,
        timestamp: datetime,
        source: str,
        file_obj: Optional[UploadFile] = None,
        file_url: Optional[str] = None,
        transcript: Optional[str] = None,
    ) -> dict:
        """
        Create a new conversation chunk.

        If file_obj is provided, the file will be saved.

        The file will be saved in the following path:
        - conversation/{conversation_id}/chunks/{chunk_id}-{file_obj.filename}

        We expect the file extension to be available in the filename.

        Args:
            conversation_id: The ID of the conversation. (str)
            timestamp: The timestamp of the chunk. (datetime)
            source: The source of the chunk. (str)
            file_obj: The file object to upload. (Optional[UploadFile])
            file_url: The URL of the file to upload. (Optional[str])
            transcript: The transcript of the chunk. (Optional[str])

        Returns:
            The created conversation chunk. (dict)
        """
        from dembrane.tasks import task_process_conversation_chunk

        conversation = self.get_by_id_or_raise(conversation_id)

        project = self.project_service.get_by_id_or_raise(conversation["project_id"])

        if project.get("is_conversation_allowed", False) is False:
            raise ConversationNotOpenForParticipationException()

        chunk_id = generate_uuid()

        needs_upload = file_obj is not None and file_url is None
        if needs_upload:
            assert file_obj is not None
            file_name = f"conversation/{conversation['id']}/chunks/{chunk_id}-{file_obj.filename}"
            file_url = self.file_service.save(file=file_obj, key=file_name, public=False)
            logger.info(f"File uploaded to S3 via API: {sanitize_url_for_logging(file_url)}")
        elif file_url:
            logger.info(
                f"Using pre-uploaded file from presigned URL: {sanitize_url_for_logging(file_url)}"
            )

        # Validate that we have either a file or a transcript
        has_file = file_url and len(file_url.strip()) > 0
        has_transcript = transcript and len(transcript.strip()) > 0

        if not has_file and not has_transcript:
            logger.error(
                f"Cannot create chunk without content. "
                f"file_obj={'provided' if file_obj else 'missing'}, "
                f"file_url={'provided' if file_url else 'missing'}, "
                f"transcript={'provided' if transcript else 'missing'}"
            )
            raise ConversationServiceException(
                "Chunk must have either an audio file (file_obj or file_url) or a transcript."
            )

        with self._client_context() as client:
            chunk = client.create_item(
                "conversation_chunk",
                item_data={
                    "id": chunk_id,
                    "conversation_id": conversation["id"],
                    "timestamp": timestamp.isoformat(),
                    "path": file_url,
                    "source": source,
                    "transcript": transcript,
                },
            )["data"]

        # Only trigger background audio processing if there's a file to process
        if has_file:
            logger.info(f"Triggering background audio processing for chunk {chunk_id}")
            task_process_conversation_chunk.send(chunk_id)
        else:
            logger.info(f"Skipping audio processing for text-only chunk {chunk_id}")

        return chunk

    def update_chunk(
        self,
        chunk_id: str,
        path: Any = _UNSET,
        diarization: Any = _UNSET,
        transcript: Any = _UNSET,
        raw_transcript: Any = _UNSET,
        error: Any = _UNSET,
        hallucination_reason: Any = _UNSET,
        hallucination_score: Any = _UNSET,
        desired_language: Any = _UNSET,
        detected_language: Any = _UNSET,
        detected_language_confidence: Any = _UNSET,
    ) -> dict:
        update: dict[str, Any] = {}

        if raw_transcript is not _UNSET:
            update["raw_transcript"] = raw_transcript

        if diarization is not _UNSET:
            update["diarization"] = diarization

        if transcript is not _UNSET:
            update["transcript"] = transcript

        if path is not _UNSET:
            update["path"] = path

        if error is not _UNSET:
            update["error"] = error

        if hallucination_reason is not _UNSET:
            update["hallucination_reason"] = hallucination_reason

        if hallucination_score is not _UNSET:
            update["hallucination_score"] = hallucination_score

        if desired_language is not _UNSET:
            update["desired_language"] = desired_language

        if detected_language is not _UNSET:
            update["detected_language"] = detected_language

        if detected_language_confidence is not _UNSET:
            update["detected_language_confidence"] = detected_language_confidence

        if update.keys():
            try:
                with self._client_context() as client:
                    chunk = client.update_item(
                        "conversation_chunk",
                        chunk_id,
                        update,
                    )["data"]

                    return chunk
            except DirectusBadRequest as e:
                raise ConversationServiceException(f"Failed to update chunk {chunk_id}: {e}") from e
        else:
            raise ConversationServiceException(f"No update data provided for chunk {chunk_id}")

    def delete_chunk(
        self,
        chunk_id: str,
    ) -> None:
        with self._client_context() as client:
            client.delete_item("conversation_chunk", chunk_id)

    def get_chunk_counts(
        self,
        conversation_id: str,
    ) -> dict:
        """

        total = error + pending + ok
        total = processed + pending
        processed = error + ok

        Returns:
        {
            "total": int,
            "processed": int,
            "pending": int,
            "error": int,
            "ok": int,
        }
        """
        try:
            with self._client_context() as client:
                chunks = client.get_items(
                    "conversation_chunk",
                    {
                        "query": {
                            "filter": {"conversation_id": conversation_id},
                            "fields": ["id", "error", "transcript"],
                        }
                    },
                )
        except DirectusBadRequest as e:
            raise ConversationServiceException(
                f"Failed to get chunk count for conversation {conversation_id}: {e}"
            ) from e

        total = len(chunks)
        error = 0
        pending = 0
        ok = 0

        for chunk in chunks:
            if chunk["error"] is not None:
                error += 1
            elif chunk["transcript"] is not None:
                ok += 1
            else:
                pending += 1

        processed = error + ok

        assert total == processed + pending
        assert total == error + ok + pending
        assert processed == error + ok

        return {
            "total": total,
            "processed": processed,
            "error": error,
            "pending": pending,
            "ok": ok,
        }

    def _list_conversations(
        self,
        filter_query: dict[str, Any],
        with_chunks: bool = False,
        with_tags: bool = False,
    ) -> List[dict]:
        fields: List[str] = [
            "id",
            "project_id",
            "participant_name",
            "participant_email",
            "participant_user_agent",
            "created_at",
            "updated_at",
            "duration",
            "summary",
            "source",
            "is_finished",
            "is_all_chunks_transcribed",
        ]

        deep: dict[str, Any] = {}

        if with_tags:
            fields.extend(
                [
                    "tags.id",
                    "tags.project_tag_id.id",
                    "tags.project_tag_id.text",
                ]
            )
            deep.setdefault("tags", {})

        if with_chunks:
            fields.extend(
                [
                    "chunks.id",
                    "chunks.timestamp",
                    "chunks.transcript",
                    "chunks.path",
                ]
            )
            deep["chunks"] = {"_sort": "timestamp"}

        try:
            with self._client_context() as client:
                conversations: Optional[List[dict]] = client.get_items(
                    "conversation",
                    {
                        "query": {
                            "filter": filter_query,
                            "fields": fields,
                            "deep": deep,
                            "limit": 1000,
                        }
                    },
                )
        except DirectusBadRequest as e:
            logger.error("Failed to list conversations via Directus: %s", e)
            raise ConversationServiceException() from e

        return conversations or []

    def get_verified_artifacts(self, conversation_id: str, limit: int = 3) -> List[dict]:
        try:
            with self._client_context() as client:
                artifacts = client.get_items(
                    "conversation_artifact",
                    {
                        "query": {
                            "filter": {
                                "conversation_id": conversation_id,
                                "approved_at": {"_nnull": True},
                            },
                            "fields": ["id", "key", "content"],
                            "sort": "-approved_at",
                            "limit": limit,
                        }
                    },
                )
        except DirectusBadRequest as e:
            logger.error(
                "Failed to get verified artifacts for conversation %s via Directus: %s",
                conversation_id,
                e,
            )
            raise ConversationServiceException() from e
        except (KeyError, IndexError) as e:
            raise ConversationServiceException() from e

        return artifacts or []
