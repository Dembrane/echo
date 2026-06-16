"""Unit tests for the password strength policy."""

import pytest
from pydantic import ValidationError

from dembrane.api.v2.auth import RegisterRequest
from dembrane.password_policy import (
    PASSWORD_MIN_LENGTH,
    validate_password,
    is_strong_password,
)


def test_valid_password_returns_no_errors():
    assert validate_password("Abcdef1!") == []
    assert is_strong_password("Abcdef1!") is True


def test_too_short_fails_length():
    # 7 chars, meets all classes but one short
    errors = validate_password("Abcde1!")
    assert any("at least" in e for e in errors)
    assert is_strong_password("Abcde1!") is False


def test_missing_lowercase():
    assert any("lowercase" in e for e in validate_password("ABCDEF1!"))


def test_missing_uppercase():
    assert any("uppercase" in e for e in validate_password("abcdef1!"))


def test_missing_number():
    assert any("number" in e for e in validate_password("Abcdefg!"))


def test_missing_symbol():
    assert any("symbol" in e for e in validate_password("Abcdef12"))


def test_empty_password_fails_every_rule():
    assert len(validate_password("")) == 5


def test_min_length_constant_is_eight():
    assert PASSWORD_MIN_LENGTH == 8


def test_register_request_rejects_weak_password():
    with pytest.raises(ValidationError):
        RegisterRequest(
            email="a@b.com",
            password="weakpassword",  # no upper, number, or symbol
            first_name="A",
            verification_url="https://example.com/verify",
        )


def test_register_request_accepts_strong_password():
    req = RegisterRequest(
        email="a@b.com",
        password="Abcdef1!",
        first_name="A",
        verification_url="https://example.com/verify",
    )
    assert req.password == "Abcdef1!"
