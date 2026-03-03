import json
from collections.abc import Iterable
from typing import Any


def parse_json_event_stream(chunks: Iterable[str]) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    buffer = ""

    for chunk in chunks:
        buffer += chunk
        while "\n" in buffer:
            line, buffer = buffer.split("\n", 1)
            line = line.strip()
            if not line:
                continue
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue

            if isinstance(payload, dict):
                events.append(payload)

    trailing = buffer.strip()
    if trailing:
        try:
            payload = json.loads(trailing)
        except json.JSONDecodeError:
            payload = None

        if isinstance(payload, dict):
            events.append(payload)

    return events
