from __future__ import annotations

import logging
from typing import Any

import dembrane.popcorn.model as model
from dembrane.llms import MODELS


class _Llms:
    def __init__(self, deployments: list[Any]) -> None:
        self._deployments = deployments

    def get_deployments_for_group(self, group: str) -> list[Any]:
        assert group == "popcorn_fast"
        return self._deployments


class _Settings:
    def __init__(self, deployments: list[Any]) -> None:
        self.llms = _Llms(deployments)


def test_popcorn_uses_its_own_group_when_one_is_configured(monkeypatch) -> None:
    monkeypatch.setattr(model, "get_settings", lambda: _Settings([(None, object())]))
    assert model.popcorn_model() is MODELS.POPCORN_FAST


def test_popcorn_falls_back_to_the_shared_fast_group_and_says_so_once(monkeypatch, caplog) -> None:
    monkeypatch.setattr(model, "get_settings", lambda: _Settings([]))
    monkeypatch.setattr(model, "_fallback_warned", False)
    with caplog.at_level(logging.WARNING, logger="dembrane.popcorn.model"):
        assert model.popcorn_model() is MODELS.MULTI_MODAL_FAST
        assert model.popcorn_model() is MODELS.MULTI_MODAL_FAST
    assert sum("POPCORN_FAST" in r.message for r in caplog.records) == 1


def test_prompts_are_the_versioned_snapshots() -> None:
    assert model.POPCORN_PROMPT == "popcorn-v1.7"
    assert "Version: `popcorn-v1.7`" in model.prompt_text(model.POPCORN_PROMPT)
    assert "weight" not in model.prompt_text(model.POPCORN_PROMPT).lower()
    assert "Version: `popcorn-validate-v1.1`" in model.prompt_text(model.VALIDATE_PROMPT)
    assert "Version: `popcorn-kind-v3`" in model.prompt_text(model.KIND_PROMPT)
    assert "Version: `popcorn-question-v1`" in model.prompt_text(model.QUESTION_PROMPT)
