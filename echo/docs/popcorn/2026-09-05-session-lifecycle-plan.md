# Popcorn session lifecycle implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Popcorn reads on demand by default, live reading is a chosen mode with a duration, the deck opens full screen in its own tab, and every host control lives in the dashboard.

**Architecture:** The loop's `status` carries the mode (`paused` = manual, `active` = live); the tick only honours expiry when scheduled. The BFF gains rerun, live, live/stop, readiness and a latency beacon. The dashboard route is split into one component per section and loses the iframe. The deck reads `?present=1`, counts down to the first phrase, and draws quotation marks only for verbatim phrases. The extractor prompt moves to v1.7 without weights.

**Tech Stack:** FastAPI + Directus (server), Dramatiq worker, vanilla JS deck under `server/dembrane/popcorn/static/`, React + Mantine + Lingui + TanStack Query (frontend), pytest, vitest/biome.

**Spec:** `docs/popcorn/2026-09-05-session-lifecycle-design.md`

## Global Constraints

- Every server test command runs inside the dev container: `devcontainer exec --workspace-folder ~/Dev/echo/echo bash -lc 'cd /workspaces/echo/server && uv run pytest tests/test_popcorn_*.py -q -p no:cacheprovider'`. Ruff and mypy the same way (`uv run ruff check dembrane/popcorn tests/test_popcorn_*.py`, `uv run ruff format ...`, `uv run mypy dembrane/popcorn`; mypy must report no line under `dembrane/popcorn`).
- Frontend checks inside the container: `cd /workspaces/echo/frontend && pnpm check && pnpm exec tsc --noEmit -p tsconfig.json` (biome and TypeScript). Lingui: `pnpm messages:extract` after the last string change; commit the catalogs.
- After every server edit the six processes restart: `~/.claude/skills/echo-local-dev/scripts/echo-dev.sh stop && ~/.claude/skills/echo-local-dev/scripts/echo-dev.sh start`, then wait for `curl -sf localhost:8000/api/health`.
- Prompt files are immutable snapshots: a change is a new file and a new constant in `model.py`.
- dembrane is lowercase in every string. No em dashes in copy. English copy in the frontend goes through the `t` / `Trans` macros.
- Commit messages start with `popcorn:` and end with the Co-Authored-By line. Push to `popcorn-lab-sync` after each task; it is the branch of PR #1044.
- No participant material from the vault in any test or fixture; fiction only.

---

### Task 1: The extractor without weights

**Files:**
- Create: `server/dembrane/popcorn/prompts/popcorn-v1.7.md`
- Modify: `server/dembrane/popcorn/model.py:31` (`POPCORN_PROMPT`)
- Modify: `server/dembrane/popcorn/analysis.py:21-40` (`POPCORN_SCHEMA`), `:196-249` (`shape_popcorn_items`)
- Modify: `server/dembrane/popcorn/flags.py:189-201` (twin rule in `gate_items`)
- Modify: `server/dembrane/popcorn/service.py` (`build_bundle`, the item entry)
- Modify: `server/dembrane/popcorn/static/app.js:1363` (`el.dataset.weight`), `static/styles.css:622-627`
- Test: `server/tests/test_popcorn_analysis.py`, `server/tests/test_popcorn_flags.py`

**Interfaces:**
- Produces: `POPCORN_SCHEMA` items are `{"phrase": str}`; `shape_popcorn_items` entries carry `id`, `phrase`, optional `question`, never `weight`; bundle items carry no `weight`.

- [ ] **Step 1: Write the failing tests**

In `tests/test_popcorn_analysis.py` replace the two shape tests:

```python
def test_shape_popcorn_items_applies_first_run_gates() -> None:
    raw = {
        "items": [
            {"phrase": '"Nobody joins for the desks."'},
            {"phrase": "Nobody joins for the desks"},  # near-duplicate
            {"phrase": "The kettle is the real reception!"},
            {"phrase": "x" * 120},  # over the length budget
            {"phrase": "   "},
            {"phrase": "one two three four five six seven eight nine ten eleven twelve thirteen fourteen"},
            {"phrase": "Where did the budget go?"},
            {"phrase": 'He said "no" and left'},  # a quotation mark inside
            {"phrase": "Old clients still send weight", "weight": 3},  # ignored, not refused
        ]
    }
    items = shape_popcorn_items(raw, "t1")
    assert [i["phrase"] for i in items] == [
        "Nobody joins for the desks",
        "The kettle is the real reception",
        "Where did the budget go",
        "Old clients still send weight",
    ]
    assert all("weight" not in i for i in items)
    # The question mark is stripped like every terminal mark, and remembered.
    assert items[2]["question"] is True and "question" not in items[0]
    ids = [i["id"] for i in items]
    assert all(i.startswith("p-t1-") and len(i) == len("p-t1-") + 8 for i in ids)
    assert len(set(ids)) == 4
    # Same phrase, same id: a re-read keeps the phrases that survived.
    assert shape_popcorn_items(raw, "t1")[0]["id"] == ids[0]


def test_shape_popcorn_items_caps_at_eight_and_tolerates_junk() -> None:
    raw = {"items": [{"phrase": f"phrase {n}"} for n in range(12)]}
    assert len(shape_popcorn_items(raw, "t")) == 8
    assert shape_popcorn_items(None, "t") == []
    assert shape_popcorn_items({"items": "nope"}, "t") == []


def test_popcorn_schema_has_no_weight() -> None:
    from dembrane.popcorn.analysis import POPCORN_SCHEMA

    item = POPCORN_SCHEMA["properties"]["items"]["items"]
    assert item["required"] == ["phrase"] and "weight" not in item["properties"]
```

In `tests/test_popcorn_flags.py` replace `test_gate_items_holds_back_names_known_text_and_twins`:

```python
def test_gate_items_holds_back_names_known_text_and_twins() -> None:
    known = known_shingles(
        {"conversations": {"c": {"items": [{"phrase": "the kettle is the real reception here"}]}}}
    )
    items = [
        {"id": "1", "phrase": "Nobody joins for the desks"},
        {"id": "2", "phrase": "Priya runs the Tuesday group"},
        {"id": "3", "phrase": "the kettle is the real reception here"},
        {"id": "4", "phrase": "Nobody joins because of the desks"},  # a twin of 1
        {"id": "5", "phrase": "The desks are why nobody joins"},  # another twin of 1
    ]
    kept, suppressed = gate_items(items, names={"Priya"}, known=known)
    # Between twins the first kept wins: there is no weight to prefer one by.
    assert [k["id"] for k in kept] == ["1"]
    reasons = {s["id"]: s["reason"] for s in suppressed}
    assert "name" in reasons["2"] and "Priya" in reasons["2"]
    assert "text the room was shown" in reasons["3"]
    assert reasons["4"].startswith("says what") and reasons["5"].startswith("says what")
    plain = [{"id": "a", "phrase": "quiet is a service we sell"}]
    assert gate_items(plain, names=set(), known=set()) == (plain, [])
```

