"""Recording executor dependencies for the analysis tests."""

from __future__ import annotations

import copy
from typing import Any
from dataclasses import field, dataclass

from dembrane.analysis.outbox import OutboxDeps
from dembrane.analysis.executor import ExecutorDeps


@dataclass
class Recorder:
    events: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    dispatched: list[str] = field(default_factory=list)
    deferred: list[tuple[str, int]] = field(default_factory=list)
    enqueued: list[str] = field(default_factory=list)
    publish_error: BaseException | None = None

    def deps(self, *, dispatch: bool = True, clock: Any = None) -> ExecutorDeps:
        async def publish(project_id: str, event: dict[str, Any]) -> None:
            if self.publish_error is not None:
                raise self.publish_error
            self.events.append((project_id, copy.deepcopy(event)))

        def send(run_id: str) -> str:
            self.dispatched.append(run_id)
            return f"message-{len(self.dispatched)}"

        def send_later(run_id: str, delay_ms: int) -> str:
            self.deferred.append((run_id, delay_ms))
            return f"later-{len(self.deferred)}"

        deps = ExecutorDeps(
            publish_event=publish,
            dispatch_run=send if dispatch else None,
            dispatch_run_later=send_later if dispatch else None,
            enqueue_outbox=self.enqueued.append,
        )
        if clock is not None:
            deps.clock = clock
        return deps

    def outbox_deps(self, *, hooks: list[Any] | None = None) -> OutboxDeps:
        return OutboxDeps(executor=self.deps(), snapshot_hooks=list(hooks or []))

    def event_types(self) -> list[str]:
        return [event["type"] for _project, event in self.events]
