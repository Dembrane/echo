from __future__ import annotations

import hashlib
import unicodedata

import pytest

from dembrane.analysis.hashing import (
    HASH_VERSION,
    CanonicalizationError,
    canonical,
    fingerprint,
    content_hash,
    canonical_json,
)


def test_the_version_is_c14n_v1() -> None:
    assert HASH_VERSION == "c14n-v1"


def test_keys_are_sorted_and_whitespace_is_gone() -> None:
    assert canonical_json({"b": [1, 2], "a": {"d": None, "c": True}}) == '{"a":{"c":true,"d":null},"b":[1,2]}'
    assert content_hash({"b": 1, "a": 2}) == content_hash({"a": 2, "b": 1})
    assert content_hash({"a": 1}) == hashlib.sha256(b'{"a":1}').hexdigest()


def test_strings_and_keys_are_nfc_normalised() -> None:
    composed = "café"
    decomposed = unicodedata.normalize("NFD", composed)
    assert composed != decomposed
    assert content_hash({decomposed: decomposed}) == content_hash({composed: composed})
    assert canonical_json("é") == '"é"'  # UTF-8, not escaped


def test_floats_are_written_as_repr_and_differ_from_ints() -> None:
    assert canonical_json(0.1) == "0.1"
    assert canonical_json(1.0) == "1.0"
    assert content_hash(1) != content_hash(1.0)
    assert canonical((1, 2)) == [1, 2]


@pytest.mark.parametrize(
    "value",
    [float("nan"), float("inf"), {1: "x"}, {"s": {1, 2}}, b"bytes", object()],
    ids=["nan", "inf", "int-key", "set", "bytes", "object"],
)
def test_values_without_a_canonical_form_are_refused(value: object) -> None:
    with pytest.raises(CanonicalizationError):
        content_hash(value)


def test_keys_that_normalise_to_the_same_key_are_refused() -> None:
    with pytest.raises(CanonicalizationError):
        canonical({"café": 1, unicodedata.normalize("NFD", "café"): 2})


def test_a_fingerprint_names_its_parts() -> None:
    assert fingerprint(a=1, b=2) == fingerprint(b=2, a=1)
    assert fingerprint(a="1", b="2") != fingerprint(a="12", b="")
