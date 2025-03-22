from logging import getLogger

from directus_sdk_py import DirectusClient  # type: ignore

from dembrane.config import DIRECTUS_TOKEN, DIRECTUS_BASE_URL

logger = getLogger(__name__)

if DIRECTUS_TOKEN:
    directus_token = DIRECTUS_TOKEN
    logger.debug(f"DIRECTUS_TOKEN: {directus_token}")

directus = DirectusClient(url=DIRECTUS_BASE_URL, token=directus_token)


def create_directus_segment(configid: str, counter: float) -> str:
    response = directus.create_item(
            "conversation_segment",
            item_data={
                "config_id": configid,
                "counter": counter,
            },
        )
    directus_id = response['data']['id']
    return directus_id

def delete_directus_segment(segment_id: str) -> None:
    directus.delete_item("conversation_segment", segment_id)

def get_conversation_by_segment(conversation_id: str, segment_id: str) -> dict:
    response = directus.read_item("conversation", conversation_id, fields=["*"], filter={"segment": segment_id})
    return response['data']