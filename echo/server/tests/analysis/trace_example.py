"""The traceable example: one saved tension, read back from the database alone.

Manual only. Pytest never collects this file (its name does not start with
`test_`).

`--seed` writes a scratch project through the real SQL store with scripted
models: arguments, deduplicated arguments, tensions, one recorded fact-check
assessment, and a map snapshot. It prints the ids and keeps the project.

`--read <snapshot id>` is the part that matters. In a new process, with a new
store, it resolves from the database only: the snapshot, one tension revision,
the deduplicated arguments holding each pole, the raw arguments those
consolidate, every source reference, the recipe and check versions of the runs
that produced them, and the assessment records. It calls no model and reads no
transcript, so it still answers after the API and the workers have restarted.

Inside the dev container:

    cd /workspaces/echo/server
    uv run python tests/analysis/trace_example.py --seed
    uv run python tests/analysis/trace_example.py --read <snapshot id>
    uv run python tests/analysis/trace_example.py --drop <project id>
"""

from __future__ import annotations

import sys
import json
import uuid
import asyncio
import argparse
from typing import Any
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parents[2]

CHAIN = ("arguments", "deduplicated_arguments", "tensions")


def _dsn() -> str:
    from dembrane.analysis.db import database_dsn

    return database_dsn()


async def seed() -> dict[str, Any]:
    from dataclasses import replace as _replace

    import psycopg

    from tests.analysis.helpers import Recorder
    from dembrane.analysis.store import SqlAnalysisStore
    from dembrane.map.fact_check import record_assessment
    from dembrane.analysis.outbox import dispatch_events
    from dembrane.analysis.executor import RunRequest, run_worker, request_run
    from dembrane.analysis.map_view import SqlMapViewReads, claim_of, advance_map_view
    from dembrane.analysis.contracts import RevisionStatus
    from tests.analysis.producer_fakes import BRIDGE, MERGED_RECORD, ProducerWorld, merge_all
    from dembrane.analysis.recipes.services import SERVICES_KEY, ProducerServices

    world = ProducerWorld.recording_debate()
    world.verifier = merge_all(MERGED_RECORD)
    base: ProducerServices = world.services()

    async def transcripts(_project_id: str) -> list[Any]:
        return list(world.transcripts)

    services = _replace(base, transcripts=transcripts)
    rec = Recorder()
    deps = rec.deps()
    deps.services = {SERVICES_KEY: services}

    dsn = _dsn()
    project = str(uuid.uuid4())
    with psycopg.connect(dsn, autocommit=True) as connection:
        # The live table asks for more than an id; the tests' stand-in does not.
        connection.execute(
            "INSERT INTO project (id, is_conversation_allowed) VALUES (%s, false)", (project,)
        )
    store = SqlAnalysisStore(dsn=dsn)

    outcome = await request_run(
        RunRequest(
            project,
            "tensions",
            "project",
            parameters={"input_set": "deduplicated_arguments"},
            idempotency_key="trace-chain",
        ),
        store=store,
        deps=deps,
    )
    arguments, dedup = outcome.dependencies
    for run_id in (arguments.id, dedup.id, outcome.run.id):
        assert await run_worker(run_id, store=store, deps=deps) == "ready"
        await dispatch_events(store=store, deps=rec.outbox_deps())

    # One recorded fact-check of the claim, through the assessment recipe. The
    # verdict is supplied here; nothing calls a model.
    revisions = await store.get_revisions(
        project, [o["revisionId"] for o in (await store.get_run(arguments.id)).output_manifest["objects"]]
    )
    claim = next(r for r in revisions.values() if r.payload.get("statement") == BRIDGE)
    assert claim.status == RevisionStatus.PUBLISHED
    found = claim_of(claim)
    assert found is not None
    statement, _quotes, claim_key = found
    run, _event = await record_assessment(
        project,
        claim.id,
        {
            "id": str(uuid.uuid4()),
            "attempt": 1,
            "statement": statement,
            "claim_key": claim_key,
            "verdict": "true",
            "justification": "Recorded by the traceable example, with no model call.",
            "sources": [{"url": "https://example.org", "title": "Example"}],
            "model": "traceable-example",
            "prompt_version": "none",
            "requested_by": None,
        },
        store=store,
        deps=deps,
    )
    await dispatch_events(store=store, deps=rec.outbox_deps())

    snapshot = await advance_map_view(project, store=store, reads=SqlMapViewReads(dsn))
    assert snapshot is not None
    return {
        "projectId": project,
        "snapshotId": snapshot.id,
        "claimRevisionId": claim.id,
        "assessmentRunId": run.id,
        "runs": {recipe: rid for recipe, rid in zip(CHAIN, (arguments.id, dedup.id, outcome.run.id), strict=True)},
    }


