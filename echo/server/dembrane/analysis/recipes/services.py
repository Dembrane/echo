"""The outside world the built-in producers read, injectable for tests.

A recipe finds its services under `SERVICES_KEY` in the executor's services;
without them it uses the platform's: Directus transcripts, the fast multimodal
group through the LiteLLM router, and the configured embedding deployment.
Nothing here is cached between runs, so a changed deployment is read again.
"""

from __future__ import annotations

import asyncio
from typing import Any, Mapping, Callable, Awaitable
from dataclasses import dataclass

from dembrane.embedding import EmbeddingIdentity
from dembrane.map.recipe import Transcript

SERVICES_KEY = "producers"

Extract = Callable[..., Awaitable[tuple[dict[str, Any], dict[str, int]]]]
# `verify(request)`: one deduplication verification, its answer and usage.
Verify = Callable[[Any], Awaitable[tuple[Any, dict[str, int]]]]
# `generate(system_prompt=, user_text=, schema=, thinking=)`: one structured
# judgement, its answer and usage.
Generate = Callable[..., Awaitable[tuple[dict[str, Any], dict[str, int]]]]


@dataclass(frozen=True)
class ProducerServices:
    transcripts: Callable[[str], Awaitable[list[Transcript]]]
    extract: Extract
    probe: Callable[[], Awaitable[EmbeddingIdentity]]
    embed: Callable[[str], Awaitable[list[float]]]
    # The embedding deployment as configured, without a network call: what a
    # run pins before it knows the probed identity.
    embedding_settings: Callable[[], dict[str, Any]]
    # The language model deployment every producer's model steps use.
    model_deployment: Callable[[], dict[str, Any]]
    verify: Verify
    generate: Generate


def model_deployment() -> dict[str, Any]:
    from dembrane.map.model import MODEL_GROUP, model_identity

    return {"group": MODEL_GROUP.value, "model": model_identity()}


def embedding_settings() -> dict[str, Any]:
    from dembrane.settings import get_settings
    from dembrane.embedding import INPUT_NORMALIZATION

    configured = get_settings().embedding
    return {
        "model": configured.model,
        "baseUrl": configured.base_url,
        "apiVersion": configured.api_version,
        "inputNormalization": INPUT_NORMALIZATION,
    }


def default_services() -> ProducerServices:
    from dembrane.map import model
    from dembrane.embedding import embed_text, probe_embedding_identity
    from dembrane.map.transcripts import load_transcripts
    from dembrane.analysis.recipes.tensions import generate_with_usage
    from dembrane.analysis.recipes.deduplication import verify_with_model

    async def probe() -> EmbeddingIdentity:
        return await asyncio.to_thread(probe_embedding_identity)

    async def embed(text: str) -> list[float]:
        return await asyncio.to_thread(embed_text, text)

    return ProducerServices(
        transcripts=load_transcripts,
        extract=model.extract_arguments,
        probe=probe,
        embed=embed,
        embedding_settings=embedding_settings,
        model_deployment=model_deployment,
        verify=verify_with_model,
        generate=generate_with_usage,
    )


def producer_services(services: Mapping[str, Any]) -> ProducerServices:
    found = services.get(SERVICES_KEY)
    if found is None:
        return default_services()
    if not isinstance(found, ProducerServices):
        raise TypeError(f"services[{SERVICES_KEY!r}] is not ProducerServices")
    return found
