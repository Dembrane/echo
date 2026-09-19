from __future__ import annotations

import pytest

from dembrane.map import recipe as map_recipe
from dembrane.embedding import EmbeddingIdentity
from tests.analysis.fakes import FakeAnalysisStore
from dembrane.analysis.contracts import (
    Origin,
    Provenance,
    ObjectRevision,
    RevisionStatus,
    AnalysisStoreError,
)
from dembrane.analysis.embeddings import (
    InvalidVector,
    EmbeddingService,
    input_hash,
    validate_vector,
)

PROJECT = "11111111-1111-4111-8111-111111111111"
IDENTITY = EmbeddingIdentity(model="fake/embedding", endpoint="fake:endpoint", dims=3)


def _service(store: FakeAnalysisStore, calls: list[str]) -> EmbeddingService:
    async def embed(text: str) -> list[float]:
        calls.append(text)
        return [float(len(text)), 1.0, 0.5]

    return EmbeddingService(store, identity=IDENTITY, embed=embed, concurrency=2)


@pytest.mark.parametrize("text", ["Trams.", "  Trams   are\nbetter ", "café"])
def test_the_cache_key_is_maps_input_hash(text: str) -> None:
    assert input_hash(text) == map_recipe.input_hash(text)


@pytest.mark.asyncio
async def test_stored_vectors_are_reused_and_missing_ones_saved_once() -> None:
    store = FakeAnalysisStore()
    calls: list[str] = []
    service = _service(store, calls)

    first = await service.ensure(PROJECT, ["Trams.", "Buses.", "Trams."])
    assert (first.computed, first.reused) == (2, 0)
    assert sorted(calls) == ["Buses.", "Trams."]

    second = await service.ensure(PROJECT, ["Trams.", " Buses. ", "Bikes."])
    assert (second.computed, second.reused) == (1, 2)
    assert calls[-1] == "Bikes."
    assert second.ids[input_hash("Trams.")] == first.ids[input_hash("Trams.")]
    await service.verify_durable(PROJECT, second.ids.values())
    with pytest.raises(AnalysisStoreError, match="missing"):
        await service.verify_durable(PROJECT, ["not-an-embedding"])
    # Another configuration never sees these vectors.
    other = EmbeddingService(store, identity=EmbeddingIdentity(model="other", endpoint=None, dims=3), embed=service.embed)
    assert (await other.ensure(PROJECT, ["Trams."])).computed == 1


@pytest.mark.parametrize("values", [[1.0, 2.0], [0.0, 0.0, 0.0], [float("nan"), 1.0, 1.0], "vector"])
def test_unusable_vectors_are_refused(values: object) -> None:
    with pytest.raises(InvalidVector):
        validate_vector(values, 3)


@pytest.mark.asyncio
async def test_revisions_embed_their_types_projection() -> None:
    store = FakeAnalysisStore()
    calls: list[str] = []
    service = _service(store, calls)

    def revision(revision_id: str, type_id: str, payload: dict[str, object]) -> ObjectRevision:
        return ObjectRevision(
            id=revision_id,
            object_id=f"o-{revision_id}",
            project_id=PROJECT,
            type=type_id,
            schema_version=1,
            revision_number=1,
            status=RevisionStatus.PUBLISHED,
            payload=payload,
            attributes={},
            provenance=Provenance(run_id=None, origin=Origin.IMPORTED),
            content_hash="x",
        )

    refs = await service.embed_revisions(
        PROJECT,
        [
            revision("a", "argument", {"statement": "Trams are better.", "epistemicKind": "argument"}),
            revision("t", "tension", {"poleA": "Buses", "poleB": "Cars", "knot": "One street.", "toResolve": "Who?"}),
            revision("f", "fact_check_assessment", {"verdict": "true", "statement": "x"}),
        ],
    )
    assert set(refs) == {"a", "t"}
    assert refs["a"].projection_version == "statement-v1"
    assert sorted(calls) == ["Buses versus Cars. One street.", "Trams are better."]