In `tests/test_popcorn_analysis.py::test_build_bundle_hides_tabs_and_carries_qr` (and any other bundle test that asserts `weight`), assert `"weight" not in entry` for the popcorn item instead.

- [ ] **Step 2: Run the tests, expect failures**

Expected: the shape tests fail on `weight` present / the schema test fails; the flags test fails because item 4 has no weight and the old rule reads `weight`.

- [ ] **Step 3: The prompt**

`cp prompts/popcorn-v1.6.md prompts/popcorn-v1.7.md`, then in v1.7: change the version line to `Version: popcorn-v1.7`, delete the `## Weight` section through `Do not award weight for dramatic wording.` (keep `Return only the structured output requested by the caller.`), and remove any mention of `weight` in the output description above it (grep `weight` in the file; it must be gone). In `model.py`: `POPCORN_PROMPT = "popcorn-v1.7"` and update the docstring line that lists the snapshots.

- [ ] **Step 4: Schema and shaper**

`analysis.py`:

```python
# The public popcorn contract: at most eight phrases, each short. Size on the
# wall is one size; the deck steps a phrase down only to make it fit.
POPCORN_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["items"],
    "properties": {
        "items": {
            "type": "array",
            "maxItems": 8,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["phrase"],
                "properties": {"phrase": {"type": "string", "minLength": 1, "maxLength": 90}},
            },
        }
    },
}
```

In `shape_popcorn_items`: delete `weight3_used`, the `weight` parsing block and `"weight": weight` in the entry; update the docstring ("unique phrases, at most thirteen words, no quotation marks or terminal punctuation").

- [ ] **Step 5: Twin rule and bundle**

`flags.py` `gate_items`: replace the weight comparison with

```python
        if twin is not None:
            suppressed.append({**item, "reason": f"says what {twin['phrase']!r} says"})
            continue
```

and update the module docstring's first bullet ("the first of two twins stays"). `service.py` `build_bundle`: the item entry is `{"id": item["id"], "phrase": item["phrase"]}`; remove `"weight": item["weight"]`.

- [ ] **Step 6: The deck's one size**

`app.js` in `spawnPop`: `el.dataset.weight = 2;` (the step-down-to-fit below it keeps working). `styles.css`: delete the six `data-weight` lines and add

```css
.pop .pop-phrase { font-size: clamp(24px, 2.6vw, 42px); }
.pop[data-weight="1"] .pop-phrase { font-size: clamp(19px, 1.9vw, 30px); }   /* stepped down to fit */
.pop.center .pop-phrase { font-size: clamp(32px, 3.6vw, 58px); }
.pop.center[data-weight="1"] .pop-phrase { font-size: clamp(26px, 2.8vw, 46px); }
```

- [ ] **Step 7: Prompts leave the fingerprints**

A prompt change must not re-read a running session (Jorim, September 5th
2026). In `ticks.py`: delete `_prompts_version`, `POPCORN_PASS_PROMPTS`,
`ANALYSIS_PASS_PROMPTS` and the five model-constant imports they needed; the
conversation fingerprint goes back to `_fingerprint(t["text"] + "\x1f" + host_note)`;
the analysis fingerprint to `_fingerprint("|".join(f"{t['id']}:{t['fingerprint']}" for t in transcripts))`.
Fix the module docstring (the bullet that lists what the fingerprint covers)
and the gather section of `static/flow.html` ("the text of the popcorn
prompts" goes; say instead that a new prompt version applies to conversations
read after it ships, and to a rerun). Delete
`test_a_new_prompt_version_re_reads_the_session` from `tests/test_popcorn_ticks.py`.

- [ ] **Step 8: Run the popcorn suite, ruff, mypy; expect green**

- [ ] **Step 9: Commit**

```bash
git add server/dembrane/popcorn server/tests/test_popcorn_analysis.py server/tests/test_popcorn_flags.py server/tests/test_popcorn_ticks.py
git commit -m "popcorn: the extractor no longer weighs phrases (popcorn-v1.7); prompts leave the fingerprints"
```

---

### Task 2: Held-back phrases and the tally

**Files:**
- Modify: `server/dembrane/popcorn/enrichment.py` (`apply_results`), `server/dembrane/popcorn/ticks.py` (`_enrich_one`), `server/dembrane/popcorn/service.py` (`state_counts`, `build_bundle`)
- Test: `server/tests/test_popcorn_enrichment.py`, `server/tests/test_popcorn_ticks.py`, `server/tests/test_popcorn_analysis.py`

**Interfaces:**
- Produces: `apply_results` marks `item["rooted"] = False` when the pass answered and found no passage; `_enrich_one` moves those items to `entry["review"]["dropped"]` (list of `{id, phrase, reason}`); bundle popcorn files carry `held_back: int`; `state_counts` carries `validated` (items with a `quoteId`) and `held_back`.

- [ ] **Step 1: Failing tests**

`tests/test_popcorn_enrichment.py`, in `test_apply_results_writes_once_and_skips_a_phrase_that_moved`, add after the existing assertions on `items[0]`:

```python
    assert items[0]["rooted"] is False  # the pass answered: no passage
    assert "rooted" not in items[2]  # the evidence call failed: not decided
```

`tests/test_popcorn_ticks.py`, new test:

```python
def test_a_phrase_without_a_passage_leaves_the_deck(fake: _FakeDirectus, monkeypatch) -> None:
    calls: list[str] = []
    _install_models(monkeypatch, calls=calls)

    async def _no_passage(*, transcript_id: str, transcript: str, phrase: str) -> dict[str, Any]:  # noqa: ARG001
        if transcript_id == "c2":
            return {"grounded": False, "quote": "", "reason": "nothing like it was said"}
        return {"grounded": True, "quote": transcript.split("\n")[0], "reason": "r"}

    monkeypatch.setattr(ticks, "validate_phrase", _no_passage)
    asyncio.run(ticks.run_popcorn_tick("loop1", "manual"))
    state = fake.items["agent_loop"]["loop1"]["popcorn_state"]
    c2 = state["conversations"]["c2"]
    assert c2["items"] == [] and c2["validated_fingerprint"] == c2["fingerprint"]
    assert c2["review"]["dropped"][0]["phrase"] == "Quiet is a service we sell"
    assert c2["review"]["dropped"][0]["reason"] == "nothing like it was said"
    assert "held back" in fake.created["agent_loop_run"][-1]["detail"]
    from dembrane.popcorn.service import state_counts

    counts = state_counts(state)
    assert counts["phrases"] == 1 and counts["validated"] == 1 and counts["held_back"] == 1
```

