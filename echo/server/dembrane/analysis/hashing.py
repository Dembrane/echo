"""Canonical JSON and content hashes, version `c14n-v1`.

A content hash identifies reusable computation (a step's inputs, a revision's
content, a manifest), never an identity: two unrelated objects with the same
text keep separate identities.

c14n-v1:

- UTF-8, keys sorted by code point, no insignificant whitespace;
- every string, including every key, NFC-normalised;
- floats written as Python's shortest round-trip `repr`, so `1` and `1.0` are
  different values; NaN and infinities are refused;
- tuples are lists; any other type is refused rather than guessed at.

Changing any of these rules is a new hash version, never an edit of this one.
"""

from __future__ import annotations

import json
import math
import hashlib
import unicodedata
from enum import Enum
from typing import Any

HASH_VERSION = "c14n-v1"


class CanonicalizationError(ValueError):
    """The value has no canonical JSON form under c14n-v1."""


def _nfc(text: str) -> str:
    return unicodedata.normalize("NFC", text)


def canonical(value: Any) -> Any:
    """The value as plain JSON types with every string NFC-normalised."""
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, Enum):
        return canonical(value.value)
    if isinstance(value, str):
        return _nfc(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise CanonicalizationError("NaN and infinite floats have no canonical form")
        return value
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise CanonicalizationError(f"object keys must be strings, got {type(key).__name__}")
            normalised = _nfc(key)
            if normalised in out:
                raise CanonicalizationError(f"two keys normalise to {normalised!r}")
            out[normalised] = canonical(item)
        return out
    if isinstance(value, (list, tuple)):
        return [canonical(item) for item in value]
    raise CanonicalizationError(f"{type(value).__name__} has no canonical JSON form")


def canonical_json(value: Any) -> str:
    return json.dumps(
        canonical(value),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )


def content_hash(value: Any) -> str:
    """sha256 hex of the value's c14n-v1 JSON."""
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def fingerprint(**parts: Any) -> str:
    """A content hash over named parts, so adding a part never collides with
    a value that happens to look like the old tuple."""
    return content_hash(parts)
