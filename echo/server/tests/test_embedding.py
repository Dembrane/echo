import math

from dembrane.embedding import EMBEDDING_DIM, embed_text


def test_embed_text_returns_list_of_floats():
    """Ensure `embed_text` returns a list of floats of the expected length."""
    sample_text = "Hello, world!"

    embedding = embed_text(sample_text)

    # Basic structural assertions
    assert isinstance(embedding, list), "Embedding should be a list"
    assert len(embedding) == EMBEDDING_DIM, (
        f"Embedding length should be {EMBEDDING_DIM}, got {len(embedding)}"
    )

    # Check that every element is a (finite) float
    assert all(isinstance(value, float) for value in embedding), "All values must be floats"
    assert all(math.isfinite(value) for value in embedding), "All floats must be finite numbers" 