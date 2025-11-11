import logging
from typing import List

import backoff
import litellm

from dembrane.settings import get_settings

EMBEDDING_DIM = 3072

logger = logging.getLogger("embedding")
logger.setLevel(logging.DEBUG)

settings = get_settings()
embedding_settings = settings.embedding


@backoff.on_exception(backoff.expo, (Exception), max_tries=5)
def embed_text(text: str) -> List[float]:
    text = text.replace("\n", " ").strip()
    try:
        if not embedding_settings.model:
            raise ValueError("Embedding model is not configured.")

        embedding_kwargs = {
            "model": embedding_settings.model,
        }
        if embedding_settings.api_key:
            embedding_kwargs["api_key"] = embedding_settings.api_key
        if embedding_settings.base_url:
            embedding_kwargs["api_base"] = embedding_settings.base_url
        if embedding_settings.api_version:
            embedding_kwargs["api_version"] = embedding_settings.api_version

        response = litellm.embedding(
            **embedding_kwargs,
            input=text,
        )
        return response["data"][0]["embedding"]
    except Exception as exc:
        logger.debug("error:" + str(exc))
        logger.debug("input text:" + text)
        raise exc
