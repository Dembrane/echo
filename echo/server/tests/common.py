from dembrane.directus import directus


def create_project(name: str, language: str):
    return directus.create_item(
        "project", {"name": name, "language": language, "is_conversation_allowed": True}
    )["data"]


def delete_project(project_id: str):
    directus.delete_item("project", project_id)


def create_conversation(project_id: str, name: str):
    return directus.create_item(
        "conversation", {"name": name, "project_id": project_id, "is_conversation_allowed": True}
    )["data"]


def delete_conversation(conversation_id: str):
    directus.delete_item("conversation", conversation_id)


def create_conversation_chunk(conversation_id: str, transcript: str):
    return directus.create_item(
        "conversation_chunk",
        {
            "transcript": transcript,
            "conversation_id": conversation_id,
        },
    )["data"]


def delete_conversation_chunk(conversation_chunk_id: str):
    directus.delete_item("conversation_chunk", conversation_chunk_id)
