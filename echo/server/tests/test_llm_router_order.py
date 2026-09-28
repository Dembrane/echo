import os

from dembrane.llm_router import _build_model_list


def test_numbered_deployments_are_ordered_fallbacks(monkeypatch):
    for key in list(os.environ):
        if key.startswith("LLM__"):
            monkeypatch.delenv(key)
    monkeypatch.setenv("LLM__TEXT_FAST__MODEL", "vertex_ai/gemini-3.8-flash")
    monkeypatch.setenv("LLM__TEXT_FAST_1__MODEL", "vertex_ai/gemini-3.7-flash")
    monkeypatch.setenv("LLM__TEXT_FAST_2__MODEL", "vertex_ai/gemini-3.5-flash")

    deployments = [
        (entry["litellm_params"]["model"], entry["litellm_params"]["order"])
        for entry in _build_model_list()
        if entry["model_name"] == "text_fast"
    ]

    assert deployments == [
        ("vertex_ai/gemini-3.8-flash", 1),
        ("vertex_ai/gemini-3.7-flash", 2),
        ("vertex_ai/gemini-3.5-flash", 3),
    ]