`tests/test_popcorn_analysis.py`, in a bundle test, give a conversation `"review": {"dropped": [{"id": "x", "phrase": "p", "reason": "r"}]}` and assert `files["popcorn/<cid>.json"]["held_back"] == 1` and that the room bundle carries no `review`.

- [ ] **Step 2: Run, expect failures**

- [ ] **Step 3: Implement**

`enrichment.py` `apply_results`, inside `if evidence is not None:` after the quoteId branch:

```python
            item["rooted"] = bool(item.get("quoteId"))
```

`ticks.py` `_enrich_one`, after `stats = apply_results(...)`:

```python
    # A phrase the pass could not root leaves the deck: the room must not
    # read a paraphrase nothing in the transcript holds. The host keeps it.
    dropped = [i for i in entry["items"] if i.get("rooted") is False]
    if dropped:
        review = dict(entry.get("review") or {})
        review["dropped"] = (review.get("dropped") or []) + [
            {
                "id": i.get("id"),
                "phrase": i.get("phrase"),
                "reason": str((i.get("review") or {}).get("evidence") or ""),
            }
            for i in dropped
        ]
        entry["review"] = review
        entry["items"] = [i for i in entry["items"] if i.get("rooted") is not False]
```

and in the outcomes line add `+ (f", {len(dropped)} held back" if dropped else "")`. Note `items` in `_enrich_one` is the filtered list of items owed a pass; `entry["items"]` is the full list, and `apply_results` wrote onto the same dicts.

`service.py` `state_counts`: add

```python
        "validated": sum(
            1 for c in conversations.values() for i in (c.get("items") or []) if i.get("quoteId")
        ),
        "held_back": sum(
            len((c.get("review") or {}).get("dropped") or []) for c in conversations.values()
        ),
```

`build_bundle`: on the popcorn file add `"held_back": len((conv.get("review") or {}).get("dropped") or [])`.

- [ ] **Step 4: Run the suite, ruff, mypy; green**

- [ ] **Step 5: Commit** `popcorn: a phrase without a passage leaves the deck; the tally counts validated and held back`

---

### Task 3: Lifecycle in the service and the tick

**Files:**
- Modify: `server/dembrane/popcorn/service.py` (`create_popcorn`, `go_live_again` → `go_live`, new `stop_live`, `reset_for_rerun`, `readiness`, `loop_payload`, `update_settings` keys)
- Modify: `server/dembrane/popcorn/ticks.py` (expiry rules in `run_popcorn_tick`, `_enqueue_next_if_due`)
- Create: `server/tests/test_popcorn_service.py`
- Test: `server/tests/test_popcorn_ticks.py`

**Interfaces:**
- Produces: `create_popcorn(*, project_id, title, client, acting_directus_user_id)` (no cadence, no expiry) creates the loop `paused` with `expires_at = now` and dispatches a manual tick; `go_live(loop, *, hours: int)`; `stop_live(loop)`; `reset_for_rerun(loop) -> dict` (fresh state, run counter kept, returns the written state); `readiness(*, project_id, acting_directus_user_id) -> {"conversations": int, "words": int}`; `loop_payload` adds `"mode": "live" if status == "active" else "manual"`; `LIVE_HOURS = (1, 8, 24)`.

- [ ] **Step 1: Failing tests**

`tests/test_popcorn_service.py`:

```python
from __future__ import annotations

import asyncio
from typing import Any

import pytest

import dembrane.popcorn.service as service


class _Directus:
    def __init__(self) -> None:
        self.rows: dict[str, dict[str, dict[str, Any]]] = {"agent_loop": {}, "project_report": {}, "canvas_config_revision": {}}
        self.updates: list[tuple[str, str, dict[str, Any]]] = []

    async def create_item(self, collection: str, data: dict[str, Any]) -> dict[str, Any]:
        row = {"id": data.get("id") or str(len(self.rows.setdefault(collection, {})) + 1), **data}
        self.rows.setdefault(collection, {})[str(row["id"])] = row
        return {"data": row}

    async def update_item(self, collection: str, item_id: str, data: dict[str, Any]) -> dict[str, Any]:
        self.updates.append((collection, item_id, data))
        self.rows.setdefault(collection, {}).setdefault(item_id, {"id": item_id}).update(data)
        return {"data": self.rows[collection][item_id]}

    async def get_item(self, collection: str, item_id: str) -> dict[str, Any] | None:
        return self.rows.get(collection, {}).get(item_id)


@pytest.fixture
def directus(monkeypatch) -> _Directus:
    fake = _Directus()
    monkeypatch.setattr(service, "async_directus", fake)
    dispatched: list[tuple[str, str]] = []

    async def _dispatch(loop_id: str, tick_kind: str = "manual") -> None:
        dispatched.append((loop_id, tick_kind))

    monkeypatch.setattr(service, "dispatch_popcorn_tick_now_with_safety", _dispatch)
    fake.dispatched = dispatched  # type: ignore[attr-defined]

    async def _cancel(**kwargs: Any) -> int:  # noqa: ARG001
        return 0

    monkeypatch.setattr(service, "cancel_pending_popcorn_ticks", _cancel)
    return fake


def test_a_new_session_is_manual_and_reads_once(directus: _Directus) -> None:
    created = asyncio.run(
        service.create_popcorn(project_id="p1", title="Town hall", client=None, acting_directus_user_id="u1")
    )
    loop = created["loop"]
    assert loop["status"] == "paused" and loop["expires_at"]
    assert directus.dispatched == [(str(loop["id"]), "manual")]  # type: ignore[attr-defined]
    payload = service.loop_payload(loop, None)
    assert payload and payload["mode"] == "manual"


def test_live_sets_an_expiry_and_stop_returns_to_manual(directus: _Directus) -> None:
    created = asyncio.run(
        service.create_popcorn(project_id="p1", title="T", client=None, acting_directus_user_id="u1")
    )
    loop = created["loop"]
    live = asyncio.run(service.go_live(loop, hours=1))
    assert live["status"] == "active"
    expires = service._parse_dt(live["expires_at"])
    assert expires is not None and 55 * 60 < (expires - service._now()).total_seconds() <= 60 * 60
    assert service.loop_payload(live, None)["mode"] == "live"  # type: ignore[index]
    assert directus.dispatched[-1] == (str(loop["id"]), "manual")  # type: ignore[attr-defined]
    stopped = asyncio.run(service.stop_live(live))
    assert stopped["status"] == "paused"
    with pytest.raises(ValueError):
        asyncio.run(service.go_live(loop, hours=3))


def test_rerun_resets_the_state_and_keeps_the_run_counter(directus: _Directus) -> None:
    created = asyncio.run(
        service.create_popcorn(project_id="p1", title="T", client=None, acting_directus_user_id="u1")
    )
    loop = created["loop"]
    loop["popcorn_state"] = {
        "version": 2,
        "run": 7,
        "order": ["c1"],
        "conversations": {"c1": {"id": "c1", "items": [{"id": "p", "phrase": "x"}]}},
        "quotes": [{"id": "q1", "transcript": "c1", "text": "x"}],
        "analysis": {"tensions": {"tensions": []}},
    }
    state = asyncio.run(service.reset_for_rerun(loop))
    assert state["run"] == 7 and state["conversations"] == {} and state["quotes"] == []
    assert state["analysis"] is None
    written = [d for c, _i, d in directus.updates if c == "agent_loop" and "popcorn_state" in d]
    assert written[-1]["popcorn_state"] == state
    assert directus.dispatched[-1] == (str(loop["id"]), "manual")  # type: ignore[attr-defined]


def test_readiness_counts_transcribed_conversations_and_words(monkeypatch) -> None:
    async def _gather(*, project_id: str, acting_directus_user_id: str) -> list[dict[str, Any]]:  # noqa: ARG001
        return [{"id": "a", "text": "one two three"}, {"id": "b", "text": "four five"}]

    monkeypatch.setattr(service, "gather_transcripts", _gather)
    assert asyncio.run(service.readiness(project_id="p", acting_directus_user_id="u")) == {
        "conversations": 2,
        "words": 5,
    }
```

