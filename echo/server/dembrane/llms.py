from __future__ import annotations

import json
import logging
from enum import Enum
from typing import TYPE_CHECKING, Any, Dict, Optional

from dembrane.settings import get_settings

if TYPE_CHECKING:
    from litellm import Router  # type: ignore[attr-defined]

logger = logging.getLogger(__name__)


class MODELS(Enum):
    MULTI_MODAL_PRO = "MULTI_MODAL_PRO"  # Gemini 2.5 Pro – chat/report/inference
    MULTI_MODAL_FAST = "MULTI_MODAL_FAST"  # Gemini 2.5 Flash – realtime/verification
    TEXT_FAST = "TEXT_FAST"  # GPT-5 style small text model – summaries & utilities


MODEL_REGISTRY: Dict[MODELS, Dict[str, str]] = {
    MODELS.MULTI_MODAL_PRO: {"settings_attr": "multi_modal_pro"},
    MODELS.MULTI_MODAL_FAST: {"settings_attr": "multi_modal_fast"},
    MODELS.TEXT_FAST: {"settings_attr": "text_fast"},
}

# Cached router instance
_cached_router: Optional["Router"] = None


def get_completion_kwargs(model: MODELS, **overrides: Any) -> Dict[str, Any]:
    """
    Return the kwargs to pass into LiteLLM helpers for a configured model.
    """
    settings = get_settings()
    attr = MODEL_REGISTRY[model]["settings_attr"]
    provider = getattr(settings.llms, attr, None)
    if provider is None:
        raise ValueError(f"No configuration found for model group {model.value}.")

    resolved = provider.resolve()

    kwargs: Dict[str, Any] = {"model": resolved.model}

    if resolved.api_key:
        kwargs["api_key"] = resolved.api_key
    if resolved.api_base:
        kwargs["api_base"] = resolved.api_base
    if resolved.api_version:
        kwargs["api_version"] = resolved.api_version
    # Vertex AI models are prefixed with "vertex_ai/"
    # We don't want to pass the transcription GCP SA JSON to these models.
    if kwargs["model"].startswith("vertex_ai/"):
        vertex_credentials = resolved.vertex_credentials or settings.transcription.gcp_sa_json
    else:
        vertex_credentials = None
    if vertex_credentials:
        kwargs["vertex_credentials"] = json.dumps(vertex_credentials)
    if resolved.vertex_project:
        kwargs["vertex_project"] = resolved.vertex_project
    if resolved.vertex_location:
        kwargs["vertex_location"] = resolved.vertex_location

    # Allow callers to override any field (e.g., temperature, max_tokens)
    kwargs.update(overrides)
    return kwargs


def _get_router() -> "Router":
    """
    Get the LiteLLM Router instance (lazy import to avoid circular deps).
    """
    global _cached_router
    if _cached_router is None:
        from dembrane.llm_router import get_router
        _cached_router = get_router()
    return _cached_router


async def arouter_completion(model: MODELS, **kwargs: Any) -> Any:
    """
    Async completion via LiteLLM Router with automatic load balancing and failover.

    The router will:
    - Distribute requests across configured deployments
    - Automatically retry on failures
    - Cooldown failing deployments
    - Fall back to alternate model groups if configured

    Args:
        model: The model group to use (MODELS.TEXT_FAST, MODELS.MULTI_MODAL_PRO, etc.)
        **kwargs: Arguments passed to litellm.acompletion (messages, temperature, etc.)

    Returns:
        LiteLLM completion response

    Example:
        response = await arouter_completion(
            MODELS.TEXT_FAST,
            messages=[{"role": "user", "content": "Hello!"}],
            temperature=0.7,
        )
    """
    router = _get_router()
    model_name = MODEL_REGISTRY[model]["settings_attr"]
    return await router.acompletion(model=model_name, **kwargs)


def router_completion(model: MODELS, **kwargs: Any) -> Any:
    """
    Sync completion via LiteLLM Router with automatic load balancing and failover.

    Use this for synchronous code paths (e.g., Dramatiq tasks).
    For async code, prefer arouter_completion().

    Args:
        model: The model group to use (MODELS.TEXT_FAST, MODELS.MULTI_MODAL_PRO, etc.)
        **kwargs: Arguments passed to litellm.completion (messages, temperature, etc.)

    Returns:
        LiteLLM completion response
    """
    router = _get_router()
    model_name = MODEL_REGISTRY[model]["settings_attr"]
    return router.completion(model=model_name, **kwargs)


__all__ = ["MODELS", "get_completion_kwargs", "arouter_completion", "router_completion"]
