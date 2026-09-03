"""Minimal stand-ins for a LiteLLM completion response, shared across tests."""

from __future__ import annotations


class FakeMessage:
    def __init__(self, content: str) -> None:
        self.content = content


class FakeChoice:
    def __init__(self, content: str, finish_reason: str = "stop") -> None:
        self.message = FakeMessage(content)
        self.finish_reason = finish_reason


class FakeCompletion:
    def __init__(self, content: str, finish_reason: str = "stop", model: str = "fake") -> None:
        self.choices = [FakeChoice(content, finish_reason)]
        self.model = model