`tests/test_popcorn_ticks.py`, two new tests:

```python
def test_a_scheduled_tick_past_expiry_returns_the_loop_to_manual(fake: _FakeDirectus, monkeypatch) -> None:
    calls: list[str] = []
    _install_models(monkeypatch, calls=calls)
    loop = fake.items["agent_loop"]["loop1"]
    loop["expires_at"] = "2000-01-01T00:00:00+00:00"
    result = asyncio.run(ticks.run_popcorn_tick("loop1", "scheduled"))
    assert result["status"] == "no_op"
    assert loop["status"] == "paused" and calls == []
    assert "Live ended" in fake.created["agent_loop_run"][-1]["detail"]


def test_a_manual_tick_ignores_expiry(fake: _FakeDirectus, monkeypatch) -> None:
    calls: list[str] = []
    _install_models(monkeypatch, calls=calls)
    loop = fake.items["agent_loop"]["loop1"]
    loop["status"] = "paused"
    loop["expires_at"] = "2000-01-01T00:00:00+00:00"
    result = asyncio.run(ticks.run_popcorn_tick("loop1", "manual"))
    assert result["status"] == "ok" and loop["status"] == "paused"
    assert sorted(c for c in calls if c.startswith("popcorn")) == ["popcorn:c1", "popcorn:c2"]
    # Manual mode books nothing.
    assert fake.enqueued == []  # type: ignore[attr-defined]
```

Also change `test_first_tick_pops_every_transcript_then_analyses`'s last assertion: with the fixture loop `active` it still books twice; keep it, and add `loop["status"] = "active"` explicitly at the top of that test so the intent is visible.

- [ ] **Step 2: Run, expect failures** (`create_popcorn` signature, `go_live`, `stop_live`, `reset_for_rerun`, `readiness`, `cancel_pending_popcorn_ticks` missing; expiry tests fail on `expired`).

- [ ] **Step 3: Service**

`service.py`:

```python
LIVE_HOURS = (1, 8, 24)


def _parse_dt(value: Any) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


async def cancel_pending_popcorn_ticks(loop_id: str) -> int:
    from dembrane.scheduled_tasks import cancel_pending_tasks

    return await cancel_pending_tasks(task_type=TASK_POPCORN_TICK, payload_match={"loop_id": loop_id})
```

`create_popcorn(*, project_id, title, client, acting_directus_user_id)`: drop `cadence_minutes` and `expires_at` parameters; the loop row gets `"status": "paused"`, `"expires_at": _now().isoformat()`, `"cadence_minutes": DEFAULT_CADENCE_MINUTES`; the config revision keeps `cadence_minutes`. Docstring: "manual mode: one read now, nothing scheduled".

Replace `go_live_again` with:

```python
async def go_live(loop: dict[str, Any], *, hours: int) -> dict[str, Any]:
    """Live: the two-minute chain until the expiry, reading straight away.
    Stop live, or the expiry, returns the session to manual."""
    if hours not in LIVE_HOURS:
        raise ValueError(f"hours must be one of {LIVE_HOURS}")
    loop_id = str(loop["id"])
    expires_at = (_now() + timedelta(hours=hours)).isoformat()
    updated = _data(
        await async_directus.update_item(
            "agent_loop",
            loop_id,
            {"status": "active", "expires_at": expires_at, "failure_count": 0},
        )
    )
    await dispatch_popcorn_tick_now_with_safety(loop_id, "manual")
    return updated


async def stop_live(loop: dict[str, Any]) -> dict[str, Any]:
    """Back to manual: nothing scheduled, the deck stays, Refresh still works."""
    loop_id = str(loop["id"])
    await cancel_pending_popcorn_ticks(loop_id)
    return _data(
        await async_directus.update_item(
            "agent_loop", loop_id, {"status": "paused", "expires_at": _now().isoformat()}
        )
    )


async def reset_for_rerun(loop: dict[str, Any]) -> dict[str, Any]:
    """Wipe the live state (phrases, quotes, analysis) and read again. The
    run counter continues so the saved runs stay in order; they are kept."""
    loop_id = str(loop["id"])
    previous = normalize_state(loop.get("popcorn_state"))
    state = fresh_state()
    state["run"] = previous["run"]
    await async_directus.update_item("agent_loop", loop_id, {"popcorn_state": state})
    await dispatch_popcorn_tick_now_with_safety(loop_id, "manual")
    return state


async def readiness(*, project_id: str, acting_directus_user_id: str) -> dict[str, int]:
    """What a first read would find: conversations with a transcript, and the
    words in them (the dashboard shows minutes at 150 a minute)."""
    from dembrane.popcorn.ticks import gather_transcripts

    transcripts = await gather_transcripts(
        project_id=project_id, acting_directus_user_id=acting_directus_user_id
    )
    return {
        "conversations": len(transcripts),
        "words": sum(len(t["text"].split()) for t in transcripts),
    }
```

(`readiness` imports `gather_transcripts` inside the function because `ticks` imports `service`; the test monkeypatches `service.gather_transcripts`, so bind it at module level instead: `from dembrane.popcorn import ticks as _ticks` is circular; use a module-level indirection `async def gather_transcripts(**kw): from dembrane.popcorn.ticks import gather_transcripts as g; return await g(**kw)` and call that.)

