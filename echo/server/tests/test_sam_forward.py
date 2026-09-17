"""The one wire to sam: config gating, outcome mapping, and what goes on the
request. Every outbox that forwards to sam depends on this mapping."""

from types import SimpleNamespace
from logging import getLogger
from unittest.mock import patch

import pytest
import requests

from dembrane.sam_forward import post_to_sam, sam_webhook_config

LOG = getLogger("tests.sam_forward")


def _settings(url="https://proxy.example/echo-support", token="tok-123"):
    return SimpleNamespace(
        support=SimpleNamespace(forward_webhook_url=url, forward_webhook_token=token),
        urls=SimpleNamespace(admin_base_url="https://dashboard.echo-next.dembrane.com"),
    )


def _resp(status_code, text="ok"):
    return SimpleNamespace(status_code=status_code, text=text)


# config


def test_config_needs_both_values():
    cases = [
        (_settings(), ("https://proxy.example/echo-support", "tok-123")),
        (_settings(url=None), None),
        (_settings(token=None), None),
        (_settings(url="", token=""), None),
    ]
    for settings, expected in cases:
        with patch("dembrane.sam_forward.get_settings", return_value=settings):
            assert sam_webhook_config() == expected


def test_unconfigured_post_is_a_retry_and_sends_nothing():
    with (
        patch("dembrane.sam_forward.get_settings", return_value=_settings(url=None)),
        patch("requests.post") as post,
    ):
        assert post_to_sam({"id": "x"}, LOG) == "retry"
    post.assert_not_called()


# outcomes


@pytest.mark.parametrize(
    ("status", "outcome"),
    [(200, "delivered"), (204, "delivered"), (400, "rejected"), (422, "rejected"), (500, "retry")],
)
def test_status_maps_to_outcome(status, outcome):
    with (
        patch("dembrane.sam_forward.get_settings", return_value=_settings()),
        patch("requests.post", return_value=_resp(status, "detail")),
    ):
        assert post_to_sam({"id": "x"}, LOG) == outcome


def test_transport_failure_is_a_retry():
    with (
        patch("dembrane.sam_forward.get_settings", return_value=_settings()),
        patch("requests.post", side_effect=requests.ConnectionError("down")),
    ):
        assert post_to_sam({"id": "x"}, LOG) == "retry"


# the request itself


def test_request_carries_token_header_and_timeouts():
    with (
        patch("dembrane.sam_forward.get_settings", return_value=_settings()),
        patch("requests.post", return_value=_resp(200)) as post,
    ):
        post_to_sam({"id": "ep-1:opened", "message": "hi"}, LOG)
    args, kwargs = post.call_args
    assert args[0] == "https://proxy.example/echo-support"
    assert kwargs["headers"] == {"X-Echo-Support-Token": "tok-123"}
    assert kwargs["timeout"] == (10, 30)
    assert kwargs["json"] == {"id": "ep-1:opened", "message": "hi"}
