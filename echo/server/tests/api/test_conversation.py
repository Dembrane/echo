import logging

import pytest

from tests.common import (
    create_project,
    delete_project,
    create_conversation,
    delete_conversation,
    create_conversation_chunk,
    delete_conversation_chunk,
)
from dembrane.directus import directus
from dembrane.api.conversation import summarize_conversation, get_conversation_transcript
from dembrane.api.dependency_auth import DirectusSession

logger = logging.getLogger("dembrane.tests.api.test_conversation")

pytestmark = pytest.mark.integration


@pytest.mark.asyncio
async def test_get_conversation_transcript():
    project = create_project("test", "en")
    conversation = create_conversation(project["id"], "test")
    chunks = [
        create_conversation_chunk(conversation["id"], "check123"),
        create_conversation_chunk(conversation["id"], "check456"),
    ]

    transcript = await get_conversation_transcript(
        conversation["id"], auth=DirectusSession(user_id="none", is_admin=True)
    )
    assert transcript == "check123\ncheck456"

    for chunk in chunks:
        delete_conversation_chunk(chunk["id"])

    delete_conversation(conversation["id"])
    delete_project(project["id"])


@pytest.mark.asyncio
async def test_summarize_conversation():
    project = create_project("test", "en")
    conversation = create_conversation(project["id"], "test")

    response = await summarize_conversation(
        conversation["id"], auth=DirectusSession(user_id="none", is_admin=True)
    )

    assert response["status"] == "success"
    assert "summary" not in response

    chunk = create_conversation_chunk(conversation["id"], "Hello, how are you?")

    response = await summarize_conversation(
        conversation["id"], auth=DirectusSession(user_id="none", is_admin=True)
    )

    test_conv = directus.get_item("conversation", conversation["id"])

    assert response["status"] == "success"
    assert response["summary"] is not None
    assert test_conv["summary"] == response["summary"]

    logger.info(response["summary"])

    delete_project(project["id"])
    delete_conversation(conversation["id"])
    delete_conversation_chunk(chunk["id"])