`loop_payload`: add `"mode": "live" if loop.get("status") == "active" else "manual"`.

`update_settings`: add `"public_labels"` to the copied keys.

- [ ] **Step 4: Tick expiry rules**

`ticks.py` `run_popcorn_tick`, replace the expiry block:

```python
    expires_at = _parse_dt(loop.get("expires_at"))
    if tick_kind != "manual":
        if loop.get("status") != "active":
            run = await _create_run(
                loop_id=loop_id, status="no_op", detail=f"Loop is {loop.get('status')}", started_at=started_at
            )
            return {"status": "no_op", "run": run}
        if expires_at and started_at >= expires_at:
            # Live ended: back to manual. The deck stays; Refresh still works.
            await async_directus.update_item(
                "agent_loop", loop_id, {"status": "paused", "expires_at": started_at.isoformat()}
            )
            run = await _create_run(
                loop_id=loop_id, status="no_op", detail="Live ended; back to manual", started_at=started_at
            )
            return {"status": "no_op", "run": run}
```

`_enqueue_next_if_due`: both `{"status": "expired"}` writes become `{"status": "paused"}` (with the docstring "Live ended: back to manual").

- [ ] **Step 5: Run the suite, ruff, mypy; green. Commit** `popcorn: manual by default, live by choice; rerun, readiness, stop live in the service`

---

### Task 4: The API

**Files:**
- Modify: `server/dembrane/api/v2/bff/popcorn.py`

**Interfaces:**
- Produces the routes in the spec's table. `CreatePopcornBody` keeps `expires_at: datetime | None = None` and `cadence_minutes: int | None = None` (ignored, for older clients). `LiveBody(hours: int)`. `LatencyBody(ms: int = Field(ge=0, le=600_000))`.

- [ ] **Step 1: Implement**

```python
@router.get("")
async def get_project_popcorn(auth: DependencyDirectusSession, project_id: str = Query(...)) -> dict[str, Any]:
    """The project's popcorn session, or `{"popcorn": null, "readiness": {...}}`
    before one exists: what a first read would find."""
    access = await resolve_project_access(project_id, auth)
    require_project_canvas_enabled(access.project)
    access.require("project:read")
    report = await get_popcorn_report(project_id)
    if report:
        return {"popcorn": await popcorn_payload(report)}
    return {
        "popcorn": None,
        "readiness": await readiness(project_id=project_id, acting_directus_user_id=auth.user_id),
    }
```

`create_project_popcorn`: call `create_popcorn(project_id=..., title=..., client=..., acting_directus_user_id=auth.user_id)`.

```python
@router.post("/{popcorn_id}/rerun", status_code=status.HTTP_202_ACCEPTED)
async def rerun_popcorn(popcorn_id: str, auth: DependencyDirectusSession) -> dict[str, str]:
    """Wipe the phrases, quotes and analysis and read everything again. Saved
    runs stay in the history."""
    report, access = await _require_popcorn(popcorn_id, auth)
    access.require("project:update")
    loop = await get_loop_for_report(str(report["id"]))
    if not loop:
        raise HTTPException(status_code=404, detail="Popcorn loop not found")
    await _rate_limit(popcorn_id)
    await reset_for_rerun(loop)
    forget_bundle(str(report["id"]))
    return {"tick": "queued"}


class LiveBody(BaseModel):
    hours: int


@router.post("/{popcorn_id}/live")
async def popcorn_live(popcorn_id: str, body: LiveBody, auth: DependencyDirectusSession) -> dict[str, Any]:
    report, access = await _require_popcorn(popcorn_id, auth)
    access.require("project:update")
    loop = await get_loop_for_report(str(report["id"]))
    if not loop:
        raise HTTPException(status_code=404, detail="Popcorn loop not found")
    try:
        await go_live(loop, hours=body.hours)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return await popcorn_payload(report)


@router.post("/{popcorn_id}/live/stop")
async def popcorn_live_stop(popcorn_id: str, auth: DependencyDirectusSession) -> dict[str, Any]:
    report, access = await _require_popcorn(popcorn_id, auth)
    access.require("project:update")
    loop = await get_loop_for_report(str(report["id"]))
    if not loop:
        raise HTTPException(status_code=404, detail="Popcorn loop not found")
    await stop_live(loop)
    return await popcorn_payload(report)


class LatencyBody(BaseModel):
    ms: int = Field(ge=0, le=600_000)


@router.post("/{popcorn_id}/view/data/latency", status_code=status.HTTP_204_NO_CONTENT)
async def popcorn_view_latency(popcorn_id: str, body: LatencyBody, auth: DependencyDirectusSession) -> Response:
    """The deck's beacon when the first phrase missed the three-second count."""
    report, access = await _require_popcorn(popcorn_id, auth)
    await capture_event(
        auth.user_id,
        "popcorn_first_phrase_late",
        {"popcorn_id": str(report["id"]), "project_id": _as_id(access.project.get("id")), "ms": body.ms},
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
```

Extract the refresh rate limit into `async def _rate_limit(popcorn_id: str) -> None` (raises the 429) and use it in both refresh and rerun. Delete `popcorn_loop_action`, `patch_popcorn_loop`, `PopcornLoopSettingsBody`, and the imports of `apply_loop_action`, `update_loop_settings`, `go_live_again`. Add `public_labels: str | None = None` to `PopcornSettingsBody` (validated to `"names"` or `"neutral"`, else 422). Import `readiness, go_live, stop_live, reset_for_rerun` from the service and `capture_event` from `dembrane.analytics`, `Response` from fastapi.

The `sendBeacon` from the deck posts `text/plain`; accept the body as raw JSON: read `await request.json()` guarded, or declare the endpoint with `request: Request` and parse `ms` from `await request.body()`. Use the latter so a beacon without a content type still lands.

- [ ] **Step 2: ruff, mypy, restart the stack, prove the routes in the Browser pane**

From the dashboard origin in `javascript_tool`:

```js
const id = 3;
const post = (p, b) => fetch(`/api/v2/bff/popcorn/${id}${p}`, {method:'POST', credentials:'include', headers: b ? {'Content-Type':'application/json'} : undefined, body: b ? JSON.stringify(b) : undefined}).then(async r => [r.status, await r.text()]);
({live: await post('/live', {hours: 1}), stop: await post('/live/stop'), latency: await post('/view/data/latency', {ms: 4200}), readiness: await (await fetch('/api/v2/bff/popcorn?project_id=<a project without a session>', {credentials:'include'})).json()})
```

Expected: live 200 with `loop.mode === "live"`, stop 200 with `"manual"`, latency 204, readiness present.

