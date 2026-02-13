"""
LiteLLM Router for distributed load balancing and failover.

This module provides a centralized router that:
- Load balances across multiple LLM deployments per model group
- Handles automatic failover when deployments fail or hit rate limits
- Uses Redis for distributed cooldown and usage tracking
- Supports weighted routing based on deployment priority

Usage:
    from dembrane.llm_router import get_router

    router = get_router()
    response = await router.acompletion(model="text_fast", messages=[...])
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Literal, Optional

from litellm import Router  # type: ignore[attr-defined]
from litellm.utils import get_model_info

from dembrane.settings import LLMProviderConfig, get_settings

logger = logging.getLogger(__name__)

# Default context length if model info unavailable
DEFAULT_CONTEXT_LENGTH = 128000

# Router configuration constants
ROUTER_NUM_RETRIES = 3
ROUTER_ALLOWED_FAILS = 3  # Failures per minute before cooldown
ROUTER_COOLDOWN_TIME = 60  # Seconds to cooldown a failed deployment
ROUTER_ROUTING_STRATEGY: Literal["simple-shuffle"] = "simple-shuffle"  # Recommended for production

# Global router instance (lazy initialized)
_router: Optional[Router] = None


def _infer_weight(suffix: Optional[int]) -> int:
    """
    Infer deployment weight from its numeric suffix.

    Primary (no suffix) gets highest weight (10).
    Fallbacks decrease: _1 = 9, _2 = 8, etc.
    Minimum weight is 1.
    """
    if suffix is None:
        return 10  # Primary deployment
    return max(1, 10 - suffix)


def _build_litellm_params(config: LLMProviderConfig) -> Dict[str, Any]:
    """
    Convert LLMProviderConfig to litellm_params dict for Router model_list.
    """
    resolved = config.resolve()
    params: Dict[str, Any] = {"model": resolved.model}

    if resolved.api_key:
        params["api_key"] = resolved.api_key
    if resolved.api_base:
        params["api_base"] = resolved.api_base
    if resolved.api_version:
        params["api_version"] = resolved.api_version
    if resolved.vertex_credentials:
        params["vertex_credentials"] = json.dumps(resolved.vertex_credentials)
    if resolved.vertex_project:
        params["vertex_project"] = resolved.vertex_project
    if resolved.vertex_location:
        params["vertex_location"] = resolved.vertex_location

    return params


def _build_model_list() -> List[Dict[str, Any]]:
    """
    Build the model_list for LiteLLM Router from all configured deployments.

    Scans environment for LLM__<GROUP>__* and LLM__<GROUP>_N__* patterns.
    Returns list formatted for Router initialization.
    """
    settings = get_settings()
    model_list: List[Dict[str, Any]] = []

    for group in settings.llms.get_all_model_groups():
        deployments = settings.llms.get_deployments_for_group(group)

        for suffix, config in deployments:
            weight = _infer_weight(suffix)
            litellm_params = _build_litellm_params(config)

            # Add weight to litellm_params for weighted routing
            litellm_params["weight"] = weight

            model_list.append(
                {
                    "model_name": group,  # e.g., "text_fast", "multi_modal_pro"
                    "litellm_params": litellm_params,
                }
            )

    return model_list


def _log_deployment_summary(model_list: List[Dict[str, Any]]) -> None:
    """
    Log a summary of all configured deployments at startup.
    """
    # Group by model_name
    by_group: Dict[str, List[Dict[str, Any]]] = {}
    for entry in model_list:
        group = entry["model_name"]
        if group not in by_group:
            by_group[group] = []
        by_group[group].append(entry)

    logger.info("LiteLLM Router deployment summary:")
    for group, entries in sorted(by_group.items()):
        logger.info(f"  {group}: {len(entries)} deployment(s)")
        for i, entry in enumerate(entries):
            params = entry["litellm_params"]
            model = params.get("model", "unknown")
            location = params.get("vertex_location") or params.get("api_base", "default")
            weight = params.get("weight", "?")
            label = "primary" if i == 0 else "fallback"
            logger.info(f"    [{i}] {model} @ {location} ({label}, weight={weight})")

    if not model_list:
        logger.warning("  No LLM deployments configured!")


def _parse_redis_url(redis_url: str) -> Dict[str, Any]:
    """
    Parse Redis URL into host/port/password for LiteLLM Router.
    """
    # Handle redis://user:pass@host:port/db format
    from urllib.parse import urlparse

    parsed = urlparse(redis_url)
    result: Dict[str, Any] = {}

    if parsed.hostname:
        result["redis_host"] = parsed.hostname
    if parsed.port:
        result["redis_port"] = parsed.port
    if parsed.password:
        result["redis_password"] = parsed.password

    return result


def _build_router() -> Optional[Router]:
    """
    Build and configure the LiteLLM Router.

    Returns None if no deployments are configured.
    """
    model_list = _build_model_list()

    if not model_list:
        logger.warning("No LLM deployments found. Router not initialized.")
        return None

    _log_deployment_summary(model_list)

    settings = get_settings()

    # Parse Redis URL for distributed state
    redis_config = _parse_redis_url(settings.cache.redis_url)

    # Build fallbacks: text_fast -> multi_modal_pro (for text-only workloads)
    fallbacks = [{"text_fast": ["multi_modal_pro"]}]

    try:
        router = Router(
            model_list=model_list,
            routing_strategy=ROUTER_ROUTING_STRATEGY,
            num_retries=ROUTER_NUM_RETRIES,
            allowed_fails=ROUTER_ALLOWED_FAILS,
            cooldown_time=ROUTER_COOLDOWN_TIME,
            fallbacks=fallbacks,
            enable_pre_call_checks=True,  # EU region filtering
            **redis_config,
        )
        logger.info(
            f"LiteLLM Router initialized with {len(model_list)} deployments "
            f"(retries={ROUTER_NUM_RETRIES}, cooldown={ROUTER_COOLDOWN_TIME}s)"
        )
        return router
    except Exception as e:
        logger.error(f"Failed to initialize LiteLLM Router: {e}")
        raise


def get_router() -> Router:
    """
    Get the global LiteLLM Router instance (lazy initialization).

    Raises ValueError if no deployments are configured.
    """
    global _router
    if _router is None:
        _router = _build_router()
        if _router is None:
            raise ValueError(
                "LLM Router could not be initialized. "
                "Ensure at least one LLM__<GROUP>__MODEL is configured."
            )
    return _router


def is_router_available() -> bool:
    """
    Check if the router can be initialized.

    Returns True if at least one deployment is configured.
    """
    try:
        model_list = _build_model_list()
        return len(model_list) > 0
    except Exception:
        return False


# Cache for minimum context lengths per model group
_min_context_lengths: Dict[str, int] = {}


def get_min_context_length(model_group: str) -> int:
    """
    Get the minimum context length across all deployments for a model group.

    This ensures we don't exceed context limits when the router picks any deployment.
    Uses 80% of the actual limit to leave headroom for responses.

    Args:
        model_group: e.g., "text_fast", "multi_modal_pro"

    Returns:
        Minimum safe context length (tokens) for the model group
    """
    global _min_context_lengths

    if model_group in _min_context_lengths:
        return _min_context_lengths[model_group]

    settings = get_settings()
    deployments = settings.llms.get_deployments_for_group(model_group)

    if not deployments:
        logger.warning(f"No deployments found for {model_group}, using default context length")
        return int(DEFAULT_CONTEXT_LENGTH * 0.8)

    min_tokens = None

    for suffix, config in deployments:
        try:
            resolved = config.resolve()
            model_info = get_model_info(resolved.model)
            max_tokens = model_info.get("max_input_tokens") if model_info else None
            if isinstance(max_tokens, int) and max_tokens > 0:
                if min_tokens is None:
                    min_tokens = max_tokens
                elif max_tokens < min_tokens:
                    min_tokens = max_tokens
                    logger.debug(f"  {model_group}[{suffix}] {resolved.model}: {max_tokens} tokens")
        except Exception as e:
            logger.warning(f"Could not get model info for {config.model}: {e}")

    if min_tokens is None:
        logger.warning(f"Could not determine context length for {model_group}, using default")
        min_tokens = DEFAULT_CONTEXT_LENGTH

    # Use 80% to leave headroom for response
    safe_length = int(min_tokens * 0.8)
    _min_context_lengths[model_group] = safe_length

    logger.info(
        f"Context length for {model_group}: {safe_length} tokens "
        f"(80% of min={min_tokens} across {len(deployments)} deployment(s))"
    )

    return safe_length


__all__ = ["get_router", "is_router_available", "get_min_context_length"]
