from __future__ import annotations

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
    if not provider.model:
        raise ValueError(f"Model name is not configured for {model.value}")

    kwargs: Dict[str, Any] = {"model": provider.model}

    if provider.api_key:
        kwargs["api_key"] = provider.api_key
    if provider.api_base:
        kwargs["api_base"] = provider.api_base
    if provider.api_version:
        kwargs["api_version"] = provider.api_version

    # Allow callers to override any field (e.g., temperature, max_tokens)
    kwargs.update(overrides)
    return kwargs


__all__ = ["MODELS", "get_completion_kwargs"]
