from __future__ import annotations

import pytest

from dembrane.analysis.budgets import (
    DEFAULT_EDGE_LIMIT,
    DEFAULT_NODE_LIMIT,
    Budgets,
    Ceilings,
    BudgetError,
    default_budgets,
    resolve_budgets,
    validate_budgets,
    configured_ceilings,
)


def test_the_defaults_are_150_nodes_and_450_edges() -> None:
    resolved = resolve_budgets(ceilings=Ceilings())
    assert (DEFAULT_NODE_LIMIT, DEFAULT_EDGE_LIMIT) == (150, 450)
    assert resolved.budgets == Budgets(150, 450)
    assert resolved.as_payload() == {"nodeLimit": 150, "edgeLimit": 450, "defaults": {"nodeLimit": 150, "edgeLimit": 450}}


@pytest.mark.parametrize("node_limit", [149, 150, 151, 499, 500, 501])
def test_the_edge_limit_must_fit_the_whole_tree(node_limit: int) -> None:
    assert validate_budgets(node_limit, node_limit - 1) == Budgets(node_limit, node_limit - 1)
    with pytest.raises(BudgetError) as refused:
        validate_budgets(node_limit, node_limit - 2)
    assert refused.value.field == "edgeLimit"
    assert f"at least nodeLimit - 1 ({node_limit - 1})" in refused.value.message


def test_raised_budgets_are_accepted_without_ceilings() -> None:
    assert resolve_budgets(1000, 3000, ceilings=Ceilings()).budgets == Budgets(1000, 3000)


@pytest.mark.parametrize("bad", [0, -1, 1.5, "150", True, None])
def test_budgets_are_positive_whole_numbers(bad: object) -> None:
    with pytest.raises(BudgetError) as refused:
        validate_budgets(bad, 450)
    assert refused.value.field == "nodeLimit"
    assert "positive whole number" in refused.value.message


def test_a_missing_edge_limit_is_raised_to_fit_and_says_so() -> None:
    resolved = resolve_budgets(node_limit=600, ceilings=Ceilings())
    assert resolved.budgets == Budgets(600, 599)
    assert resolved.adjustments == ("edgeLimit raised to 599 so all 599 tree edges of 600 nodes fit",)
    assert resolve_budgets(node_limit=300, ceilings=Ceilings()).adjustments == ()


def test_ceilings_reject_a_setting_above_them_and_lower_the_defaults() -> None:
    ceilings = Ceilings(node_limit=100, edge_limit=200)
    with pytest.raises(BudgetError) as refused:
        resolve_budgets(150, 200, ceilings=ceilings)
    assert "above this deployment's ceiling of 100 nodes" in refused.value.message
    assert default_budgets(ceilings) == Budgets(100, 200)
    assert default_budgets(Ceilings(edge_limit=50)) == Budgets(51, 50)
    assert resolve_budgets(ceilings=ceilings).as_payload()["ceilings"] == {"nodeLimit": 100, "edgeLimit": 200}


def test_ceilings_come_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANALYSIS_NODE_LIMIT_CEILING", "300")
    monkeypatch.delenv("ANALYSIS_EDGE_LIMIT_CEILING", raising=False)
    assert configured_ceilings() == Ceilings(node_limit=300, edge_limit=None)
    monkeypatch.setenv("ANALYSIS_EDGE_LIMIT_CEILING", "many")
    with pytest.raises(BudgetError):
        configured_ceilings()
