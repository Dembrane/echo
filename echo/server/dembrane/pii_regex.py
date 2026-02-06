"""
Deterministic PII redaction using regex patterns.

Targets EU/NL-specific PII patterns:
- Email addresses
- Phone numbers (NL and international)
- IBAN numbers
- Dutch postcodes
- BSN (Burgerservicenummer) — 8-9 digit sequences
"""

import re
from typing import List, Tuple

# Compiled regex patterns with named groups for clear placeholder replacement
_PII_PATTERNS: List[Tuple[re.Pattern, str]] = [
    # Email addresses
    (
        re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b"),
        "<redacted_email>",
    ),
    # IBAN (EU format: 2 letters, 2 digits, then groups of 4 alphanumeric)
    (
        re.compile(r"\b[A-Z]{2}\d{2}\s?[A-Z]{4}(?:\s?\d{4}){2,7}\b"),
        "<redacted_iban>",
    ),
    # Dutch phone numbers: +31, 0031, 06-xxxxxxxx, etc.
    (
        re.compile(
            r"(?:\+31|0031)[\s\-.]?\(?\d{1,3}\)?[\s\-.]?\d{3,4}[\s\-.]?\d{2,4}[\s\-.]?\d{0,4}\b"
        ),
        "<redacted_phone>",
    ),
    # Dutch mobile: 06-xxxxxxxx
    (
        re.compile(r"\b06[\s\-.]?\d{2}[\s\-.]?\d{2}[\s\-.]?\d{2}[\s\-.]?\d{2}\b"),
        "<redacted_phone>",
    ),
    # International phone numbers: +XX with 10+ digits
    (
        re.compile(r"\+\d{1,3}[\s\-.]?\(?\d{1,4}\)?[\s\-.]?\d{3,4}[\s\-.]?\d{3,4}[\s\-.]?\d{0,4}\b"),
        "<redacted_phone>",
    ),
    # Dutch postcode: 4 digits + 2 letters (e.g. 1234 AB or 1234AB)
    (
        re.compile(r"\b\d{4}\s?[A-Z]{2}\b"),
        "<redacted_postcode>",
    ),
    # BSN (Burgerservicenummer): 8-9 digit sequences
    # Only match standalone sequences to reduce false positives
    (
        re.compile(r"(?<!\d)\d{8,9}(?!\d)"),
        "<redacted_bsn>",
    ),
]


def regex_redact_pii(text: str) -> str:
    """Apply all PII regex patterns to the text and return redacted version.

    Args:
        text: The input text to redact.

    Returns:
        Text with PII replaced by placeholder tokens like <redacted_email>, etc.
    """
    result = text
    for pattern, replacement in _PII_PATTERNS:
        result = pattern.sub(replacement, result)
    return result
