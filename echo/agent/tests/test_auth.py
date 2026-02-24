import pytest
from fastapi import HTTPException
from starlette.requests import Request

from auth import extract_bearer_token, parse_authorization_header


def _request_with_header(header_value: str | None) -> Request:
    headers = []
    if header_value is not None:
        headers.append((b"authorization", header_value.encode("utf-8")))

    scope = {
        "type": "http",
        "method": "POST",
        "path": "/copilotkit/project-id",
        "headers": headers,
    }
    return Request(scope)


def test_parse_authorization_header_accepts_bearer_token():
    assert parse_authorization_header("Bearer token-123") == "token-123"


def test_parse_authorization_header_rejects_invalid_scheme():
    assert parse_authorization_header("Basic abc") is None


def test_extract_bearer_token_reads_authorization_header():
    request = _request_with_header("Bearer token-xyz")
    assert extract_bearer_token(request) == "token-xyz"


def test_extract_bearer_token_raises_when_missing():
    request = _request_with_header(None)
    with pytest.raises(HTTPException) as exc:
        extract_bearer_token(request)

    assert exc.value.status_code == 401
