from __future__ import annotations

import logging
from enum import Enum
from typing import Any, Dict, Mapping, Optional, Sequence

import litellm

from dembrane.settings import LLMProviderConfig, ResolvedLLMConfig, get_settings

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


def _get_provider_config(model: MODELS) -> LLMProviderConfig:
    settings = get_settings()
    attr = MODEL_REGISTRY[model]["settings_attr"]
    provider = getattr(settings.llms, attr, None)
    if provider is None:
        raise ValueError(f"No configuration found for model group {model.value}.")
    return provider


def resolve_config(model: MODELS) -> ResolvedLLMConfig:
    """
    Load the configured model credentials for the requested model group.
    """
    provider = _get_provider_config(model)
    return provider.resolve()


def get_completion_kwargs(model: MODELS, **overrides: Any) -> Dict[str, Any]:
    """
    Return the kwargs to pass into LiteLLM completion helpers for a configured model.
    """
    resolved = resolve_config(model)
    kwargs: Dict[str, Any] = {"model": resolved.model}

    if resolved.api_key:
        kwargs["api_key"] = resolved.api_key
    if resolved.api_base:
        kwargs["api_base"] = resolved.api_base
    if resolved.api_version:
        kwargs["api_version"] = resolved.api_version

    # Allow callers to override any field (e.g., temperature, max_tokens)
    kwargs.update(overrides)
    return kwargs


def count_tokens(
    model: MODELS,
    messages: Optional[Sequence[Mapping[str, Any]]] = None,
    *,
    text: Optional[str | Sequence[str]] = None,
    **litellm_kwargs: Any,
) -> int:
    """
    Count prompt tokens using the tokenizer associated with the configured model.
    """
    resolved = resolve_config(model)
    try:
        return litellm.token_counter(
            model=resolved.model,
            messages=list(messages) if messages is not None else None,
            text=text,
            **litellm_kwargs,
        )
    except Exception as exc:  # pragma: no cover - defensive logging
        logger.debug(
            "Failed to count tokens",
            extra={"model": resolved.model, "error": str(exc)},
        )
        raise


__all__ = ["MODELS", "resolve_config", "get_completion_kwargs", "count_tokens"]
