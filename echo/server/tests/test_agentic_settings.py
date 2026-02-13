from dembrane.settings import get_settings


def test_agentic_settings_reads_environment(monkeypatch) -> None:
    get_settings.cache_clear()
    monkeypatch.setenv("AGENT_SERVICE_URL", "http://agent.internal:9000")
    monkeypatch.setenv("AGENTIC_RUN_TIMEOUT_SECONDS", "321")
    monkeypatch.setenv("AGENTIC_SSE_HEARTBEAT_SECONDS", "7")

    settings = get_settings()

    assert settings.agentic.agent_service_url == "http://agent.internal:9000"
    assert settings.agentic.run_timeout_seconds == 321
    assert settings.agentic.sse_heartbeat_seconds == 7

    get_settings.cache_clear()
