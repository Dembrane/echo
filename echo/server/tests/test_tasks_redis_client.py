"""RedisBroker(url=...) builds its own connection pool and silently drops
client kwargs like health_check_interval, so the keepalive fix never applied.
The broker and its backends must share a client whose POOL carries them."""

from __future__ import annotations

import dembrane.tasks as tasks


def test_broker_pool_has_health_check_and_retry():
    kwargs = tasks.broker.client.connection_pool.connection_kwargs
    assert kwargs.get("health_check_interval") == 25
    assert kwargs.get("socket_keepalive") is True
    assert kwargs.get("retry") is not None
    assert kwargs.get("retry_on_error")


def test_backends_share_the_configured_client():
    assert tasks.results_backend.client is tasks.broker.client
    assert tasks.workflow_backend.client is tasks.broker.client
