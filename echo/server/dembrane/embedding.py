import re
import json
import hashlib
import logging
from typing import Any, Dict, List, Optional
from dataclasses import asdict, dataclass

import backoff
import litellm

from dembrane.settings import get_settings

EMBEDDING_DIM = 3072

logger = logging.getLogger("embedding")
logger.setLevel(logging.DEBUG)

settings = get_settings()
embedding_settings = settings.embedding

_REGIONAL_HOST = re.compile(r"^https://([a-z0-9-]+)-aiplatform\.googleapis\.com/?$")

# How an input is prepared before it is embedded. Part of the configuration
# identity: a change here is a different embedding space for caching purposes.
INPUT_NORMALIZATION = "collapse-whitespace-v1"


def normalize_embedding_input(text: str) -> str:
    return " ".join(text.split())


def _vertex_embedding_kwargs() -> Dict[str, Any]:
    """Credentials for a Vertex embedding model, the way the LLM groups get
    theirs: the fast group's service account (or transcription's), its project,
    and the region. A regional EMBEDDING_BASE_URL names the region; litellm
    builds the Vertex URL itself from location and project, so the base URL is
    not passed through as api_base."""
    kwargs: Dict[str, Any] = {}
    fast = settings.llms.multi_modal_fast
    credentials = fast.vertex_credentials or fast.gcp_sa_json or settings.transcription.gcp_sa_json
    if credentials:
        kwargs["vertex_credentials"] = json.dumps(credentials)
    if fast.vertex_project:
        kwargs["vertex_project"] = fast.vertex_project
    match = _REGIONAL_HOST.match(embedding_settings.base_url or "")
    location = match.group(1) if match else fast.vertex_location
    if location:
        kwargs["vertex_location"] = location
    return kwargs


def embedding_kwargs() -> Dict[str, Any]:
    """The litellm.embedding kwargs for the configured deployment."""
    if not embedding_settings.model:
        raise ValueError("Embedding model is not configured.")

    kwargs: Dict[str, Any] = {"model": embedding_settings.model}
    if embedding_settings.api_key:
        kwargs["api_key"] = embedding_settings.api_key
    if embedding_settings.base_url:
        kwargs["api_base"] = embedding_settings.base_url
    if embedding_settings.api_version:
        kwargs["api_version"] = embedding_settings.api_version
    if embedding_settings.model.startswith("vertex_ai/") and not embedding_settings.api_key:
        vertex = _vertex_embedding_kwargs()
        if _REGIONAL_HOST.match(embedding_settings.base_url or ""):
            kwargs.pop("api_base", None)
        kwargs.update(vertex)
    return kwargs


@backoff.on_exception(backoff.expo, (Exception), max_tries=5)
def embed_text(text: str) -> List[float]:
    text = text.replace("\n", " ").strip()
    try:
        response = litellm.embedding(
            **embedding_kwargs(),
            input=text,
        )
        return response["data"][0]["embedding"]
    except Exception as exc:
        # The input is participant-derived text: log its size, never its body.
        logger.debug("embedding error: %s (input of %d characters)", exc, len(text))
        raise exc


@dataclass(frozen=True)
class EmbeddingIdentity:
    """Everything that decides which vector space an embedding lives in.

    Vectors are only ever compared within one identity. `key` names it in
    storage; `dims` is what the provider actually returned, not a constant."""

    model: str
    endpoint: Optional[str]
    dims: int
    input_normalization: str = INPUT_NORMALIZATION
    task_type: Optional[str] = None

    @property
    def key(self) -> str:
        payload = json.dumps(asdict(self), sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    def as_config(self) -> Dict[str, Any]:
        return {**asdict(self), "key": self.key}


def _endpoint_identity() -> Optional[str]:
    kwargs = embedding_kwargs()
    if kwargs.get("vertex_location"):
        return f"vertex:{kwargs.get('vertex_project') or ''}:{kwargs['vertex_location']}"
    return kwargs.get("api_base")


PROBE_TEXT = "dembrane embedding dimension probe"


def probe_embedding_identity() -> EmbeddingIdentity:
    """One small request to learn the configured deployment's real dimensions."""
    vector = embed_text(PROBE_TEXT)
    if not isinstance(vector, list) or not vector:
        raise ValueError("Embedding probe returned no vector.")
    return EmbeddingIdentity(
        model=str(embedding_settings.model),
        endpoint=_endpoint_identity(),
        dims=len(vector),
    )
