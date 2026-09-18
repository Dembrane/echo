from tests.analysis.bench_popcorn_translation import reading_ms, run_synthetic


def test_synthetic_harness_covers_cache_revision_failure_and_two_presentations() -> None:
    report = run_synthetic(latency_ms=1000)
    rows = {row["scenario"]: row for row in report["scenarios"]}
    assert report["validation"] == "synthetic harness; no provider was called"
    assert rows["mixed-cold"]["modelCalls"] > 0
    assert rows["mixed-warm"]["modelCalls"] == 0
    assert rows["revised-wording"]["modelCalls"] == 1
    assert rows["retryable-failure"]["retryableFailures"] == 1
    assert rows["presentation-b-shared-cache"]["modelCalls"] == 0
    assert all(row["extractionToFirstOriginalMs"] == 0 for row in rows.values())


def test_reading_formula_handles_different_original_and_translation_lengths() -> None:
    assert reading_ms("three short words") == 4500
    assert reading_ms("one two three four five six seven") == 6500
    assert reading_ms("word " * 100) == 24000
