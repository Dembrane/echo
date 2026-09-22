"""In-memory edges for the popcorn and canvas tick flows: no network, no sleeps.

`TickWorld` puts one Directus, one Redis, one clock, one message broker and
scripted model calls under the popcorn and canvas modules, so a test drives a
flow the way production runs it:

- a host action goes through the service (`create_popcorn`,
  `dispatch_popcorn_tick_now_with_safety`, `go_live`, `stop_live`, the canvas
  loop actions and host items), which writes `scheduled_task` rows and sends
  actor messages to the broker;
- `run_scheduler()` is the minute scheduler: the real
  `task_process_scheduled_tasks`, claiming due rows and sending their messages;
- `deliver()` is the ticks worker: each queued message runs through its real
  actor, in an event loop whose clock jumps to the next timer when nothing is
  ready, so a 180-second lock wait or a 30-second heartbeat costs no real time;
- the test reads what the dashboard reads (`popcorn_payload`) and the rows.

Only the edges are fake: Directus (with the filter operators the code uses),
Redis (SET NX EX, the compare-and-set scripts, TTLs on the world clock), the
language model, the reader-access check, the canvas gather and the analysis
store the popcorn publisher writes to.
"""

from __future__ import annotations

import copy
import json
import uuid
import asyncio
from types import SimpleNamespace
from typing import Any, Callable, Awaitable
from datetime import datetime, timezone, timedelta
from contextlib import contextmanager

from tests.llm_fakes import FakeCompletion
from tests.map_fakes import FakeClock

PROJECT = "44444444-4444-4444-8444-444444444444"
CANVAS_PROJECT = "55555555-5555-4555-8555-555555555555"
USER = "directus-user-host"
C1 = "cccccccc-0000-4000-8000-000000000001"
C2 = "cccccccc-0000-4000-8000-000000000002"
CANVAS_CONVERSATION = "dddddddd-0000-4000-8000-000000000001"
PENDING = ("scheduled", "processing")


class FlowClock(FakeClock):
    """The map fakes' clock (every read moves it on a millisecond, so rows sort
    by when they were written), started in 2030. The scheduler's stale-claim
    sweep compares against the real clock; a claim stamped in 2030 is never
    stale to it, so that sweep cannot reset a row behind the test's back."""

    def __init__(self) -> None:
        super().__init__()
        self._now = datetime(2030, 1, 7, 9, 0, tzinfo=timezone.utc)


# ── Directus ─────────────────────────────────────────────────────────


def _check(op: str, value: Any, expected: Any) -> bool:
    if op == "_eq":
        return value == expected
    if op == "_neq":
        return value != expected
    if op == "_in":
        return value in expected
    if op == "_nin":
        return value not in expected
    if op == "_null":
        return (value is None) is bool(expected)
    if op == "_nnull":
        return (value is not None) is bool(expected)
    if op in ("_gt", "_gte", "_lt", "_lte"):
        if value is None:
            return False
        return {
            "_gt": value > expected,
            "_gte": value >= expected,
            "_lt": value < expected,
            "_lte": value <= expected,
        }[op]
    # A filter the fake cannot answer must fail loudly, never match by accident.
    raise NotImplementedError(f"the fake Directus does not answer {op}")


def _matches(row: dict[str, Any], flt: dict[str, Any] | None) -> bool:
    for field, cond in (flt or {}).items():
        if field == "_and":
            if not all(_matches(row, sub) for sub in cond):
                return False
            continue
        if field == "_or":
            if not any(_matches(row, sub) for sub in cond):
                return False
            continue
        value = row.get(field)
        for op, expected in cond.items():
            if not _check(op, value, expected):
                return False
    return True


def _sort(rows: list[dict[str, Any]], sort: list[str] | None) -> list[dict[str, Any]]:
    for field in reversed(sort or []):
        name = field.lstrip("-")
        rows.sort(
            key=lambda row: (row.get(name) is not None, row.get(name) or 0),
            reverse=field.startswith("-"),
        )
    return rows


