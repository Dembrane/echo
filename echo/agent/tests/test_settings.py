from settings import get_settings


def test_settings_reads_env(monkeypatch):
    get_settings.cache_clear()
    monkeypatch.setenv("ECHO_API_URL", "http://example.test/api")
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.setenv("LLM_MODEL", "gemini-test")
    monkeypatch.setenv("AGENT_CORS_ORIGINS", "http://localhost:1111,http://localhost:2222")

    settings = get_settings()

    assert settings.echo_api_url == "http://example.test/api"
    assert settings.gemini_api_key == "test-key"
    assert settings.llm_model == "gemini-test"
    assert settings.agent_cors_origins == "http://localhost:1111,http://localhost:2222"

    get_settings.cache_clear()