async def read(snapshot_id: str) -> dict[str, Any]:
    """Everything the audit must answer, from saved rows only."""
    from dembrane.analysis.store import SqlAnalysisStore
    from dembrane.analysis.map_view import pinned_lineage
    from dembrane.analysis.snapshots import read_snapshot

    store = SqlAnalysisStore(dsn=_dsn())
    snapshot = await store.get_snapshot(snapshot_id)
    if snapshot is None:
        raise SystemExit(f"no snapshot {snapshot_id}")
    contents = await read_snapshot(snapshot, store=store)

    tension = next(
        (r for r in contents.revisions.values() if r.type == "tension"), None
    )
    if tension is None:
        raise SystemExit("this snapshot displays no tension")

    # The exact relations this snapshot pins, and the revisions they name.
    supports = [
        r
        for r in contents.relations.values()
        if r.type in ("supports_pole_a", "supports_pole_b") and r.to_revision_id == tension.id
    ]
    poles: dict[str, list[dict[str, Any]]] = {"supports_pole_a": [], "supports_pole_b": []}
    for relation in supports:
        holder = (await store.get_revisions(snapshot.project_id, [relation.from_revision_id])).get(
            relation.from_revision_id
        )
        if holder is None:
            poles[relation.type].append({"revisionId": relation.from_revision_id, "missing": True})
            continue
        members = []
        for member_id in holder.provenance.input_revision_ids:
            member = (await store.get_revisions(snapshot.project_id, [member_id])).get(member_id)
            members.append(
                {
                    "revisionId": member_id,
                    "missing": member is None,
                    "statement": member.payload.get("statement") if member else None,
                    "recipe": f"{member.provenance.recipe_id}@{member.provenance.recipe_version}" if member else None,
                    "sources": [ref.as_json() for ref in member.provenance.source_refs] if member else [],
                }
            )
        poles[relation.type].append(
            {
                "revisionId": holder.id,
                "objectId": holder.object_id,
                "statement": holder.payload.get("statement"),
                "recipe": f"{holder.provenance.recipe_id}@{holder.provenance.recipe_version}",
                "consolidation": holder.payload.get("consolidation", {}).get("verification"),
                "sources": [ref.as_json() for ref in holder.provenance.source_refs],
                "members": members,
            }
        )

    runs: dict[str, Any] = {}
    for entry in snapshot.manifest.get("producers") or []:
        if not entry.get("runId"):
            continue
        run = await store.get_run(str(entry["runId"]))
        if run is None:
            continue
        runs[str(entry["recipeId"])] = {
            "runId": run.id,
            "recipeVersion": run.recipe_version,
            "steps": [
                {"key": s["key"], "version": s["version"], "kind": s["kind"], "checkVersion": s.get("checkVersion")}
                for s in (run.definition or {}).get("steps") or []
            ],
            "checks": [
                {"check": c.get("check"), "status": c.get("status"), "version": c.get("version")} for c in run.checks
            ],
        }

    assessments = [
        {
            "targetRevisionId": target,
            "revisionId": assessment.id,
            "verdict": assessment.payload.get("verdict"),
            "statement": assessment.payload.get("statement"),
            "recipe": f"{assessment.provenance.recipe_id}@{assessment.provenance.recipe_version}",
        }
        for target, assessment in contents.assessments.items()
    ]

    lineage = await pinned_lineage(snapshot, tension.id, store=store)
    return {
        "snapshotId": snapshot.id,
        "projectId": snapshot.project_id,
        "createdAt": snapshot.created_at.isoformat() if snapshot.created_at else None,
        "tension": {
            "revisionId": tension.id,
            "objectId": tension.object_id,
            "poleA": tension.payload.get("poleA"),
            "poleB": tension.payload.get("poleB"),
            "knot": tension.payload.get("knot"),
            "toResolve": tension.payload.get("toResolve"),
            "recipe": f"{tension.provenance.recipe_id}@{tension.provenance.recipe_version}",
        },
        "poles": poles,
        "runs": runs,
        "assessments": assessments,
        "lineageRevisions": len((lineage or {}).get("revisions") or []),
        "lineageMissing": (lineage or {}).get("missing") or [],
        "snapshotMissing": list(contents.missing),
    }


