# conversation.py
from typing import TYPE_CHECKING, Any, List, Optional
from datetime import datetime

from fastapi import UploadFile

from dembrane.utils import generate_uuid
from dembrane.directus import DirectusBadRequest, directus_client_context

if TYPE_CHECKING:
    from dembrane.service.file import FileService
    from dembrane.service.project import ProjectService

# allows for None to be a sentinel value
_UNSET = object()


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
        file_service: "FileService",
        project_service: "ProjectService",
    ):
        self.file_service = file_service
        self.project_service = project_service

    def get_by_id_or_raise(
        self,
        conversation_id: str,
        with_tags: bool = False,
        with_chunks: bool = False,
    ) -> dict:
        try:
            with directus_client_context() as client:
                fields = ["*"]
                deep = {}

                if with_tags:
                    fields.append("tags.project_tag_id.*")

                if with_chunks:
                    fields.append("chunks.*")
                    deep["chunks"] = {"_sort": "-timestamp"}

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

        except DirectusBadRequest as e:
            raise ConversationNotFoundException() from e

        try:
            return conversation[0]
        except (KeyError, IndexError) as e:
            raise ConversationNotFoundException() from e

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

        with directus_client_context() as client:
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
            with directus_client_context() as client:
                updated_conversation = client.update_item(
                    "conversation",
                    conversation_id,
                    update_data,
                )["data"]

            return updated_conversation
        except DirectusBadRequest as e:
            raise ConversationNotFoundException() from e

    def delete(
        self,
        conversation_id: str,
    ) -> None:
        with directus_client_context() as client:
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
            with directus_client_context() as client:
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

        # if conversation.get("is_finished", False) is True:
        #     raise ConversationNotOpenForParticipationException()

        chunk_id = generate_uuid()

        needs_upload = file_obj is not None and file_url is None
        if needs_upload:
            assert file_obj is not None
            file_name = f"conversation/{conversation['id']}/chunks/{chunk_id}-{file_obj.filename}"
            file_url = self.file_service.save(file=file_obj, key=file_name, public=False)

        with directus_client_context() as client:
            chunk = client.create_item(
                "conversation_chunk",
                item_data={
                    "id": chunk_id,
                    "conversation_id": conversation["id"],
                    "timestamp": timestamp.isoformat(),
                    "path": file_url if needs_upload else None,
                    "source": source,
                    "transcript": transcript,
                },
            )["data"]

        # self.event_service.publish(
        #     ChunkCreatedEvent(
        #         chunk_id=chunk_id,
        #         conversation_id=conversation["id"],
        #     )
        # )

        task_process_conversation_chunk.send(chunk_id)

        return chunk

    def update_chunk(
        self,
        chunk_id: str,
        path: Any = _UNSET,
        diarization: Any = _UNSET,
        transcript: Any = _UNSET,
        raw_transcript: Any = _UNSET,
        runpod_job_status_link: Any = _UNSET,
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

        if runpod_job_status_link is not _UNSET:
            update["runpod_job_status_link"] = runpod_job_status_link

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
                with directus_client_context() as client:
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
        with directus_client_context() as client:
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
            with directus_client_context() as client:
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
