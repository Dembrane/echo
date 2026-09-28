"""Recipe benchmarks: what each stage of a recipe costs.

Manual only. Pytest never collects this file (its name does not start with
`test_`) and nothing in CI runs it. It changes no default; it measures.

These are the recipe numbers, kept apart from the layout numbers in
`frontend/src/components/map/layout/BENCHMARKS.md`, which measure the browser.
What is recorded here is cache hits, model calls, tokens, wall time and object
counts per stage, for three passes over one project:

1. cold:        nothing cached, every stage computes;
2. refresh:     the same inputs again, so the whole output is reused;
3. incremental: one conversation changed, so only what depends on it recomputes.

Inside the dev container:

    cd /workspaces/echo/server
    uv run python tests/analysis/bench_recipes.py
    uv run python tests/analysis/bench_recipes.py --conversations 40 --duplicates 30
    uv run python tests/analysis/bench_recipes.py --store sql --json bench.json

By default the models are scripted and the store is in memory, so the numbers
are the lifecycle's own cost: step bookkeeping, cache keys, hashing, staging and
publication. `--store sql` runs the same thing against the local Postgres in a
scratch project it creates and drops, which adds the real storage cost. Model
latency is a provider's, not this code's, and is deliberately not simulated.
"""

from __future__ import annotations

import sys
import json
import time
import uuid
import asyncio
import argparse
from typing import Any
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parents[2]

CHAIN = ("arguments", "deduplicated_arguments", "tensions")


def _world(conversations: int, duplicates: int) -> Any:
    """The recording debate, plus generated conversations. Duplicate pairs
    share a vector so deduplication has candidate groups to verify."""
    from tests.analysis.producer_fakes import ProducerWorld, item, spread

    world = ProducerWorld.recording_debate()
    for index in range(conversations):
        conversation = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"bench-conversation-{index}"))
        statements = [
            f"Statement {index}.{position} about the neighbourhood plan." for position in range(4)
        ]
        if index < duplicates:
            # A near-duplicate of the previous conversation's first statement,
            # worded differently and embedded identically.
            twin = f"Statement {index}.0 about the neighbourhood plan."
            statements.append(f"Put differently, statement {index}.0 concerns the neighbourhood plan.")
            world.vectors[statements[-1]] = spread(twin, world.dims)
        text = "\n".join(f"Speaker: {statement}" for statement in statements)
        world.add(conversation, f"Speaker {index}", text, [item(s, s) for s in statements], index % 9)
    return world


def _verifier(request: Any) -> dict[str, Any]:
    """Merge each candidate group into its first member's statement."""
    members = list(request.members)
    return {
        "groups": [
            {
                "members": [m.label for m in members],
                "proposed_statement": members[0].statement,
                "checks": [
                    {"member": m.label, "judgement": "equivalent", "note": "same position"} for m in members
                ],
                "verdict": "equivalent",
                "rationale": "The same position in other words.",
            }
        ]
    }


def _step_rows(steps: list[Any]) -> list[dict[str, Any]]:
    rows = []
    for step in steps:
        usage = dict(step.usage or {})
        rows.append(
            {
                "step": step.step_key,
                "kind": str(step.kind),
                "status": str(step.status),
                "reused": bool(step.reused_step_id) or bool(usage.get("reused")),
                "modelCalls": int(usage.get("modelCalls") or 0),
                "tokens": int(usage.get("total_tokens") or 0),
                "seconds": float(usage.get("seconds") or 0.0),
            }
        )
    return rows


