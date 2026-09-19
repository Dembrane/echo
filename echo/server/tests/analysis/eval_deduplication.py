"""Run the deduplication regression corpus against the real verifier.

Manual only. Pytest never collects this file (its name does not start with
`test_`) and nothing in CI runs it: it calls the model and costs tokens.
Inside the dev container:

    cd /workspaces/echo/server
    uv run python tests/analysis/eval_deduplication.py
    uv run python tests/analysis/eval_deduplication.py --case similarity-chain
    uv run python tests/analysis/eval_deduplication.py --real-embeddings --json out.json

Candidates come from each case's synthetic embeddings, so by default this
evaluates verification alone. `--real-embeddings` embeds every statement with
the configured deployment and uses that model's calibrated threshold, which
evaluates candidate discovery as well.

A `should_merge` entry is either a list of ids that belong in one item, or
`{"any_of": [grouping, ...], "why": "..."}` where each grouping is a list of
id sets and every grouping covers the same ids. A result satisfies an entry
when every set of at least one grouping lies within one output item each.
`must_not_merge` pairs have no alternatives.

False merges (a must-not-merge pair in one output item) and missed duplicates
(an entry no acceptable grouping satisfies, reported against the grouping it
comes closest to) are reported separately. False merges are the more serious
failure and make the exit status 1. Merges the corpus does not mention are
listed for review, not scored.
"""

from __future__ import annotations

import sys
import json
import asyncio
import argparse
from typing import Any
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parents[2]
CORPUS_DIR = Path(__file__).resolve().parent / "corpus" / "dedup"


def load_cases(names: list[str]) -> list[dict[str, Any]]:
    cases = [json.loads(p.read_text(encoding="utf-8")) for p in sorted(CORPUS_DIR.glob("*.json"))]
    if names:
        unknown = set(names) - {case["id"] for case in cases}
        if unknown:
            raise SystemExit(f"unknown case(s): {', '.join(sorted(unknown))}")
        cases = [case for case in cases if case["id"] in names]
    return cases


def alternatives(entry: list[str] | dict[str, Any]) -> list[list[list[str]]]:
    """Every acceptable grouping of one should-merge entry; a plain list of
    ids is the single grouping that keeps them all together."""
    if isinstance(entry, dict):
        return [[list(members) for members in grouping] for grouping in entry["any_of"]]
    return [[list(entry)]]


def score(case: dict[str, Any], groups: list[list[str]]) -> dict[str, Any]:
    """`groups` is every output item's member ids."""
    home = {member: index for index, group in enumerate(groups) for member in group}
    false_merges = [
        entry
        for entry in case["must_not_merge"]
        if home[entry["pair"][0]] == home[entry["pair"][1]]
    ]
    missed: list[dict[str, Any]] = []
    for entry in case["should_merge"]:
        options = alternatives(entry)
        splits = [
            [members for members in grouping if len({home[m] for m in members}) > 1]
            for grouping in options
        ]
        if any(not split for split in splits):
            continue
        apart = [
            sum(
                1
                for members in grouping
                for i, a in enumerate(members)
                for b in members[i + 1 :]
                if home[a] != home[b]
            )
            for grouping in options
        ]
        closest = min(range(len(options)), key=lambda index: (apart[index], index))
        missed.extend(
            {
                "expected": members,
                "split_into": sorted({tuple(groups[home[m]]) for m in members}),
                "grouping": closest,
                "groupings": len(options),
            }
            for members in splits[closest]
        )
    acceptable = [
        set(members)
        for entry in case["should_merge"]
        for grouping in alternatives(entry)
        for members in grouping
    ]
    unlisted = [
        group
        for group in groups
        if len(group) > 1 and not any(set(group) <= expected for expected in acceptable)
    ]
    return {"false_merges": false_merges, "missed_duplicates": missed, "unlisted_merges": unlisted}


async def run_case(case: dict[str, Any], real_embeddings: bool) -> dict[str, Any]:
    from dembrane.analysis.recipes import deduplication as dd

    model = case["embedding_model"]
    config_key = "corpus-synthetic"
    vectors = [value["embedding"] for value in case["inputs"]]
    if real_embeddings:
        from dembrane.embedding import embed_text, probe_embedding_identity

        identity = await asyncio.to_thread(probe_embedding_identity)
        model, config_key = identity.model, identity.key
        vectors = [
            await asyncio.to_thread(embed_text, dd.normalize_text(value["statement"]))
            for value in case["inputs"]
        ]
    arguments = [
        dd.SourceArgument(
            revision_id=value["id"],
            object_id="obj-" + value["id"],
            statement=value["statement"],
            epistemic_kind=value["epistemic_kind"],
            valence=value["valence"],
            evidence=[dd.Evidence(**item) for item in value["evidence"]],
            embedding=vector,
            embedding_config_key=config_key,
        )
        for value, vector in zip(case["inputs"], vectors, strict=True)
    ]
    result = await dd.deduplicate(
        arguments, dd.DeduplicationParams(embedding_model=model), dd.verify_with_model
    )
    groups = [list(item.member_revision_ids) for item in result.items]
    return {
        "case": case["id"],
        "embeddings": "real" if real_embeddings else "synthetic",
        **score(case, groups),
        "groups": groups,
        "checks": [
            {
                "group": check.revision_ids,
                "status": check.status,
                "error": check.error,
                "sub_groups": [
                    {
                        "members": sub.revision_ids,
                        "verdict": sub.verdict,
                        "outcome": sub.outcome,
                        "statement": sub.proposed_statement,
                        "rationale": sub.rationale,
                    }
                    for sub in check.sub_groups
                ],
            }
            for check in result.checks
        ],
        "coverage": {
            "threshold": result.coverage.threshold,
            "groups_considered": result.coverage.groups_considered,
            "truncated": result.coverage.truncated,
        },
        "usage": result.usage.__dict__,
    }


async def run(names: list[str], real_embeddings: bool) -> list[dict[str, Any]]:
    return [await run_case(case, real_embeddings) for case in load_cases(names)]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--case", action="append", default=[], help="run only this case id")
    parser.add_argument("--real-embeddings", action="store_true")
    parser.add_argument("--json", type=Path, help="write the full report here")
    options = parser.parse_args(argv)

    sys.path.insert(0, str(SERVER_DIR))
    reports = asyncio.run(run(options.case, options.real_embeddings))

    false_total = sum(len(report["false_merges"]) for report in reports)
    missed_total = sum(len(report["missed_duplicates"]) for report in reports)
    for report in reports:
        print(f"\n{report['case']} ({report['embeddings']} embeddings)")
        print(f"  false merges: {len(report['false_merges'])}")
        for entry in report["false_merges"]:
            print(f"    {entry['pair']} [{entry['guard']}] {entry['why']}")
        print(f"  missed duplicates: {len(report['missed_duplicates'])}")
        for entry in report["missed_duplicates"]:
            which = (
                f" (closest of {entry['groupings']} acceptable groupings)"
                if entry["groupings"] > 1
                else ""
            )
            print(f"    {entry['expected']} split into {entry['split_into']}{which}")
        for group in report["unlisted_merges"]:
            print(f"  unlisted merge, review: {group}")
        print(f"  usage: {report['usage']}")
    print(f"\nTotal false merges: {false_total}. Total missed duplicates: {missed_total}.")
    if options.json:
        options.json.write_text(json.dumps(reports, indent=2, default=list), encoding="utf-8")
    return 1 if false_total else 0


if __name__ == "__main__":
    raise SystemExit(main())
