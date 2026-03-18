from settings import get_settings


def test_settings_reads_env(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    get_settings.cache_clear()
    monkeypatch.setenv("ECHO_API_URL", "http://example.test/api")
    monkeypatch.setenv("LLM_MODEL", "claude-opus-4-6")
    monkeypatch.setenv("VERTEX_PROJECT", "vertex-project")
    monkeypatch.setenv("VERTEX_LOCATION", "europe-west4")
    monkeypatch.setenv("VERTEX_CREDENTIALS", '{"type":"service_account","project_id":"vertex-project"}')
    monkeypatch.setenv("GCP_SA_JSON", '{"type":"service_account","project_id":"fallback-project"}')
    monkeypatch.setenv("AGENT_GRAPH_RECURSION_LIMIT", "64")
    monkeypatch.setenv("AGENT_CORS_ORIGINS", "http://localhost:1111,http://localhost:2222")

    settings = get_settings()

    assert settings.echo_api_url == "http://example.test/api"
    assert settings.llm_model == "claude-opus-4-6"
    assert settings.vertex_project == "vertex-project"
    assert settings.vertex_location == "europe-west4"
    assert settings.vertex_credentials == {
        "type": "service_account",
        "project_id": "vertex-project",
    }
    assert settings.gcp_sa_json == {
        "type": "service_account",
        "project_id": "fallback-project",
    }
    assert settings.agent_graph_recursion_limit == 64
    assert settings.agent_cors_origins == "http://localhost:1111,http://localhost:2222"

    get_settings.cache_clear()
