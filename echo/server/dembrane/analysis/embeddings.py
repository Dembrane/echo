"""Shared embedding service over Map's `map_embedding` table.

Same identity and cache semantics as Map: one row per project, exact input hash
and embedding configuration key; the input is the whitespace-collapsed text; a
concurrent writer of the same input gets the stored vector back. Vectors are
only compared within one configuration. The table is not renamed and no stored
vector is recomputed: an argument's statement projection is exactly Map's
embedding input, so existing vectors are reused.

What is embedded for an object is its type's versioned Map projection. A new
projection is new text and so a new cache input; old vectors stay for the
revisions that reference them.
"""

from __future__ import annotations

import math
import asyncio
import hashlib
from typing import Any, Callable, Iterable, Protocol, Awaitable
from dataclasses import field, dataclass

from dembrane.analysis import types
from dembrane.embedding import EmbeddingIdentity
from dembrane.analysis.contracts import ObjectRevision, AnalysisStoreError

EMBEDDING_CONCURRENCY = 8


class EmbeddingStore(Protocol):
    async def load_embeddings(
        self, project_id: str, config_key: str, input_hashes: list[str]
    ) -> dict[str, tuple[str, list[float]]]: ...
    async def save_embedding(
        self,
        *,
        project_id: str,
        input_hash: str,
        config_key: str,
        model: str,
        dims: int,
        vector: list[float],
    ) -> tuple[str, list[float]]: ...
    async def vectors_by_ids(self, project_id: str, ids: list[str]) -> dict[str, list[float]]: ...


class InvalidVector(ValueError):
    pass


def embedding_input(text: str) -> str:
    """Exactly the text that is embedded (Map's `recipe.embedding_input`)."""
    return " ".join(str(text or "").split())


def input_hash(text: str) -> str:
    return hashlib.sha256(embedding_input(text).encode("utf-8")).hexdigest()


def validate_vector(values: Any, dims: int) -> list[float]:
    """A finite, nonzero vector of exactly `dims` floats, or InvalidVector."""
    if not isinstance(values, (list, tuple)):
        raise InvalidVector("embedding is not a list")
    if len(values) != dims:
        raise InvalidVector(f"embedding has {len(values)} dimensions, expected {dims}")
    vector: list[float] = []
    for value in values:
        try:
            number = float(value)
        except (TypeError, ValueError) as exc:
            raise InvalidVector("embedding has a non-numeric value") from exc
        if not math.isfinite(number):
            raise InvalidVector("embedding has a non-finite value")
        vector.append(number)
    if not any(vector):
        raise InvalidVector("embedding is the zero vector")
    return vector


@dataclass(frozen=True)
class EmbeddingRef:
    embedding_id: str
    input_hash: str
    config_key: str
    projection_version: str

    def as_json(self) -> dict[str, str]:
        return {
            "embeddingId": self.embedding_id,
            "inputHash": self.input_hash,
            "configKey": self.config_key,
            "projectionVersion": self.projection_version,
        }


@dataclass
class EmbeddingBatch:
    ids: dict[str, str] = field(default_factory=dict)  # input hash -> embedding row id
    vectors: dict[str, list[float]] = field(default_factory=dict)  # input hash -> vector
    reused: int = 0
    computed: int = 0


class EmbeddingService:
    def __init__(
        self,
        store: EmbeddingStore,
        *,
        identity: EmbeddingIdentity,
        embed: Callable[[str], Awaitable[list[float]]],
        concurrency: int = EMBEDDING_CONCURRENCY,
    ) -> None:
        self.store = store
        self.identity = identity
        self.embed = embed
        self.concurrency = concurrency

    async def ensure(
        self,
        project_id: str,
        texts: Iterable[str],
        *,
        on_saved: Callable[[EmbeddingBatch], Awaitable[None]] | None = None,
    ) -> EmbeddingBatch:
        """Every text's vector for this configuration: stored ones in one read,
        missing ones embedded with bounded concurrency and saved as each lands."""
        wanted = {input_hash(text): embedding_input(text) for text in texts}
        batch = EmbeddingBatch()
        if not wanted:
            return batch
        stored = await self.store.load_embeddings(project_id, self.identity.key, sorted(wanted))
        for hashed, (embedding_id, vector) in stored.items():
            batch.ids[hashed] = embedding_id
            batch.vectors[hashed] = validate_vector(vector, self.identity.dims)
        batch.reused = len(stored)
        missing = [hashed for hashed in sorted(wanted) if hashed not in stored]
        semaphore = asyncio.Semaphore(self.concurrency)
        lock = asyncio.Lock()

        async def one(hashed: str) -> None:
            async with semaphore:
                vector = validate_vector(await self.embed(wanted[hashed]), self.identity.dims)
                embedding_id, kept = await self.store.save_embedding(
                    project_id=project_id,
                    input_hash=hashed,
                    config_key=self.identity.key,
                    model=self.identity.model,
                    dims=self.identity.dims,
                    vector=vector,
                )
            async with lock:
                batch.ids[hashed] = embedding_id
                batch.vectors[hashed] = validate_vector(kept, self.identity.dims)
                batch.computed += 1
                if on_saved is not None:
                    await on_saved(batch)

        async with asyncio.TaskGroup() as group:
            for hashed in missing:
                group.create_task(one(hashed))
        return batch

    async def verify_durable(self, project_id: str, embedding_ids: Iterable[str]) -> None:
        """Every referenced vector reads back from the database, or the output
        is not publishable."""
        ids = sorted(set(embedding_ids))
        durable = await self.store.vectors_by_ids(project_id, ids)
        if len(durable) != len(ids):
            raise AnalysisStoreError(f"{len(ids) - len(durable)} embeddings are missing after saving")

    async def embed_revisions(
        self, project_id: str, revisions: Iterable[ObjectRevision]
    ) -> dict[str, EmbeddingRef]:
        """Refs for each map-capable revision's projection text, by revision id.
        Types without a Map projection are skipped."""
        texts: dict[str, tuple[str, str]] = {}
        for revision in revisions:
            capability = types.get_object_type(revision.type).map
            if capability is None:
                continue
            texts[revision.id] = (capability.embedding_text(revision.payload), capability.projection_version)
        batch = await self.ensure(project_id, (text for text, _version in texts.values()))
        return {
            revision_id: EmbeddingRef(
                embedding_id=batch.ids[input_hash(text)],
                input_hash=input_hash(text),
                config_key=self.identity.key,
                projection_version=version,
            )
            for revision_id, (text, version) in texts.items()
        }
