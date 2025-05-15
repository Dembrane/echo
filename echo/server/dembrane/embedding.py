import logging
from typing import List

import backoff
import litellm

from dembrane.config import (
    # FIXME: update to use dembrane embeddings
    LIGHTRAG_LITELLM_EMBEDDING_API_KEY,
    LIGHTRAG_LITELLM_EMBEDDING_API_BASE,
    LIGHTRAG_LITELLM_EMBEDDING_API_VERSION,
)

EMBEDDING_DIM = 3072

logger = logging.getLogger("embedding")
logger.setLevel(logging.DEBUG)


@backoff.on_exception(backoff.expo, (Exception), max_tries=5)
def embed_text(text: str) -> List[float]:
    text = text.replace("\n", " ").strip()
    try:
        response = litellm.embedding(
            api_key=str(LIGHTRAG_LITELLM_EMBEDDING_API_KEY),
            api_base=str(LIGHTRAG_LITELLM_EMBEDDING_API_BASE),
            api_version=str(LIGHTRAG_LITELLM_EMBEDDING_API_VERSION),
            model="azure/text-embedding-3-large",
            input=[text],
        )
        return response["data"][0]["embedding"]
    except Exception as exc:
        logger.debug("error:" + str(exc))
        logger.debug("input text:" + text)
        raise exc