class FakeDirectus:
    """Directus over plain dicts. Reads and writes are deep copies, as JSON
    over HTTP is: a tick that holds a row it read earlier holds a snapshot,
    never the live row, so a lost update shows up here the way it would."""

    def __init__(self, clock: FlowClock) -> None:
        self.clock = clock
        self.tables: dict[str, dict[str, dict[str, Any]]] = {}
        self.writes: list[tuple[str, str, dict[str, Any]]] = []
        self._read_failures: dict[str, list[Exception]] = {}
        self.sync = _SyncDirectus(self)

    # ── test hooks ──

    def fail_next_read(self, collection: str, exc: Exception) -> None:
        """The next `get_items` on this collection raises `exc` (a blip)."""
        self._read_failures.setdefault(collection, []).append(exc)

    def insert(self, collection: str, row: dict[str, Any]) -> dict[str, Any]:
        return self._create(collection, row)["data"]

    def row(self, collection: str, item_id: str) -> dict[str, Any] | None:
        found = self.tables.get(collection, {}).get(str(item_id))
        return copy.deepcopy(found) if found is not None else None

    def rows(self, collection: str) -> list[dict[str, Any]]:
        return [copy.deepcopy(row) for row in self.tables.get(collection, {}).values()]

    def state_writes(self, loop_id: str) -> list[dict[str, Any]]:
        return [
            patch["popcorn_state"]
            for collection, item_id, patch in self.writes
            if collection == "agent_loop" and item_id == loop_id and "popcorn_state" in patch
        ]

    # ── the client, sync ──

    def _get_item(self, collection: str, item_id: str) -> dict[str, Any] | None:
        return self.row(collection, item_id)

    def _get_items(self, collection: str, params: dict[str, Any] | None) -> list[dict[str, Any]]:
        failures = self._read_failures.get(collection)
        if failures:
            raise failures.pop(0)
        params = params or {}
        query = params.get("query", params)
        rows = [
            row
            for row in self.tables.get(collection, {}).values()
            if _matches(row, query.get("filter"))
        ]
        rows = _sort(rows, query.get("sort"))
        limit = query.get("limit")
        if isinstance(limit, int) and limit >= 0:
            rows = rows[:limit]
        return copy.deepcopy(rows)

    def _create(self, collection: str, data: dict[str, Any]) -> dict[str, Any]:
        row = copy.deepcopy(data)
        row.setdefault("id", str(uuid.uuid4()))
        stamp = self.clock.now().isoformat()
        row.setdefault("created_at", stamp)
        row.setdefault("date_created", stamp)
        table = self.tables.setdefault(collection, {})
        if str(row["id"]) in table:
            raise ValueError(f"duplicate primary key {collection}/{row['id']}")
        table[str(row["id"])] = row
        self.writes.append((collection, str(row["id"]), copy.deepcopy(data)))
        return {"data": copy.deepcopy(row)}

    def _update(self, collection: str, item_id: str, data: dict[str, Any]) -> dict[str, Any]:
        table = self.tables.get(collection, {})
        if str(item_id) not in table:
            raise LookupError(f"no {collection}/{item_id}")
        table[str(item_id)].update(copy.deepcopy(data))
        self.writes.append((collection, str(item_id), copy.deepcopy(data)))
        return {"data": copy.deepcopy(table[str(item_id)])}

    # ── the client, async (dembrane.directus_async's surface) ──

    async def get_item(self, collection: str, item_id: str, **_: Any) -> dict[str, Any] | None:
        return self._get_item(collection, item_id)

    async def get_items(self, collection: str, params: dict[str, Any] | None = None) -> list:
        return self._get_items(collection, params)

    async def create_item(self, collection: str, data: dict[str, Any]) -> dict[str, Any]:
        return self._create(collection, data)

    async def update_item(self, collection: str, item_id: str, data: dict[str, Any]) -> dict:
        return self._update(collection, item_id, data)


