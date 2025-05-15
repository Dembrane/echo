import logging
from typing import List

import backoff
import litellm

# from dembrane.openai import client

EMBEDDING_DIM = 1536

logger = logging.getLogger("embedding")
logger.setLevel(logging.DEBUG)


@backoff.on_exception(backoff.expo, (Exception), max_tries=5)
def embed_text(text: str) -> List[float]:
    text = text.replace("\n", " ").strip()
    try:
        response = litellm.embedding(
            model="text-embedding-3-small",
            input=[text]
        )
        return response["data"][0]["embedding"]
    except Exception as exc:
        logger.debug("error:" + str(exc))
        logger.debug("input text:" + text)
        raise exc