- [ ] **Step 3: Commit** `popcorn: rerun, live, stop live, readiness and the latency beacon on the BFF`

---

### Task 5: The deck

**Files:**
- Modify: `server/dembrane/popcorn/static/app.js`, `static/styles.css`, `static/SOURCE.md`
- Test: `server/tests/test_popcorn_view.py` (the page still carries the embed; add a test that `render_popcorn_page` output contains `present`)

**Interfaces:**
- Consumes: `?present=1`; bundle fields `verbatim`, `held_back`, `validated`, `done`.
- Produces: beacon `POST data/latency` with `{ms}`.

- [ ] **Step 1: Presenting from the query**

Replace the message listener block:

```js
  const HOST = EMBED && EMBED.mode === "host";
  // The presenter view is the wall: opened in its own tab with ?present=1,
  // it shows the room's bundle and no host affordance, from the first paint.
  const presenting = HOST && new URLSearchParams(location.search).get("present") === "1";
  if (presenting) document.body.classList.add("presenting");
  const hostMeta = () => (HOST && !presenting && state.session && state.session.host) || null;
```

Delete `postHostSetting` and its call sites (the tab hide/show buttons and the QR corner become no-ops when `hostMeta()` is null; remove the dead handlers rather than leave them). Keep `renderTabs` reading `hostMeta()`.

- [ ] **Step 2: Quotation marks**

```js
  const quotedPhrase = (item) => {
    const text = esc(phraseText(item));
    return item.verbatim ? `“${text}”` : text;
  };
```

Delete `.pop-mark` rules from `styles.css`. Disclaimer: `popcorn is optimised for latency, not accuracy. popcorns in “quotes” are the room's words, word for word; the rest paraphrase what was said.`

- [ ] **Step 3: Countdown and beacon**

State: `state.pop.countdown = null;  // { startedAt } while the first read is in flight`. In `popTick`, replace the `if (!total)` block:

```js
    const transcripts = (state.session?.transcripts || []).length;
    const read = [...state.popcorn.values()].filter((p) => p.done).length;
    const inFlight = EMBED && transcripts > 0 && read < transcripts;
    if (!total) {
      if (inFlight && !state.pop.countdown) state.pop.countdown = { startedAt: Date.now(), beaconed: false };
      if (!inFlight) state.pop.countdown = null;
      const msg = !state.session ? "drop your session's JSON files anywhere on this page"
        : EMBED && !transcripts ? "waiting for the first conversation"
        : EMBED && read >= transcripts ? `read ${transcripts} conversation${transcripts === 1 ? "" : "s"}, nothing worth a popcorn yet`
        : EMBED ? "reading the conversations…"
        : "listening…";
      renderWaiting(stageEl, msg);
      return;
    }
    // The first phrase waits for the count to end, so 3, 2, 1 is honest.
    if (state.pop.countdown && Date.now() - state.pop.countdown.startedAt < COUNTDOWN_MS) {
      renderWaiting(stageEl, "");
      return;
    }
    state.pop.countdown = null;
    stageEl.querySelector(".popcorn-waiting")?.remove();
```

with `const COUNTDOWN_MS = 3000;` beside the other constants and

```js
  // The empty stage: a message, or the count to the first popcorn. Past the
  // count with nothing landed: a spinner, and one note of the latency.
  function renderWaiting(stageEl, msg) {
    let waiting = stageEl.querySelector(".popcorn-waiting");
    if (!waiting) {
      waiting = document.createElement("p");
      waiting.className = "popcorn-waiting";
      stageEl.innerHTML = "";
      stageEl.appendChild(waiting);
    }
    const cd = state.pop.countdown;
    if (cd) {
      const elapsed = Date.now() - cd.startedAt;
      if (elapsed < COUNTDOWN_MS) {
        const n = 3 - Math.floor(elapsed / 1000);
        const html = `<span class="countdown" aria-live="polite">${n}</span>`;
        if (waiting.innerHTML !== html) waiting.innerHTML = html;
        return;
      }
      if (!cd.beaconed) {
        cd.beaconed = true;
        if (HOST) navigator.sendBeacon("data/latency", new Blob([JSON.stringify({ ms: elapsed })], { type: "application/json" }));
      }
      const html = `<span class="spinner" aria-hidden="true"></span>&nbsp; the first popcorn is taking longer than usual`;
      if (waiting.innerHTML !== html) waiting.innerHTML = html;
      return;
    }
    const html = `<span class="live-dot"></span>&nbsp; ${msg}`;
    if (!waiting.textContent.includes(msg.slice(0, 8))) waiting.innerHTML = html;
  }
```

Styles:

```css
.popcorn-waiting .countdown { font-size: clamp(64px, 9vw, 160px); font-weight: 300; color: var(--graphite); animation: count-in 0.5s cubic-bezier(0.2, 1.4, 0.4, 1); }
@keyframes count-in { from { opacity: 0; transform: scale(0.6); } to { opacity: 1; transform: scale(1); } }
.popcorn-waiting .spinner { display: inline-block; width: 0.8em; height: 0.8em; border: 2px solid var(--hairline); border-top-color: var(--blue); border-radius: 50%; animation: spin 0.9s linear infinite; vertical-align: -0.1em; }
@keyframes spin { to { transform: rotate(360deg); } }
```

The `popTick` interval must fire often enough for the digits: check the interval constant; if it is above 250 ms, run the countdown on its own `setInterval(() => popTick(), 200)` while `state.pop.countdown` is set.

- [ ] **Step 4: The tally**

In `renderPopTables` the count line becomes:

```js
    const validated = [...state.popcorn.values()].reduce((n, d) => n + (d.items || []).filter((i) => i.quoteId).length, 0);
    const heldBack = [...state.popcorn.values()].reduce((n, d) => n + (d.held_back || 0), 0);
    const settled = [...state.popcorn.values()].filter((d) => popcornSettled(d)).length;
    const files = state.popcorn.size;
    const parts = [`${total} popcorn${total === 1 ? "" : "s"}`, `${validated} validated`];
    if (heldBack) parts.push(`${heldBack} held back`);
    if (settled < files) parts.push(`reading ${files - settled} of ${files}`);
    if (hidden) parts.push(`${hidden} hidden`);
    if (count) count.textContent = !total ? "" : q ? `${shown} of ${total}` : parts.join(" · ");
```

- [ ] **Step 5: SOURCE.md**: replace the quotation-marks patch line with the new rule; add lines for `?present=1`, the countdown and beacon, the tally, one phrase size, and note that the message bridge and `postHostSetting` are gone.

- [ ] **Step 6: Prove in the Browser pane**