class _SyncDirectus:
    """The sync DirectusClient the scheduled-task runner is handed."""

    def __init__(self, store: FakeDirectus) -> None:
        self._store = store

    def get_item(self, collection: str, item_id: str, **_: Any) -> dict[str, Any] | None:
        return self._store._get_item(collection, item_id)

    def get_items(self, collection: str, params: dict[str, Any] | None = None) -> list:
        return self._store._get_items(collection, params)

    def create_item(self, collection: str, data: dict[str, Any]) -> dict[str, Any]:
        return self._store._create(collection, data)

    def update_item(self, collection: str, item_id: str, data: dict[str, Any]) -> dict:
        return self._store._update(collection, item_id, data)


# ── Redis ────────────────────────────────────────────────────────────


class FakeRedis:
    """The Redis calls the ticks make, with TTLs on the world clock. `down`
    makes every call raise, the way an unreachable Redis does."""

    def __init__(self, clock: FlowClock) -> None:
        self.clock = clock
        self.values: dict[str, Any] = {}
        self.expires: dict[str, datetime] = {}
        self.published: list[tuple[str, Any]] = []
        self.down = False

    def _reachable(self) -> None:
        if self.down:
            raise ConnectionError("Redis is unreachable")

    def _live(self, key: str) -> bool:
        at = self.expires.get(key)
        if at is not None and self.clock.peek() >= at:
            self.values.pop(key, None)
            self.expires.pop(key, None)
        return key in self.values

    async def set(self, key: str, value: Any, ex: int | None = None, nx: bool = False, **_: Any):
        self._reachable()
        if nx and self._live(key):
            return None
        self.values[key] = value
        if ex:
            self.expires[key] = self.clock.peek() + timedelta(seconds=int(ex))
        else:
            self.expires.pop(key, None)
        return True

    async def get(self, key: str) -> Any:
        self._reachable()
        return self.values.get(key) if self._live(key) else None

    async def delete(self, *keys: str) -> int:
        self._reachable()
        gone = 0
        for key in keys:
            if self._live(key):
                self.values.pop(key, None)
                self.expires.pop(key, None)
                gone += 1
        return gone

    async def exists(self, *keys: str) -> int:
        self._reachable()
        return sum(1 for key in keys if self._live(key))

    async def expire(self, key: str, seconds: int) -> bool:
        self._reachable()
        if not self._live(key):
            return False
        self.expires[key] = self.clock.peek() + timedelta(seconds=int(seconds))
        return True

    async def eval(self, script: str, numkeys: int, *args: Any) -> int:
        """The two compare-and-set scripts in `popcorn.service`."""
        self._reachable()
        key, token = args[0], args[1]
        if not (self._live(key) and self.values[key] == token):
            return 0
        if '"del"' in script:
            self.values.pop(key, None)
            self.expires.pop(key, None)
            return 1
        if '"expire"' in script:
            self.expires[key] = self.clock.peek() + timedelta(seconds=int(args[2]))
            return 1
        raise NotImplementedError(script)

    async def publish(self, channel: str, data: Any) -> int:
        self._reachable()
        self.published.append((channel, data))
        return 1

    async def ping(self) -> bool:
        self._reachable()
        return True

    # ── test hooks ──

    def held(self, key: str) -> bool:
        return self._live(key)

    def hand_over(self, key: str, token: str, ttl_seconds: int = 300) -> None:
        """The key's TTL ran out and another holder took it with its own token."""
        self.values[key] = token
        self.expires[key] = self.clock.peek() + timedelta(seconds=ttl_seconds)


# ── an event loop on virtual time ────────────────────────────────────


