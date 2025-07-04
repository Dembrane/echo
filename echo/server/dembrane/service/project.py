from typing import List
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
    ) -> dict:
        with directus_client_context() as client:
            project = client.create_item(
                "project",
                item_data={
                    "name": name,
                    "language": language,
                    "is_conversation_allowed": is_conversation_allowed,
                    "directus_user_id": directus_user_id,
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