Open `http://localhost:5173/api/v2/bff/popcorn/3/view/?present=1`: `document.body.classList.contains("presenting")` true, no `.tab-hide`, legend labels neutral when the setting says so. Trigger a rerun (Task 4's route) and screenshot the count at 2 or 1, then the first phrase. Read the tail count text. `test_popcorn_view.py` green.

- [ ] **Step 7: Commit** `popcorn: the deck as presenter view; the count to the first popcorn; quotation marks for verbatim only`

---

### Task 6: Frontend hooks

**Files:**
- Modify: `frontend/src/components/popcorn/hooks/index.ts`

**Interfaces:**
- Produces: `PopcornLoop.mode: "manual" | "live"`; `PopcornSettings.public_labels: "names" | "neutral"`; `PopcornCounts.validated`, `held_back`; `PopcornReadiness = {conversations: number; words: number}`; `useProjectPopcorn` returns `{popcorn, readiness}`; `popcornPresenterUrl(popcornId, versionId?)`; `useRerunPopcornMutation`, `usePopcornLiveMutation` (`hours`), `usePopcornStopLiveMutation`; removed: `usePopcornGoLiveMutation`, `usePopcornLifecycleMutation`, `usePopcornLoopSettingsMutation`.

- [ ] **Step 1: Types and URL**

```ts
export type PopcornLoop = {
	id?: string;
	status: string;
	mode: "manual" | "live";
	expires_at?: string | null;
	cadence_minutes?: number | null;
	next_read_at?: string | null;
	last_run_started_at?: string | null;
	last_run_status?: "ok" | "no_op" | "error" | string | null;
	last_run_detail?: string | null;
};
export type PopcornReadiness = { conversations: number; words: number };
export type PopcornProject = { popcorn: PopcornDetail | null; readiness?: PopcornReadiness };
// The deck full screen in its own tab: the room's view, no host affordance.
export const popcornPresenterUrl = (popcornId: string, versionId?: string) =>
	`${API_BASE_URL}/v2/bff/popcorn/${encodeURIComponent(popcornId)}/view/?present=1${versionId ? `&version=${encodeURIComponent(versionId)}` : ""}`;
```

`useProjectPopcorn` returns the whole `PopcornProject` (`queryFn` returns `response`); `refetchInterval` keys off `data?.popcorn?.loop?.mode === "live"`. Update `LibraryRoute.tsx` and the route to read `.popcorn`.

- [ ] **Step 2: Mutations**

```ts
export const useRerunPopcornMutation = (projectId: string, popcornId: string) => {
	const invalidate = useInvalidatePopcorn(projectId);
	return useMutation({
		mutationFn: () => bff.post<{ tick: string }>(`/popcorn/${encodeURIComponent(popcornId)}/rerun`),
		onError: (error: Error & { status?: number }) => {
			if (error.status === 429) { toast.info(t`Just read. Give it a moment.`); return; }
			toast.error(t`Could not rerun popcorn`);
		},
		onSuccess: () => { toast.success(t`Reading everything again`); invalidate(); },
	});
};
export const usePopcornLiveMutation = (projectId: string, popcornId: string) => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (hours: 1 | 8 | 24) => bff.post<PopcornDetail>(`/popcorn/${encodeURIComponent(popcornId)}/live`, { hours }),
		onError: () => toast.error(t`Could not go live`),
		onSuccess: (detail) => { queryClient.setQueryData(projectKey(projectId), (old: PopcornProject | undefined) => ({ ...(old ?? {}), popcorn: detail })); },
	});
};
export const usePopcornStopLiveMutation = (projectId: string, popcornId: string) => { /* same shape, POST .../live/stop, error t`Could not stop live` */ };
```

Every `setQueryData(projectKey(projectId), detail)` in the file becomes the `{ ...old, popcorn: detail }` form. `useCreatePopcornMutation` payload loses `expires_at` and `cadence_minutes`. Delete the three removed hooks.

- [ ] **Step 3: `pnpm exec tsc --noEmit`** will fail in the route until Task 7; commit together with Task 7.

---

### Task 7: The dashboard page

**Files:**
- Create: `frontend/src/components/popcorn/PopcornStart.tsx`, `PopcornActions.tsx`, `PopcornScreenSettings.tsx`, `PopcornVoiceSection.tsx` (move `VoiceFields`, `EMPTY_VOICE`, `FIELD_SIZE` here), `PopcornShare.tsx` (move `SharePopover`'s content, render inline), `PopcornHistory.tsx`, `PopcornStatus.tsx`, `PopcornIntroModal.tsx` (move `IntroModal`)
- Modify: `frontend/src/routes/project/popcorn/PopcornRoute.tsx` (compose), `frontend/src/routes/project/library/LibraryRoute.tsx` (status text)

**Interfaces:**
- Consumes Task 6's hooks. Every component takes `{ projectId, popcorn }` except `PopcornStart` (`{ projectId, projectName, readiness }`).

- [ ] **Step 1: PopcornStart**

Readiness line under the intro paragraph:

```tsx
const minutes = Math.max(1, Math.round((readiness?.words ?? 0) / 150));
const ready = (readiness?.conversations ?? 0) > 0;
<Text size="sm" {...testId("popcorn-readiness")}>
	{ready
		? t`${readiness.conversations} conversations with a transcript, about ${minutes} minutes of talk. Ready.`
		: t`No transcripts yet. You can run popcorn now; the screen fills as conversations land.`}
</Text>
```

Fields: title, `VoiceFields`; the button says `Run` (`testId("popcorn-run-button")`); `create.mutate({ title, voice })`. No duration select.

- [ ] **Step 2: PopcornActions**

```tsx
export function PopcornActions({ projectId, popcorn }: { projectId: string; popcorn: PopcornDetail }) {
	const refresh = useRefreshPopcornMutation(projectId, popcorn.id);
	const rerun = useRerunPopcornMutation(projectId, popcorn.id);
	const live = usePopcornLiveMutation(projectId, popcorn.id);
	const stopLive = usePopcornStopLiveMutation(projectId, popcorn.id);
	const invalidate = useInvalidatePopcorn(projectId);
	const [rerunOpened, rerunModal] = useDisclosure(false);
	const isLive = popcorn.loop?.mode === "live";
	return (
		<Group gap="xs" wrap="wrap" {...testId("popcorn-actions")}>
			<Button size="md" component="a" href={popcornPresenterUrl(popcorn.id)} target="_blank" rel="noopener noreferrer"
				leftSection={<ProjectorScreenIcon size={18} />} {...testId("popcorn-open-presenter")}>
				<Trans>Open presenter view</Trans>
			</Button>
			<Button variant="outline" leftSection={<ArrowsClockwiseIcon size={16} />} loading={refresh.isPending}
				onClick={() => refresh.mutate()} {...testId("popcorn-refresh-button")}>
				<Trans>Refresh</Trans>
			</Button>
			<Button variant="outline" leftSection={<ArrowCounterClockwiseIcon size={16} />} onClick={rerunModal.open} {...testId("popcorn-rerun-button")}>
				<Trans>Rerun</Trans>
			</Button>
			{isLive ? (
				<LiveChip popcorn={popcorn} onStale={invalidate} onStop={() => stopLive.mutate()} pending={stopLive.isPending} />
			) : (
				<Menu position="bottom-start" shadow="md">
					<Menu.Target>
						<Button variant="gradient" gradient={{ from: "primary", to: "red" }} leftSection={<BroadcastIcon size={16} />}
							loading={live.isPending} {...testId("popcorn-live-button")}>
							<Trans>Live</Trans>
						</Button>
					</Menu.Target>
					<Menu.Dropdown>
						<Menu.Label><Trans>Read every 2 minutes for</Trans></Menu.Label>
						<Menu.Item onClick={() => live.mutate(1)} {...testId("popcorn-live-1h")}><Trans>1 hour</Trans></Menu.Item>
						<Menu.Item onClick={() => live.mutate(8)}><Trans>8 hours</Trans></Menu.Item>
						<Menu.Item onClick={() => live.mutate(24)}><Trans>24 hours</Trans></Menu.Item>
					</Menu.Dropdown>
				</Menu>
			)}
			<Modal opened={rerunOpened} onClose={rerunModal.close} title={t`Rerun popcorn?`} {...testId("popcorn-rerun-modal")}>
				<Stack gap="md">
					<Text><Trans>This replaces every popcorn, tension and stakeholder on the screen and reads all conversations again. Earlier runs are saved in the history.</Trans></Text>
					<Group justify="flex-end" gap="xs">
						<Button variant="subtle" onClick={rerunModal.close}><Trans>Cancel</Trans></Button>
						<Button color="red" loading={rerun.isPending} onClick={() => rerun.mutate(undefined, { onSuccess: rerunModal.close })} {...testId("popcorn-rerun-confirm")}>
							<Trans>Rerun</Trans>
						</Button>
					</Group>
				</Stack>
			</Modal>
		</Group>
	);
}
```

`LiveChip` moves here from the route: it keeps the countdown logic, drops the read-now click, and renders as a pulsing chip followed by a `Stop live` subtle button (`testId("popcorn-stop-live")`). Its label while reading stays `Reading n of m conversations…`; when overdue by a minute it says `Delayed`, and Refresh is the way to read.

- [ ] **Step 3: PopcornScreenSettings**

A `Paper` titled `Screen` with five `Switch`es bound to `usePopcornSettingsMutation`: tensions tab (`settings.tabs.tensions`), stakeholders tab, QR code (`show_qr`), names on the legend (`public_labels === "names"`, description `Off numbers the conversations. On shows the name typed on the phone.`), the dembrane mark (`show_branding`, tier gated exactly as the old modal did, with the Changemaker badge when not allowed). Each switch mutates on change and is disabled while pending.

- [ ] **Step 4: PopcornVoiceSection, PopcornShare, PopcornHistory, PopcornStatus**

- Voice: `Paper` titled `Voice`; the title field and `VoiceFields`; a Save button that mutates `{ title, voice }`; the line `Changing the voice re-reads every conversation.` when the voice changed.
- Share: the old popover's `Stack` rendered inline in a `Paper` titled `Share`.
- History: `Paper` titled `Earlier runs`; `usePopcornVersions`; each row a link `popcornPresenterUrl(popcorn.id, version.id)` with `target="_blank"`, label `HH:mm` and the detail's first clause; `A rerun keeps these.` as the description; hidden when empty.
- Status: `Paper` titled `Status`; lines: `Last read HH:mm · <last_run_detail first 160 chars>`; `${counts.validated} of ${counts.phrases} validated` plus `· ${counts.held_back} held back` when any; while `counts.reading > 0`: `Reading ${counts.reading} of ${counts.conversations} conversations`. Add a `progress` bar (`Progress value={validated/phrases*100}`) while a read is in flight.

- [ ] **Step 5: Compose the route**

`PopcornSession` becomes: header (`Title`, Beta badge, `statusLine`), `PopcornActions`, then a two-column `SimpleGrid cols={{ base: 1, md: 2 }}` of Status, Screen, Voice, Share, History. Delete the iframe, `useFullscreen`, `frameRef`, the `presenting` postMessage effect, the host settings message listener, `SessionModal`, `EarlierMenu`, `SharePopover`, and the preview hint. Keep the SSE effect (it invalidates the query). `statusLine`:

```ts
const parts = [t`${counts.conversations} conversations`, t`${counts.phrases} phrases`, t`${counts.validated ?? 0} validated`];
if (counts.held_back) parts.push(t`${counts.held_back} held back`);
if (loop?.mode === "live" && expiryLabel) parts.push(t`live until ${expiryLabel}, reads every ${every} min`);
```

`LibraryRoute` status: `Live, N phrases so far` when `mode === "live"`, else `N phrases` (or `Not started`).

- [ ] **Step 6: Checks**

`pnpm check` (fix with `pnpm lint:fix` and biome format), `pnpm exec tsc --noEmit`, `pnpm messages:extract`. Commit the catalogs with the code.

- [ ] **Step 7: Prove in the Browser pane** on `http://localhost:5173`: a project without a session shows readiness and Run; Run creates and the status line moves; Refresh toasts; Rerun opens the modal, confirm wipes and the deck counts down in the presenter tab; Live menu 1 hour → chip with countdown and Stop live; every Screen switch changes the presenter view on its next poll; Share switch and link; History rows open the presenter view of a saved run. Screenshot the page.

- [ ] **Step 8: Commit** `popcorn: the dashboard is the control surface; the deck opens as the presenter view`

---

### Task 8: Flow page, docs, the whole suite, push

**Files:**
- Modify: `server/dembrane/popcorn/static/flow.html` (one tick: modes; fast pass: no weight; second pass: held back; bundle table: no weight, `held_back`), `docs/popcorn/2026-09-05-session-lifecycle-design.md` (mark decisions that changed during implementation, if any)

- [ ] **Step 1:** Edit the flow page's five sections to match; `test_popcorn_view.py` green.
- [ ] **Step 2:** The whole popcorn suite, ruff, mypy, biome, tsc: all green. Restart the stack, one manual tick on a project, one live hour started and stopped.
- [ ] **Step 3:** Commit `popcorn: the flow page follows the lifecycle` and push `popcorn-lab-sync`.
- [ ] **Step 4:** Update the vault's `Jorim/0_Projects/Popcorn/Popcorn — Open items.md` (the PR is ready for Jorim's review; the design and plan paths) and commit the vault.
