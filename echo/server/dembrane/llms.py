from __future__ import annotations

import json
import logging
from enum import Enum
from typing import Any, Dict

from dembrane.settings import get_settings

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


__all__ = ["MODELS", "get_completion_kwargs"]
