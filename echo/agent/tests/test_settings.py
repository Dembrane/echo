from settings import get_settings


def test_settings_reads_env(monkeypatch):
    get_settings.cache_clear()
    monkeypatch.setenv("ECHO_API_URL", "http://example.test/api")
    monkeypatch.setenv("GCP_SA_JSON", '{"type": "service_account", "project_id": "proj-1"}')
    monkeypatch.setenv("VERTEX_LOCATION", "europe-west4")
    monkeypatch.setenv("LLM_MODEL", "gemini-test")
    monkeypatch.setenv("AGENT_GRAPH_RECURSION_LIMIT", "64")
    monkeypatch.setenv("AGENT_CORS_ORIGINS", "http://localhost:1111,http://localhost:2222")

    settings = get_settings()

    assert settings.echo_api_url == "http://example.test/api"
    assert settings.gcp_sa_json == {"type": "service_account", "project_id": "proj-1"}
    assert settings.vertex_location == "europe-west4"
    assert settings.vertex_api_endpoint == "aiplatform.googleapis.com"
    assert settings.llm_model == "gemini-test"
    assert settings.agent_graph_recursion_limit == 64
    assert settings.agent_cors_origins == "http://localhost:1111,http://localhost:2222"

    get_settings.cache_clear()


def test_settings_decodes_base64_gcp_sa_json(monkeypatch):
    import base64
    import json as _json

    get_settings.cache_clear()
    raw = {"type": "service_account", "project_id": "b64-proj"}
    b64 = base64.b64encode(_json.dumps(raw).encode()).decode()
    monkeypatch.setenv("GCP_SA_JSON", b64)
    monkeypatch.setenv("VERTEX_LOCATION", "eu")

    settings = get_settings()
    assert settings.gcp_sa_json == raw
    get_settings.cache_clear()