class VirtualTimeLoop(asyncio.SelectorEventLoop):
    """Whenever nothing is ready to run, the clock jumps to the next timer, so
    `asyncio.sleep`, `wait_for` and `asyncio.timeout` cost no real time. Only
    for code whose every await is on a fake: nothing here waits for a socket.
    A run that can never finish raises instead of hanging: every task waiting
    with no timer set, or only heartbeats left ticking for longer than any
    test drives (a tick's actor limit is an hour)."""

    LIMIT_SECONDS = 6 * 3600

    def __init__(self) -> None:
        super().__init__()
        self._virtual_now = 0.0

    def time(self) -> float:
        return self._virtual_now

    def _run_once(self) -> None:  # BaseEventLoop internals: _ready, _scheduled, _stopping
        if not self._ready and not self._stopping:
            timers = [handle.when() for handle in self._scheduled if not handle.cancelled()]
            if not timers:
                raise RuntimeError("virtual time: every task is waiting and no timer is set")
            self._virtual_now = max(self._virtual_now, min(timers))
            if self._virtual_now > self.LIMIT_SECONDS:
                raise RuntimeError("virtual time: still waiting after six hours")
        super()._run_once()


def run_virtual(coro: Awaitable[Any]) -> Any:
    with asyncio.Runner(loop_factory=VirtualTimeLoop) as runner:
        return runner.run(coro)


# ── the model calls ──────────────────────────────────────────────────


def _group(name: str, rung: str, stake: float, mentions: float) -> dict[str, Any]:
    return {
        "name": name,
        "role": "r" * 5,
        "stake": "s" * 5,
        "rung": rung,
        "stakeWeight": stake,
        "mentionsWeight": mentions,
        "quotes": [],
    }


class PopcornModels:
    """The popcorn tick's model calls, scripted and counted. The extractor
    returns each line's first sentence as a phrase, so new speech adds a
    phrase and the unchanged lines keep theirs. `before_extract(cid)` runs
    inside an extractor call before it answers: to hold it, or to fail it."""

    def __init__(self) -> None:
        self.calls: list[str] = []
        self.before_extract: Callable[[str], Awaitable[None]] | None = None

    async def extract(self, *, transcript_id: str, transcript: str, host_note: str = "") -> dict:  # noqa: ARG002
        self.calls.append(f"extract:{transcript_id}")
        if self.before_extract is not None:
            await self.before_extract(transcript_id)
        phrases = [line.split(".")[0].strip() for line in transcript.split("\n") if line.strip()]
        return {"items": [{"phrase": phrase, "weight": 2} for phrase in phrases]}

    async def validate(self, *, transcript_id: str, transcript: str, phrase: str) -> dict:
        self.calls.append(f"validate:{transcript_id}")
        for line in transcript.split("\n"):
            if phrase in line:
                return {"grounded": True, "quote": line.strip(), "reason": "said as such"}
        return {"grounded": False, "quote": "", "reason": "not in the transcript"}

    async def classify(self, *, transcript_id: str, transcript: str, phrase: str) -> dict:  # noqa: ARG002
        self.calls.append(f"kind:{transcript_id}")
        return {
            "kind": "observation",
            "qualifiers": [],
            "question_form": False,
            "target": "",
            "reason": "reports what happens",
        }

    async def rewrite(self, *, transcript_id: str, transcript: str, phrase: str) -> dict:  # noqa: ARG002
        self.calls.append(f"question:{transcript_id}")
        return {"phrase": phrase + "?"}

    async def stakeholders(
        self, *, kind: str, corpus: str, feedback: list[str] | None = None
    ) -> dict:  # noqa: ARG002
        self.calls.append(f"analysis:{kind}")
        return {
            "stakeholders": [
                _group("Members", "voiced", 0.9, 0.8),
                _group("Staff", "named", 0.4, 0.2),
            ],
            "relations": [
                {
                    "between": ["Members", "Staff"],
                    "label": "told after the fact",
                    "intensity": 0.7,
                    "sentiment": -0.4,
                    "unowned": True,
                    "detail": "Decisions arrive as announcements.",
                    "aspects": [],
                }
            ],
        }

    async def tensions(self, sources: dict[str, str], book: Any) -> dict:  # noqa: ARG002
        self.calls.append("analysis:tensions")
        return {"tensions": {"tensions": []}, "gate_flags": [], "counts": {}}

    def extracted(self) -> list[str]:
        return [call.split(":", 1)[1] for call in self.calls if call.startswith("extract:")]


