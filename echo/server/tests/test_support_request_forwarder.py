"""Tests for the support_request outbox forwarder (ISSUE-034).

The delivery contract under test: rows with status=new and forwarded_at
NULL are POSTed to sam's webhook with the shared token header, and
forwarded_at is stamped ONLY on 2xx — a 4xx row stays unstamped (and the
batch continues), a 5xx/network failure stops the batch for the next cron
run. Payload shape per the contract mirrored in Dembrane/sam
src/recipes/product-support/recipe.md.
"""

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import requests

from dembrane.tasks import (
    _support_forward_environment,
    task_forward_support_requests,
    build_support_request_forward_payload,
)


def _settings(
    url="https://proxy.example/echo-support",
    token="tok-123",
    admin="https://dashboard.echo-next.dembrane.com",
):
    return SimpleNamespace(
        support=SimpleNamespace(
            forward_webhook_url=url,
            forward_webhook_token=token,
            forwarding_enabled=bool(url and token),
        ),
        urls=SimpleNamespace(admin_base_url=admin),
    )


def _ctx(client):
    ctx = MagicMock()
    ctx.__enter__ = MagicMock(return_value=client)
    ctx.__exit__ = MagicMock(return_value=False)
    return ctx


def _row(rid="sr-1", **overrides):
    row = {
        "id": rid,
        "message": "recording is stuck",
        "page_context": "project overview",
        "created_at": "2026-07-24T09:00:00Z",
        "chat_id": "ch-1",
        "project_id": "p-1",
        "workspace_id": "w-1",
        "app_user_id": "au-1",
        "directus_user_id": "du-1",
    }
    row.update(overrides)
    return row


def _client(rows, workspace_org="org-1"):
    client = MagicMock()
    client.get_items.return_value = rows
    client.get_item.return_value = {"org_id": workspace_org}
    return client


def _resp(status_code, text="ok"):
    return SimpleNamespace(status_code=status_code, text=text)


# ─── Payload contract ─────────────────────────────────────────────────────────


def test_payload_full_row():
    with patch("dembrane.tasks.get_settings", return_value=_settings()):
        payload = build_support_request_forward_payload(_row(), "org-1", "echo-next")
    assert payload["id"] == "sr-1"
    assert payload["environment"] == "echo-next"
    assert payload["message"] == "recording is stuck"
    assert payload["org_id"] == "org-1"
    assert payload["origin_link"] == (
        "https://dashboard.echo-next.dembrane.com/en-US/w/w-1/projects/p-1"
    )
    assert payload["workspace_id"] == "w-1" and payload["directus_user_id"] == "du-1"


def test_payload_omits_absent_fields():
    row = {"id": "sr-2", "message": "help"}
    with patch("dembrane.tasks.get_settings", return_value=_settings()):
        payload = build_support_request_forward_payload(row, None, "production")
    assert "org_id" not in payload
    assert "origin_link" not in payload  # no workspace/project to link to
    assert "page_context" not in payload
    assert set(payload) == {"id", "environment", "message"}


def test_payload_empty_message_gets_placeholder():
    # message is required on sam's side; a degenerate row must not wedge
    # the outbox as permanently-rejected.
    with patch("dembrane.tasks.get_settings", return_value=_settings()):
        payload = build_support_request_forward_payload(
            {"id": "sr-3", "message": ""}, None, "echo-next"
        )
    assert payload["message"] == "(empty message)"


def test_environment_derivation_by_admin_host():
    cases = [
        ("https://dashboard.dembrane.com", "production"),
        ("https://dashboard.echo-next.dembrane.com", "echo-next"),
        ("http://localhost:3000", "localhost"),
        ("", "development"),
    ]
    for admin, expected in cases:
        with patch("dembrane.tasks.get_settings", return_value=_settings(admin=admin)):
            assert _support_forward_environment() == expected


# ─── Forwarder behaviour ──────────────────────────────────────────────────────


def test_noop_when_not_configured():
    with (
        patch("dembrane.tasks.get_settings", return_value=_settings(url=None, token=None)),
        patch("dembrane.tasks.directus_client_context") as ctx,
    ):
        task_forward_support_requests()
    ctx.assert_not_called()


def test_forwards_and_stamps_on_2xx():
    client = _client([_row()])
    with (
        patch("dembrane.tasks.get_settings", return_value=_settings()),
        patch("dembrane.tasks.directus_client_context", return_value=_ctx(client)),
        patch("requests.post", return_value=_resp(200)) as post,
    ):
        task_forward_support_requests()

    assert post.call_count == 1
    args, kwargs = post.call_args
    assert args[0] == "https://proxy.example/echo-support"
    assert kwargs["headers"]["X-Echo-Support-Token"] == "tok-123"
    assert kwargs["json"]["id"] == "sr-1"
    assert kwargs["json"]["environment"] == "echo-next"
    assert kwargs["json"]["org_id"] == "org-1"

    client.update_item.assert_called_once()
    collection, rid, patch_body = client.update_item.call_args[0]
    assert (collection, rid) == ("support_request", "sr-1")
    assert patch_body["forwarded_at"]  # stamped


def test_4xx_leaves_unstamped_and_continues():
    client = _client([_row("sr-a"), _row("sr-b")])
    with (
        patch("dembrane.tasks.get_settings", return_value=_settings()),
        patch("dembrane.tasks.directus_client_context", return_value=_ctx(client)),
        patch("requests.post", side_effect=[_resp(400, "bad"), _resp(200)]) as post,
    ):
        task_forward_support_requests()

    assert post.call_count == 2  # the 400 didn't stop the batch
    client.update_item.assert_called_once()  # only sr-b stamped
    assert client.update_item.call_args[0][1] == "sr-b"


def test_5xx_stops_batch_without_stamping():
    client = _client([_row("sr-a"), _row("sr-b")])
    with (
        patch("dembrane.tasks.get_settings", return_value=_settings()),
        patch("dembrane.tasks.directus_client_context", return_value=_ctx(client)),
        patch("requests.post", return_value=_resp(503, "retry")) as post,
    ):
        task_forward_support_requests()

    assert post.call_count == 1  # receiver down → stop, next cron retries
    client.update_item.assert_not_called()


def test_network_error_stops_batch_without_stamping():
    client = _client([_row()])
    with (
        patch("dembrane.tasks.get_settings", return_value=_settings()),
        patch("dembrane.tasks.directus_client_context", return_value=_ctx(client)),
        patch("requests.post", side_effect=requests.ConnectionError("down")),
    ):
        task_forward_support_requests()

    client.update_item.assert_not_called()


def test_no_rows_is_quiet():
    client = _client([])
    with (
        patch("dembrane.tasks.get_settings", return_value=_settings()),
        patch("dembrane.tasks.directus_client_context", return_value=_ctx(client)),
        patch("requests.post") as post,
    ):
        task_forward_support_requests()
    post.assert_not_called()
    client.update_item.assert_not_called()


def test_missing_workspace_forwards_without_org():
    client = _client([_row(workspace_id=None)])
    with (
        patch("dembrane.tasks.get_settings", return_value=_settings()),
        patch("dembrane.tasks.directus_client_context", return_value=_ctx(client)),
        patch("requests.post", return_value=_resp(200)) as post,
    ):
        task_forward_support_requests()
    client.get_item.assert_not_called()  # no workspace hop attempted
    assert "org_id" not in post.call_args[1]["json"]
    client.update_item.assert_called_once()