def _print_trace(trace: dict[str, Any]) -> None:
    print(f"\nsnapshot {trace['snapshotId']}  (project {trace['projectId']}, {trace['createdAt']})")
    tension = trace["tension"]
    print(f"\ntension {tension['revisionId']}  [{tension['recipe']}]")
    print(f"  object    {tension['objectId']}")
    print(f"  poles     {tension['poleA']}  /  {tension['poleB']}")
    print(f"  knot      {tension['knot']}")
    print(f"  resolve   {tension['toResolve']}")
    for pole, holders in trace["poles"].items():
        print(f"\n  {pole}:")
        for holder in holders:
            print(f"    deduplicated {holder['revisionId']}  [{holder.get('recipe')}]")
            print(f"      statement    {holder.get('statement')}")
            print(f"      verification {holder.get('consolidation')}")
            for source in holder.get("sources") or []:
                print(f"      source       {source.get('conversationId')}  {source.get('quote')!r}")
            for member in holder.get("members") or []:
                print(f"      from argument {member['revisionId']}  [{member.get('recipe')}]")
                print(f"        statement   {member.get('statement')}")
                for source in member.get("sources") or []:
                    print(f"        source      {source.get('conversationId')}  {source.get('quote')!r}")
    print("\nruns and their versions:")
    for recipe, run in trace["runs"].items():
        checks = ", ".join(f"{c['check']}={c['status']}" for c in run["checks"])
        print(f"  {recipe}@{run['recipeVersion']}  run {run['runId']}")
        print(f"    steps  {', '.join(s['key'] + '@' + s['version'] for s in run['steps'])}")
        print(f"    checks {checks}")
    print("\nassessments:")
    for assessment in trace["assessments"] or []:
        print(f"  {assessment['revisionId']}  {assessment['verdict']}  [{assessment['recipe']}]")
        print(f"    of revision {assessment['targetRevisionId']}: {assessment['statement']}")
    if not trace["assessments"]:
        print("  (none pinned by this snapshot)")
    print(f"\nlineage revisions resolved: {trace['lineageRevisions']}")
    print(f"lineage missing: {trace['lineageMissing']}")
    print(f"snapshot missing: {trace['snapshotMissing']}")


def drop(project_id: str) -> None:
    import psycopg

    with psycopg.connect(_dsn(), autocommit=True) as connection:
        connection.execute("DELETE FROM project WHERE id = %s", (project_id,))
    print(f"dropped {project_id}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--seed", action="store_true")
    parser.add_argument("--read", metavar="SNAPSHOT_ID")
    parser.add_argument("--drop", metavar="PROJECT_ID")
    parser.add_argument("--json", type=Path)
    options = parser.parse_args(argv)

    sys.path.insert(0, str(SERVER_DIR))
    if options.drop:
        drop(options.drop)
        return 0
    if options.seed:
        ids = asyncio.run(seed())
        print(json.dumps(ids, indent=2))
        if options.json:
            options.json.write_text(json.dumps(ids, indent=2), encoding="utf-8")
        return 0
    if options.read:
        trace = asyncio.run(read(options.read))
        _print_trace(trace)
        if options.json:
            options.json.write_text(json.dumps(trace, indent=2), encoding="utf-8")
        return 0
    parser.error("one of --seed, --read or --drop")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