class Publications:
    """The analysis store as the tick's publisher meets it: whether the
    executor owns a scope, and each inline publication of one conversation's
    phrases. `up = False` fails every publication, as a busy or broken store
    does. `published` is what a reader of the store would find."""

    def __init__(self) -> None:
        self.owned: set[str] = set()
        self.up = True
        self.attempts: list[str] = []
        self.published: dict[str, list[str]] = {}

    async def analysis_owns(
        self, project_id: str, recipe_id: str, scope_key: str, *, store: Any
    ) -> bool:  # noqa: ARG002
        return recipe_id in self.owned

    async def execute_inline(self, request: Any, *, store: Any = None, deps: Any = None) -> Any:  # noqa: ARG002
        from dembrane.analysis.recipes.popcorn import SOURCES_KEY, conversation_of

        assert request.recipe_id == "popcorn", request.recipe_id
        cid = conversation_of(request.scope_key)
        self.attempts.append(cid)
        if not self.up:
            raise RuntimeError("the analysis store is unavailable")
        source = await deps.services[SOURCES_KEY].conversation(request.project_id, cid)
        self.published[cid] = [phrase["phrase"] for phrase in source.phrases]
        return SimpleNamespace(run=SimpleNamespace(status="ready", error=None))


class CanvasModels:
    """The canvas tick's two model calls. Extraction quotes every chunk it is
    shown word for word; `before_extract()` runs inside the call first."""

    def __init__(self) -> None:
        self.calls: list[str] = []
        self.before_extract: Callable[[], Awaitable[None]] | None = None

    async def completion(self, model: Any, *, messages: list[dict[str, Any]], **_: Any) -> Any:  # noqa: ARG002
        from dembrane.canvas import ticks as canvas_ticks

        system = messages[0]["content"]
        payload = json.loads(messages[-1]["content"])
        if system == canvas_ticks.MODEL_EXTRACTION_SYSTEM_PROMPT:
            self.calls.append("extract")
            if self.before_extract is not None:
                await self.before_extract()
            quotes = [
                {
                    "who": conversation.get("who"),
                    "quote": chunk["transcript"],
                    "conversation_id": conversation["conversation_id"],
                    "chunk_id": chunk.get("chunk_id"),
                }
                for conversation in payload.get("new_transcript") or []
                for chunk in conversation.get("chunks") or []
            ]
            return FakeCompletion(
                json.dumps({"quotes": quotes, "concepts": [], "crux": None, "story_slides": []})
            )
        if system == canvas_ticks.HOST_GUIDE_SYSTEM_PROMPT:
            self.calls.append("host_guide")
            return FakeCompletion(
                json.dumps(
                    {
                        "where_the_room_is": "The room is warming up.",
                        "what_to_ask_next": ["What would you change first?"],
                        "under_heard": [],
                    }
                )
            )
        raise AssertionError("the canvas tick asked the model something unexpected")


# ── the world ────────────────────────────────────────────────────────


