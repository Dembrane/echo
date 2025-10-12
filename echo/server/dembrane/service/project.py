# project.py
from typing import Any, List
from logging import getLogger

from dembrane.directus import DirectusBadRequest, directus_client_context

PROJECT_ALLOWED_LANGUAGES = ["en", "nl", "de", "fr", "es"]


class ProjectServiceException(Exception):
    pass


class ProjectNotFoundException(ProjectServiceException):
    pass


logger = getLogger(__name__)


class ProjectService:
    def get_by_id_or_raise(
        self,
        project_id: str,
        with_tags: bool = False,
    ) -> dict:
        try:
            with directus_client_context() as client:
                fields = ["*"]

                if with_tags:
                    fields.append("tags.id")
                    fields.append("tags.created_at")
                    fields.append("tags.text")

                projects = client.get_items(
                    "project",
                    {
                        "query": {
                            "filter": {
                                "id": project_id,
                            },
                            "fields": fields,
                        }
                    },
                )

        except DirectusBadRequest as e:
            raise ProjectNotFoundException() from e

        try:
            return projects[0]
        except (KeyError, IndexError) as e:
            raise ProjectNotFoundException() from e

    def create(
        self,
        name: str,
        language: str,
        is_conversation_allowed: bool,
        directus_user_id: str | None = None,
        **kwargs: Any,
    ) -> dict:
        with directus_client_context() as client:
            project = client.create_item(
                "project",
                item_data={
                    "name": name,
                    "language": language,
                    "is_conversation_allowed": is_conversation_allowed,
                    "directus_user_id": directus_user_id,
                    **kwargs,
                },
            )["data"]

        return project

    def delete(
        self,
        project_id: str,
    ) -> None:
        with directus_client_context() as client:
            client.delete_item("project", project_id)

    def create_tags_and_link(
        self,
        project_id: str,
        tag_str_list: List[str],
    ) -> List[dict]:
        with directus_client_context() as client:
            project = self.get_by_id_or_raise(project_id)

            create_tag_data = [
                {
                    "project_id": project.get("id"),
                    "text": tag_str,
                }
                for tag_str in tag_str_list
            ]

            logger.debug(f"create_tag_data: {create_tag_data}")

            tags: List[dict] = client.create_item(
                "project_tag",
                item_data=create_tag_data,
            )["data"]

            logger.debug(f"tags: {tags}")

        return tags

    def create_shallow_clone(
        self,
        project_id: str,
        with_tags: bool = False,
        **overrides: Any,
    ) -> str:
        """
        Create a shallow clone of a project
        The clone will NOT include any relational data (conversations, etc.)
        """
        logger.debug(f"Project clone requested: {project_id}")
        current_project = self.get_by_id_or_raise(project_id, with_tags=with_tags)

        new_project_data = {
            "name": current_project["name"],
            "language": current_project["language"],
            "is_conversation_allowed": current_project["is_conversation_allowed"],
            "directus_user_id": current_project["directus_user_id"],
            "context": current_project["context"],
            "default_conversation_title": current_project["default_conversation_title"],
            "default_conversation_description": current_project["default_conversation_description"],
            "default_conversation_finish_text": current_project["default_conversation_finish_text"],
            "default_conversation_ask_for_participant_name": current_project[
                "default_conversation_ask_for_participant_name"
            ],
            "default_conversation_tutorial_slug": current_project[
                "default_conversation_tutorial_slug"
            ],
            "default_conversation_transcript_prompt": current_project[
                "default_conversation_transcript_prompt"
            ],
            "conversation_ask_for_participant_name_label": current_project[
                "conversation_ask_for_participant_name_label"
            ],
            "image_generation_model": current_project["image_generation_model"],
            "is_enhanced_audio_processing_enabled": current_project[
                "is_enhanced_audio_processing_enabled"
            ],
            "is_get_reply_enabled": current_project["is_get_reply_enabled"],
            "is_project_notification_subscription_allowed": current_project[
                "is_project_notification_subscription_allowed"
            ],
        }

        if overrides:
            logger.debug(f"overrides to be applied: {overrides.keys()}")

            if "id" in overrides:
                raise ValueError("The id field cannot be provided")

            new_project_data.update(overrides)

        new_project = self.create(**new_project_data)

        if with_tags:
            logger.debug(f"Creating tags and linking to project {new_project['id']}")
            tag_str_list: List[str] = []

            for tag_dict in current_project.get("tags", []):
                if isinstance(tag_dict, dict):
                    tag_str_list.append(tag_dict.get("text", ""))

            if len(tag_str_list) > 0:
                logger.debug(
                    f"Creating tags and linking to project {new_project['id']}: {tag_str_list}"
                )
                self.create_tags_and_link(new_project["id"], tag_str_list)

        return new_project["id"]
