"""Synthetic Bet 3 translation benchmark and release-metric harness.

This does not call a model and is not provider performance evidence. It makes
the shipped batching, cache, timing and next-slot rules measurable before a
paid room benchmark supplies real latency and cost values.

    uv run python tests/analysis/bench_popcorn_translation.py
    uv run python tests/analysis/bench_popcorn_translation.py --latency-ms 2400 --json out.json
"""

from __future__ import annotations

import json
import math
import argparse
import statistics
from typing import Any
from pathlib import Path

READ_BASE_MS = 3000
READ_PER_WORD_MS = 500
LANGUAGE_CAP_MS = 24000
APPEARANCE_CAP_MS = 24000
TRANSITION_MS = 200
BATCH = 40


def reading_ms(text: str) -> int:
    words = len(text.split())
    return min(LANGUAGE_CAP_MS, READ_BASE_MS + READ_PER_WORD_MS * words)


def _percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, math.ceil(len(ordered) * fraction) - 1)]


def _scenario(
    name: str,
    phrases: list[str],
    *,
    latency_ms: int,
    warm: bool = False,
    fail: set[str] | None = None,
    cache: set[str] | None = None,
) -> dict[str, Any]:
    cache = cache if cache is not None else set()
    fail = fail or set()
    extraction = [index * 350 for index in range(len(phrases))]
    missing = [text for text in phrases if text not in cache]
    calls = 0 if warm else math.ceil(len(missing) / BATCH)
    queue_growth = 0 if warm else len(missing)
    delays: list[float] = []
    same_appearance = 0
    completed = 0
    for text in phrases:
        if text in fail:
            continue
        delay = 0 if warm or text in cache else latency_ms + 20 * min(BATCH, len(missing))
        delays.append(float(delay))
        cache.add(text)
        completed += 1
        translated_read = reading_ms(f"Translated {text}")
        if delay <= reading_ms(text) and reading_ms(text) + TRANSITION_MS + translated_read <= APPEARANCE_CAP_MS:
            same_appearance += 1
    return {
        "scenario": name,
        "synthetic": True,
        "phrases": len(phrases),
        "extractionToFirstOriginalMs": extraction[0] if extraction else None,
        "extractionToFirstTranslationMs": (extraction[0] + delays[0]) if delays else None,
        "translationDelayP50Ms": statistics.median(delays) if delays else None,
        "translationDelayP95Ms": _percentile(delays, 0.95) if delays else None,
        "translatedSameAppearancePercent": round(100 * same_appearance / len(phrases), 1) if phrases else 0,
        "maxQueueDepth": queue_growth,
        "modelCalls": calls,
        "retryableFailures": len(fail),
        "completed": completed,
    }


def run_synthetic(latency_ms: int = 1200, cost_per_call: float = 0.0) -> dict[str, Any]:
    nl = ["Meer groen maakt de straat koeler", "De bus moet ook laat blijven rijden"]
    en = ["The library should stay open later", "Young people need somewhere to meet"]
    shared_cache: set[str] = set()
    cold_mixed = _scenario("mixed-cold", nl + en, latency_ms=latency_ms, cache=shared_cache)
    warm_mixed = _scenario("mixed-warm", nl + en, latency_ms=latency_ms, warm=True, cache=shared_cache)
    arriving = _scenario("arriving", ["Nieuwe stemmen horen erbij"], latency_ms=latency_ms, cache=shared_cache)
    revised = _scenario("revised-wording", ["Nieuwe stemmen horen er altijd bij"], latency_ms=latency_ms, cache=shared_cache)
    failed_text = "Dit antwoord faalt tijdelijk"
    failure = _scenario("retryable-failure", [failed_text], latency_ms=latency_ms, fail={failed_text}, cache=shared_cache)
    first = _scenario("presentation-a", nl, latency_ms=latency_ms, cache=shared_cache)
    second = _scenario("presentation-b-shared-cache", nl, latency_ms=latency_ms, warm=True, cache=shared_cache)
    scenarios = [
        _scenario("dutch-only-cold", nl, latency_ms=latency_ms),
        _scenario("english-only-cold", en, latency_ms=latency_ms),
        cold_mixed,
        warm_mixed,
        arriving,
        revised,
        failure,
        first,
        second,
    ]
    total_calls = sum(int(row["modelCalls"]) for row in scenarios)
    return {
        "validation": "synthetic harness; no provider was called",
        "timingPolicy": "3000ms + 500ms per word per visible language; 24000ms appearance cap",
        "translationLatencyInputMs": latency_ms,
        "scenarios": scenarios,
        "modelCallsTotal": total_calls,
        "estimatedModelCost": round(total_calls * cost_per_call, 6),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--latency-ms", type=int, default=1200)
    parser.add_argument("--cost-per-call", type=float, default=0.0)
    parser.add_argument("--json", type=Path)
    options = parser.parse_args()
    report = run_synthetic(options.latency_ms, options.cost_per_call)
    output = json.dumps(report, indent=2, ensure_ascii=False)
    if options.json:
        options.json.write_text(output + "\n", encoding="utf-8")
    print(output)


if __name__ == "__main__":
    main()