class TickWorld:
    def __init__(self) -> None:
        self.clock = FlowClock()
        self.directus = FakeDirectus(self.clock)
        self.redis = FakeRedis(self.clock)
        self.models = PopcornModels()
        self.canvas_models = CanvasModels()
        self.publications = Publications()
        self.broker: list[tuple[str, tuple[Any, ...], dict[str, Any]]] = []
        self.results: list[Any] = []
        self.reader_denied = False
        self.report_id = ""
        self.loop_id = ""
        self.canvas_report_id = ""
        self.canvas_loop_id = ""
        self._chunk_seq = 0

    # ── wiring ──

    def install(self, monkeypatch: Any) -> "TickWorld":
        import dembrane.tasks as tasks
        import dembrane.redis_async as redis_async
        import dembrane.canvas.ticks as canvas_ticks
        import dembrane.canvas.events as canvas_events
        import dembrane.popcorn.ticks as popcorn_ticks
        import dembrane.canvas.service as canvas_service
        import dembrane.popcorn.bundle as popcorn_bundle
        import dembrane.popcorn.service as popcorn_service
        import dembrane.scheduled_tasks as scheduled_tasks
        import dembrane.analysis.executor as executor
        import dembrane.analysis.popcorn_import as popcorn_import
        from dembrane.settings import get_settings
        from dembrane.canvas.access import CanvasReaderAccessDenied

        for module in (
            popcorn_ticks,
            popcorn_service,
            scheduled_tasks,
            canvas_ticks,
            canvas_service,
        ):
            monkeypatch.setattr(module, "async_directus", self.directus)

        @contextmanager
        def _client_context(*_args: Any, **_kwargs: Any):
            yield self.directus.sync

        monkeypatch.setattr(tasks, "directus_client_context", _client_context)

        for module in (popcorn_ticks, popcorn_service, canvas_ticks, canvas_service):
            monkeypatch.setattr(module, "_now", self.clock.now)
        monkeypatch.setattr(scheduled_tasks, "_now_iso", lambda: self.clock.now().isoformat())

        async def _redis() -> FakeRedis:
            return self.redis

        for module in (popcorn_ticks, popcorn_service, canvas_ticks, canvas_events, redis_async):
            monkeypatch.setattr(module, "get_redis_client", _redis)

        flags = SimpleNamespace(enable_present=True, enable_canvas=True)
        monkeypatch.setattr(
            popcorn_ticks, "get_settings", lambda: SimpleNamespace(feature_flags=flags)
        )
        real = get_settings()
        monkeypatch.setattr(
            canvas_ticks,
            "get_settings",
            lambda: SimpleNamespace(feature_flags=flags, canvas=real.canvas),
        )

        async def _reader(**_: Any) -> None:
            if self.reader_denied:
                raise CanvasReaderAccessDenied("The acting user can no longer read this project")

        monkeypatch.setattr(popcorn_ticks, "resolve_canvas_reader_context", _reader)

        monkeypatch.setattr(popcorn_ticks, "extract_popcorn", self.models.extract)
        monkeypatch.setattr(popcorn_ticks, "validate_phrase", self.models.validate)
        monkeypatch.setattr(popcorn_ticks, "classify_phrase", self.models.classify)
        monkeypatch.setattr(popcorn_ticks, "rewrite_question", self.models.rewrite)
        monkeypatch.setattr(popcorn_ticks, "run_analysis", self.models.stakeholders)
        monkeypatch.setattr(popcorn_ticks, "run_tensions_pipeline", self.models.tensions)

        # The analysis store: nothing published for the deck to read, the
        # publisher's scopes and publications scripted.
        async def _no_deck_objects(*_: Any, **__: Any) -> Any:
            return popcorn_bundle.DeckObjects()

        monkeypatch.setattr(popcorn_bundle, "load_deck_objects", _no_deck_objects)
        monkeypatch.setattr(executor, "default_store", lambda: SimpleNamespace(name="fake store"))
        monkeypatch.setattr(executor, "execute_inline", self.publications.execute_inline)
        monkeypatch.setattr(popcorn_import, "analysis_owns", self.publications.analysis_owns)

        monkeypatch.setattr(canvas_ticks, "arouter_completion", self.canvas_models.completion)
        monkeypatch.setattr(canvas_ticks, "execute_gather_spec", self._canvas_gather)

        # The broker: actor messages wait here until `deliver()`.
        def _popcorn_send(*args: Any, **kwargs: Any) -> None:
            self.broker.append(("popcorn", args, kwargs))

        def _canvas_send(*args: Any, **kwargs: Any) -> None:
            self.broker.append(("canvas", args, kwargs))

        monkeypatch.setattr(tasks.task_popcorn_tick_now, "send", _popcorn_send)
        monkeypatch.setattr(tasks.task_canvas_tick, "send", _canvas_send)

        def _worker_loop(factory: Any) -> Any:
            coro = factory() if callable(factory) else factory
            result = run_virtual(coro)
            self.results.append(result)
            return result

        monkeypatch.setattr(tasks, "run_async_in_new_loop", _worker_loop)
        self._tasks = tasks
        return self

    # ── running ──

    def run(self, coro: Awaitable[Any]) -> Any:
        return run_virtual(coro)

    def run_scheduler(self) -> None:
        """One pass of the minute scheduler, as deployed."""
        self._tasks.task_process_scheduled_tasks.fn()

    def deliver(self) -> list[Any]:
        """The ticks worker takes every queued message, oldest first."""
        results: list[Any] = []
        while self.broker:
            results.append(self._deliver_one(self.broker.pop(0)))
        return results

    def deliver_one(self) -> Any:
        """The worker takes the oldest queued message."""
        return self._deliver_one(self.broker.pop(0))

    def _deliver_one(self, message: tuple[str, tuple[Any, ...], dict[str, Any]]) -> Any:
        kind, args, kwargs = message
        actor = (
            self._tasks.task_popcorn_tick_now if kind == "popcorn" else self._tasks.task_canvas_tick
        )
        before = len(self.results)
        actor.fn(*args, **kwargs)
        return self.results[before] if len(self.results) > before else None

    async def deliver_next(self) -> Any:
        """The next popcorn message, run inside the caller's event loop, for a
        test that needs two ticks in flight at once."""
        from dembrane.popcorn.ticks import run_popcorn_tick

        kind, args, kwargs = self.broker.pop(0)
        assert kind == "popcorn", kind
        return await run_popcorn_tick(*args, **kwargs)

    # ── popcorn: the project, the host, the reader ──

    def seed_popcorn_project(self) -> None:
        self.directus.insert(
            "project",
            {"id": PROJECT, "name": "Town hall", "language": "en", "is_canvas_enabled": True},
        )
        for cid, name in ((C1, "Table 1"), (C2, "Table 2")):
            self.directus.insert(
                "conversation",
                {"id": cid, "project_id": PROJECT, "participant_name": name, "deleted_at": None},
            )
        self.say(C1, "Nobody joins for the desks.")
        self.say(C1, "The kettle is the real reception.")
        self.say(C2, "Quiet is a service we sell.")

    def say(self, conversation_id: str, text: str) -> None:
        """A transcribed chunk lands on a conversation."""
        self._chunk_seq += 1
        self.directus.insert(
            "conversation_chunk",
            {
                "id": f"chunk-{self._chunk_seq}",
                "conversation_id": conversation_id,
                "transcript": text,
                "timestamp": self._chunk_seq,
            },
        )

    def start_session(self) -> None:
        """The host creates the session; its first read is delivered."""
        from dembrane.popcorn import service

        self.seed_popcorn_project()
        created = self.run(
            service.create_popcorn(
                project_id=PROJECT, title="Town hall", client=None, acting_directus_user_id=USER
            )
        )
        self.report_id = str(created["report"]["id"])
        self.loop_id = str(created["loop"]["id"])
        self.deliver()
        assert self.state()["run"] == 1, "the session's first read did not run"

    async def request(self, tick_kind: str = "manual") -> str:
        """A host read on request (refresh, rerun), as the API sends it. The
        request id both deliveries carry."""
        from dembrane.popcorn import service

        await service.dispatch_popcorn_tick_now_with_safety(self.loop_id, tick_kind)
        _kind, _args, kwargs = self.broker[-1]
        return str(kwargs["request_id"])

    async def go_live(self, hours: int = 1) -> dict[str, Any]:
        from dembrane.popcorn import service

        return await service.go_live(self.loop(), hours=hours)

    async def stop_live(self) -> dict[str, Any]:
        from dembrane.popcorn import service

        return await service.stop_live(self.loop())

    def payload(self) -> dict[str, Any]:
        """The session as the dashboard reads it."""
        from dembrane.popcorn import service

        report = self.directus.row("project_report", self.report_id)
        return self.run(service.popcorn_payload(report))

    def loop(self, loop_id: str | None = None) -> dict[str, Any]:
        found = self.directus.row("agent_loop", loop_id or self.loop_id)
        assert found is not None
        return found

    def state(self) -> dict[str, Any]:
        return self.loop()["popcorn_state"]

    def run_row(self, run_id: str) -> dict[str, Any] | None:
        return self.directus.row("agent_loop_run", run_id)

    def runs(self, loop_id: str | None = None) -> list[dict[str, Any]]:
        wanted = loop_id or self.loop_id
        return [r for r in self.directus.rows("agent_loop_run") if r.get("loop_id") == wanted]

    def task_rows(
        self, loop_id: str | None = None, *, task_type: str = "popcorn_tick"
    ) -> list[dict]:
        wanted = loop_id or self.loop_id
        return [
            row
            for row in self.directus.rows("scheduled_task")
            if row.get("task_type") == task_type
            and (row.get("payload") or {}).get("loop_id") == wanted
        ]

    def pending_rows(
        self, loop_id: str | None = None, *, task_type: str = "popcorn_tick"
    ) -> list[dict]:
        return [
            row for row in self.task_rows(loop_id, task_type=task_type) if row["status"] in PENDING
        ]

    def request_rows(self, request_id: str) -> list[dict[str, Any]]:
        return [
            row
            for row in self.task_rows()
            if (row.get("payload") or {}).get("request_id") == request_id
        ]

    def advance_to(self, when: datetime) -> None:
        self.clock.advance(max(0.0, (when - self.clock.peek()).total_seconds()))

    # ── canvas ──

    def start_canvas(self) -> None:
        """A canvas in the beta, with one conversation, its loop manual."""
        self.directus.insert(
            "project", {"id": CANVAS_PROJECT, "name": "Room", "is_canvas_enabled": True}
        )
        report = self.directus.insert(
            "project_report",
            {"project_id": CANVAS_PROJECT, "kind": "canvas", "status": "published"},
        )
        self.canvas_report_id = str(report["id"])
        self.directus.insert(
            "canvas_config_revision",
            {"report_id": self.canvas_report_id, "brief": "What the room wants", "gather_spec": {}},
        )
        loop = self.directus.insert(
            "agent_loop",
            {
                "project_id": CANVAS_PROJECT,
                "report_id": self.canvas_report_id,
                "name": "Room canvas",
                "status": "paused",
                "expires_at": (self.clock.peek() + timedelta(hours=8)).isoformat(),
                "cadence_minutes": 5,
                "acting_directus_user_id": USER,
                "failure_count": 0,
            },
        )
        self.canvas_loop_id = str(loop["id"])
        self.canvas_chunks: list[dict[str, Any]] = []
        self.canvas_say("Keep the doorway open.")

    def canvas_say(self, text: str) -> None:
        self._chunk_seq += 1
        self.canvas_chunks.append(
            {
                "id": f"canvas-chunk-{self._chunk_seq}",
                "transcript": text,
                "created_at": self.clock.now().isoformat(),
            }
        )

    async def _canvas_gather(self, **_: Any) -> dict[str, Any]:
        """What the canvas gather reads: the one conversation and when it last
        grew."""
        return {
            "latest_content_at": self.canvas_chunks[-1]["created_at"],
            "project": {"id": CANVAS_PROJECT, "name": "Room"},
            "conversations": [
                {
                    "id": CANVAS_CONVERSATION,
                    "label": "Maya",
                    "chunks": copy.deepcopy(self.canvas_chunks),
                }
            ],
        }

    async def canvas_action(self, action: str) -> dict[str, Any]:
        from dembrane.canvas import service as canvas_service

        return await canvas_service.apply_loop_action(self.loop(self.canvas_loop_id), action)

    async def canvas_host_item(self, text: str) -> dict[str, Any]:
        from dembrane.canvas import service as canvas_service

        return await canvas_service.add_canvas_host_item(
            report_id=self.canvas_report_id,
            text=text,
            target_tab="story",
            person=None,
            chat_id=None,
            message_id=None,
        )
