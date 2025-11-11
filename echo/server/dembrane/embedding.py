import logging
from typing import List

import backoff
import litellm

from dembrane.llms import MODELS, resolve_config

EMBEDDING_DIM = 3072

logger = logging.getLogger("embedding")
logger.setLevel(logging.DEBUG)


@backoff.on_exception(backoff.expo, (Exception), max_tries=5)
def embed_text(text: str) -> List[float]:
    text = text.replace("\n", " ").strip()
    try:
        config = resolve_config(MODELS.MULTI_MODAL_PRO)
        if not config.model:
            raise ValueError("Embedding model is not configured.")
        response = litellm.embedding(
            api_key=config.api_key,
            api_base=config.api_base,
            api_version=config.api_version,
            model=config.model,
            input=text,
        )
        return response["data"][0]["embedding"]
    except Exception as exc:
        logger.debug("error:" + str(exc))
        logger.debug("input text:" + text)
        raise exc