def _collapse(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """One line per declared step, summing its instances (one extraction per
    conversation, one verification per candidate group)."""
    out: dict[str, dict[str, Any]] = {}
    for row in rows:
        key = row["step"].split(":", 1)[0]
        entry = out.setdefault(
            key,
            {"step": key, "kind": row["kind"], "instances": 0, "reused": 0, "modelCalls": 0, "tokens": 0, "seconds": 0.0},
        )
        entry["instances"] += 1
        entry["reused"] += 1 if row["reused"] else 0
        entry["modelCalls"] += row["modelCalls"]
        entry["tokens"] += row["tokens"]
        entry["seconds"] += row["seconds"]
    return list(out.values())


async def _measure(store: Any, project: str, world: Any, recipe: str, key: str, deps: Any) -> dict[str, Any]:
    from dembrane.analysis.executor import RunRequest, run_worker, request_run

    parameters = {"input_set": "deduplicated_arguments"} if recipe == "tensions" else {}
    started = time.monotonic()
    outcome = await request_run(
        RunRequest(project, recipe, "project", parameters=parameters, idempotency_key=key),
        store=store,
        deps=deps,
    )
    reused_whole = outcome.outcome == "reused"
    if not reused_whole:
        assert await run_worker(outcome.run.id, store=store, deps=deps) == "ready", recipe
    elapsed = time.monotonic() - started
    run = await store.get_run(outcome.run.id)
    manifest = run.output_manifest or {}
    metrics = dict(run.metrics or {})
    return {
        "recipe": recipe,
        "outcome": outcome.outcome,
        "wallSeconds": round(elapsed, 4),
        "objects": len(manifest.get("objects") or []),
        "relations": len(manifest.get("relations") or []),
        "modelCalls": int(metrics.get("modelCalls") or 0),
        "cacheHits": int(metrics.get("cacheHits") or 0),
        "stepsResumed": int(metrics.get("stepsResumed") or 0),
        "objectsStaged": int(metrics.get("objectsStaged") or 0),
        "objectsReused": int(metrics.get("objectsReused") or 0),
        "embeddingsComputed": int(metrics.get("embeddingsComputed") or 0),
        "embeddingsReused": int(metrics.get("embeddingsReused") or 0),
        "tokens": int(metrics.get("tokens.total_tokens") or 0),
        "steps": [] if reused_whole else _collapse(_step_rows(await store.get_steps(run.id))),
    }


async def _pass(store: Any, project: str, world: Any, deps: Any, label: str, suffix: str) -> dict[str, Any]:
    from dembrane.analysis.outbox import dispatch_events

    stages = []
    for recipe in CHAIN:
        stages.append(await _measure(store, project, world, recipe, f"{suffix}-{recipe}", deps))
        await dispatch_events(store=store, deps=deps_to_outbox(deps))
    return {"pass": label, "stages": stages}


def deps_to_outbox(deps: Any) -> Any:
    from dembrane.analysis.outbox import OutboxDeps

    return OutboxDeps(executor=deps)


async def run(options: argparse.Namespace) -> dict[str, Any]:
    from dataclasses import replace as _replace

    from tests.analysis.helpers import Recorder
    from tests.analysis.producer_fakes import C3, item
    from dembrane.analysis.recipes.services import SERVICES_KEY, ProducerServices

    world = _world(options.conversations, options.duplicates)
    world.verifier = _verifier
    rec = Recorder()
    store, project, cleanup = await _store(options)

    # The world keys its transcripts by its own project id, and a sql run works
    # in a scratch project, so the services answer for whichever one is in play.
    base: ProducerServices = world.services()

    async def transcripts(_project_id: str) -> list[Any]:
        return list(world.transcripts)

    deps = rec.deps()
    deps.services = {SERVICES_KEY: _replace(base, transcripts=transcripts)}
    try:
        report: dict[str, Any] = {
            "store": options.store,
            "conversations": len(world.transcripts),
            "duplicatePairs": options.duplicates,
            "passes": [],
        }
        report["passes"].append(await _pass(store, project, world, deps, "cold", "c"))
        report["passes"].append(await _pass(store, project, world, deps, "refresh", "r"))

        # One conversation changes, so only what depends on it recomputes.
        world.set_text(
            C3,
            "Cas: Buses are cheaper to run than trams at night.\n"
            "Cas: Keep the recordings, the notes never capture what people meant.\n"
            "Cas: Honestly, just keep the recordings.",
            [
                item("Night buses are cheaper to run than night trams.", "Buses are cheaper to run than trams at night"),
                item(
                    "Recordings should be kept because notes miss what people meant.",
                    "Keep the recordings, the notes never capture what people meant",
                ),
            ],
        )
        report["passes"].append(await _pass(store, project, world, deps, "incremental", "i"))
        report["modelCallsTotal"] = world.model_calls()
        report["embedCallsTotal"] = len(world.embed_calls)
        return report
    finally:
        await cleanup()


async def _store(options: argparse.Namespace) -> tuple[Any, str, Any]:
    """The in-memory store, or the local database with a scratch project that
    is dropped afterwards."""
    if options.store == "memory":
        from tests.analysis.fakes import FakeAnalysisStore
        from tests.analysis.producer_fakes import PROJECT

        async def nothing() -> None:
            return None

        return FakeAnalysisStore(), PROJECT, nothing

    import psycopg

    from dembrane.analysis.db import database_dsn
    from dembrane.analysis.store import SqlAnalysisStore

    dsn = database_dsn()
    project = str(uuid.uuid4())
    with psycopg.connect(dsn, autocommit=True) as connection:
        # The live table asks for more than an id; the tests' stand-in does not.
        connection.execute(
            "INSERT INTO project (id, is_conversation_allowed) VALUES (%s, false)", (project,)
        )

    async def drop() -> None:
        if options.keep:
            print(f"\nscratch project kept: {project}")
            return
        with psycopg.connect(dsn, autocommit=True) as connection:
            connection.execute("DELETE FROM project WHERE id = %s", (project,))

    return SqlAnalysisStore(dsn=dsn), project, drop


def _print(report: dict[str, Any]) -> None:
    print(
        f"\nstore={report['store']}  conversations={report['conversations']}  "
        f"duplicate pairs={report['duplicatePairs']}"
    )
    for entry in report["passes"]:
        print(f"\n=== {entry['pass']} ===")
        for stage in entry["stages"]:
            print(
                f"\n  {stage['recipe']}  ({stage['outcome']})  {stage['wallSeconds']}s  "
                f"objects={stage['objects']} relations={stage['relations']}"
            )
            print(
                f"    model calls={stage['modelCalls']}  tokens={stage['tokens']}  "
                f"cache hits={stage['cacheHits']}  steps resumed={stage['stepsResumed']}"
            )
            print(
                f"    objects staged={stage['objectsStaged']} reused={stage['objectsReused']}  "
                f"embeddings computed={stage['embeddingsComputed']} reused={stage['embeddingsReused']}"
            )
            for step in stage["steps"]:
                print(
                    f"      {step['step']:<12} {step['kind']:<13} x{step['instances']:<4} "
                    f"reused={step['reused']:<4} calls={step['modelCalls']:<4} "
                    f"tokens={step['tokens']:<7} {round(step['seconds'], 4)}s"
                )
    print(f"\ntotal scripted model calls: {report['modelCallsTotal']}")
    print(f"total embed calls: {report['embedCallsTotal']}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--conversations", type=int, default=12, help="generated conversations on top of the debate")
    parser.add_argument("--duplicates", type=int, default=6, help="how many of them carry a near-duplicate")
    parser.add_argument("--store", choices=("memory", "sql"), default="memory")
    parser.add_argument("--keep", action="store_true", help="keep the sql scratch project for inspection")
    parser.add_argument("--json", type=Path, help="write the full report here")
    options = parser.parse_args(argv)

    sys.path.insert(0, str(SERVER_DIR))
    report = asyncio.run(run(options))
    _print(report)
    if options.json:
        options.json.write_text(json.dumps(report, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
